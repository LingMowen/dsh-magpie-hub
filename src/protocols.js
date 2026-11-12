/**
 * protocols.ts —— 协议翻译层：把 DSH 的请求翻成各 SDK 的形状发到上游，
 * 再把上游的 SSE 响应翻回 DSH 的 `StreamChunk`。
 *
 * 覆盖 magpie 契约里的四种 SDK（路径表）：
 *
 * | SDK                        | API               | 路径                                            |
 * | -------------------------- | ----------------- | ----------------------------------------------- |
 * | `@ai-sdk/openai-compatible`| Chat completions  | `/chat/completions`                             |
 * | `@ai-sdk/openai`           | OpenAI Responses  | `/responses`                                    |
 * | `@ai-sdk/anthropic`        | Anthropic Messages| `/messages`                                     |
 * | `@ai-sdk/google`           | Gemini            | `/models/<id>:streamGenerateContent?alt=sse`     |
 *
 * 未知（自定义）SDK 一律按 openai-compatible 处理。
 *
 * 设计约束（逐条对应实测踩过的坑）：
 * 1. URL 拼接：baseURL 为空 → 用该 SDK 的默认端点；只做「去掉尾部斜杠」的拼接，
 *    绝不自己往 base 中间插版本段（baseURL 的形状由 loader 决定）。`/v1` + `/x` 不出 `//`。
 * 2. SSE 解析缓冲到**完整事件**再解析（不逐行猜）：CRLF / 孤立 CR / 空行分隔 /
 *    `data:` 后的空格 / 多行 data / BOM / `[DONE]` / TextDecoder stream 模式（跨 chunk 多字节）。
 * 3. `delta.tool_calls[]` 按 `index` 合并增量 `function.arguments`；`id`/`name` 只在有值时给。
 * 4. 块索引：文本、思考、每个工具调用各占一个 index；`block-start` → `*-delta` → `block-end`。
 * 5. usage：上游给了才发；**拿不到就不发，不编造 0**。
 * 6. 结束一律发一条 `finish`。
 * 7. 非 2xx、以及「2xx 但根本不是 SSE」「一条事件都没解析出来」都**抛错**，绝不静默返回空流。
 * 8. 纯函数：不 import magpie 插件、不读文件、不依赖网络之外的状态。
 * 9. 严格 TS / NodeNext：相对 import 带 `.js` 后缀。
 *
 * 不 import `@deepseek-ai/dsh-llm` 的**类型**：这里只镜像它的字段名（见下），
 * 免得本模块被包版本绑死；运行时形状与 dsh-llm 0.2.1-rc.2 的 `StreamChunk` 一致。
 */
import { SDK_ANTHROPIC, SDK_GOOGLE, SDK_OPENAI, SDK_OPENAI_COMPATIBLE, sdkHeaders, } from './types.js';
// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = {
    [SDK_OPENAI_COMPATIBLE]: 'https://api.openai.com/v1',
    [SDK_OPENAI]: 'https://api.openai.com/v1',
    [SDK_ANTHROPIC]: 'https://api.anthropic.com/v1',
    [SDK_GOOGLE]: 'https://generativelanguage.googleapis.com/v1beta',
};
/** 上游 body 进错误消息时的截断长度（原消息留证，但不把整页 HTML 灌进日志）。 */
const ERROR_BODY_LIMIT = 2000;
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function asArray(value) {
    return Array.isArray(value) ? value : undefined;
}
function textOf(value) {
    return typeof value === 'string' ? value : undefined;
}
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}
function safeStringify(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined)
        return '';
    try {
        const text = JSON.stringify(value);
        return text === undefined ? '' : text;
    }
    catch {
        return '';
    }
}
/** 模型给的参数是原始 JSON 字符串；解析出来喂给 anthropic/gemini 的「对象」槽位。 */
function parseArguments(raw) {
    const trimmed = raw.trim();
    if (trimmed === '')
        return {};
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return {};
    }
}
/** 上游错误：带上状态码、原始报文与一个中性 code，交给上层转成 DSH 的错误。 */
function upstreamError(message, status, body) {
    return Object.assign(new Error(message), {
        code: 'UPSTREAM_ERROR',
        ...(status === undefined ? {} : { status }),
        ...(body === undefined || body === '' ? {} : { body }),
    });
}
/** 上游在流里报错（OpenAI 的 `{error}`、Anthropic 的 `event: error`）。 */
function streamErrorOf(json) {
    const error = asRecord(json['error']);
    if (error === undefined)
        return undefined;
    const message = textOf(error['message']) ?? textOf(error['code']) ?? safeStringify(error);
    const status = numberOf(error['status'])
        ?? (typeof error['code'] === 'number' ? error['code'] : undefined);
    return upstreamError(`upstream stream error: ${message}`, status);
}
// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------
function baseUrlOf(sdk, baseURL) {
    const trimmed = typeof baseURL === 'string' ? baseURL.trim() : '';
    if (trimmed !== '')
        return trimmed;
    return DEFAULT_BASE_URL[sdk] ?? DEFAULT_BASE_URL[SDK_OPENAI_COMPATIBLE];
}
/** 只去掉 base 末尾的斜杠：`…/v1` + `/chat/completions` 得 `…/v1/chat/completions`。 */
function joinUrl(base, path) {
    const left = base.replace(/\/+$/, '');
    const right = path.startsWith('/') ? path : `/${path}`;
    return `${left}${right}`;
}
function geminiUrl(base, model) {
    return joinUrl(base, `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`);
}
function headersOf(sdk, apiKey, explicit) {
    const out = { 'content-type': 'application/json', ...sdkHeaders(sdk, apiKey) };
    if (sdk === SDK_ANTHROPIC && out['anthropic-version'] === undefined)
        out['anthropic-version'] = '2023-06-01';
    // 显式 headers 最后铺：loader 的 headers 与 `chat.headers` 能覆盖鉴权头等默认值。
    return { ...out, ...(explicit ?? {}) };
}
function placeholderOf(type, block) {
    const text = textOf(block['text']);
    if (text !== undefined)
        return text;
    const name = textOf(block['name']);
    return name === undefined ? `[${type === '' ? 'attachment' : type}]` : `[${type}: ${name}]`;
}
function normalizeBlocks(content) {
    if (typeof content === 'string')
        return content === '' ? [] : [{ kind: 'text', text: content }];
    const raw = asArray(content);
    if (raw === undefined)
        return [];
    const blocks = [];
    for (const item of raw) {
        if (typeof item === 'string') {
            if (item !== '')
                blocks.push({ kind: 'text', text: item });
            continue;
        }
        const block = asRecord(item);
        if (block === undefined)
            continue;
        const type = textOf(block['type']) ?? '';
        if (type === 'text' && typeof block['text'] === 'string') {
            blocks.push({ kind: 'text', text: block['text'] });
            continue;
        }
        if ((type === 'reasoning' || type === 'thinking') && typeof block['text'] === 'string') {
            blocks.push({ kind: 'reasoning', text: block['text'] });
            continue;
        }
        if (type === 'tool-call' || type === 'tool_use' || type === 'function_call') {
            blocks.push({
                kind: 'tool-call',
                call: {
                    id: textOf(block['id']) ?? '',
                    name: textOf(block['name']) ?? '',
                    arguments: textOf(block['arguments'])
                        ?? textOf(block['input'])
                        ?? safeStringify(block['arguments'] ?? block['input'] ?? {}),
                },
            });
            continue;
        }
        blocks.push({ kind: 'other', text: placeholderOf(type, block) });
    }
    return blocks;
}
/**
 * 把 DSH 的 `GenerateOptions` 读成中间形状。
 *
 * `options.system`（一次性调用方给的系统提示）会作为一条**打头的 system 消息**插入，
 * 之后各 SDK 自己决定是留在原位（chat）还是提到顶层（anthropic / responses / gemini）。
 */
function normalizeMessages(options) {
    const opts = asRecord(options) ?? {};
    const messages = [];
    const system = textOf(opts['system']);
    if (system !== undefined && system !== '') {
        messages.push({ role: 'system', blocks: [{ kind: 'text', text: system }], text: system, toolCalls: [] });
    }
    for (const item of asArray(opts['messages']) ?? []) {
        const message = asRecord(item);
        if (message === undefined)
            continue;
        const blocks = normalizeBlocks(message['content']);
        const shape = {
            role: textOf(message['role']) ?? 'user',
            blocks,
            text: blocks.filter(b => b.kind === 'text' || b.kind === 'other').map(b => b.text).join('\n'),
            toolCalls: blocks.filter(b => b.kind === 'tool-call').map(b => b.call),
        };
        const toolCallId = textOf(message['toolCallId']);
        if (toolCallId !== undefined)
            shape.toolCallId = toolCallId;
        if (message['isError'] === true)
            shape.isError = true;
        messages.push(shape);
    }
    return messages;
}
/** 顶层 system 槽位（anthropic / responses / gemini 用）：按出现顺序拼接。 */
function systemTextOf(messages) {
    return messages.filter(m => m.role === 'system').map(m => m.text).filter(t => t !== '').join('\n\n');
}
/** developer 消息里的 tool-addition / tool-removal 送不出去，只保留它的可读文本。 */
function developerTextOf(message) {
    return message.text;
}
function callIdOf(call, position) {
    return call.id === '' ? `call_${position}` : call.id;
}
function readTools(options) {
    const opts = asRecord(options) ?? {};
    const raw = asArray(opts['tools']);
    if (raw === undefined)
        return [];
    const tools = [];
    for (const item of raw) {
        const tool = asRecord(item);
        if (tool === undefined)
            continue;
        const name = textOf(tool['name']);
        if (name === undefined || name === '')
            continue;
        tools.push({
            name,
            description: textOf(tool['description']) ?? '',
            parameters: asRecord(tool['parameters']) ?? { type: 'object', properties: {} },
        });
    }
    return tools;
}
function readStops(options) {
    const opts = asRecord(options) ?? {};
    return (asArray(opts['stop']) ?? []).filter((s) => typeof s === 'string' && s !== '');
}
function chatMessages(parts) {
    const out = [];
    for (const message of parts.messages) {
        if (message.role === 'system') {
            if (message.text !== '')
                out.push({ role: 'system', content: message.text });
            continue;
        }
        if (message.role === 'developer') {
            const text = developerTextOf(message);
            if (text !== '')
                out.push({ role: 'system', content: text });
            continue;
        }
        if (message.role === 'assistant') {
            const toolCalls = message.toolCalls;
            out.push({
                role: 'assistant',
                content: message.text === '' ? null : message.text,
                ...(toolCalls.length === 0
                    ? {}
                    : {
                        tool_calls: toolCalls.map((call, at) => ({
                            id: callIdOf(call, at),
                            type: 'function',
                            function: { name: call.name, arguments: call.arguments },
                        })),
                    }),
            });
            continue;
        }
        if (message.role === 'tool') {
            out.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.text });
            continue;
        }
        out.push({ role: 'user', content: message.text });
    }
    return out;
}
function chatRequestBody(parts) {
    const body = {
        model: parts.model,
        messages: chatMessages(parts),
        stream: true,
        // 没有它，多数 OpenAI 兼容上游不会在流末尾给 usage。
        stream_options: { include_usage: true },
    };
    if (parts.tools.length > 0) {
        body['tools'] = parts.tools.map(tool => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        body['tool_choice'] = 'auto';
    }
    if (parts.temperature !== undefined)
        body['temperature'] = parts.temperature;
    if (parts.maxTokens !== undefined)
        body['max_tokens'] = parts.maxTokens;
    if (parts.stops.length > 0)
        body['stop'] = parts.stops;
    if (parts.reasoningEffort !== undefined)
        body['reasoning_effort'] = parts.reasoningEffort;
    return { path: '/chat/completions', body };
}
function responsesInput(parts) {
    const out = [];
    for (const message of parts.messages) {
        if (message.role === 'system' || message.role === 'developer')
            continue; // → instructions
        if (message.role === 'assistant') {
            if (message.text !== '') {
                out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.text }] });
            }
            message.toolCalls.forEach((call, at) => {
                out.push({ type: 'function_call', call_id: callIdOf(call, at), name: call.name, arguments: call.arguments });
            });
            continue;
        }
        if (message.role === 'tool') {
            out.push({ type: 'function_call_output', call_id: message.toolCallId ?? '', output: message.text });
            continue;
        }
        out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: message.text }] });
    }
    return out;
}
function responsesRequestBody(parts) {
    const instructions = [
        systemTextOf(parts.messages),
        ...parts.messages.filter(m => m.role === 'developer').map(developerTextOf),
    ].filter(t => t !== '').join('\n\n');
    const body = {
        model: parts.model,
        input: responsesInput(parts),
        stream: true,
    };
    if (instructions !== '')
        body['instructions'] = instructions;
    if (parts.tools.length > 0) {
        body['tools'] = parts.tools.map(tool => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }));
        body['tool_choice'] = 'auto';
    }
    if (parts.temperature !== undefined)
        body['temperature'] = parts.temperature;
    if (parts.maxTokens !== undefined)
        body['max_output_tokens'] = parts.maxTokens;
    if (parts.stops.length > 0)
        body['stop'] = parts.stops;
    return { path: '/responses', body };
}
function anthropicMessages(messages) {
    const out = [];
    const push = (role, content) => {
        if (content.length === 0)
            return;
        const last = out[out.length - 1];
        // Anthropic 要求 user/assistant 交替；相邻同角色必须合并，tool_result 要留在 user 里。
        if (last !== undefined && last.role === role)
            last.content.push(...content);
        else
            out.push({ role, content });
    };
    for (const message of messages) {
        if (message.role === 'system' || message.role === 'developer')
            continue; // → 顶层 system
        if (message.role === 'assistant') {
            const content = [];
            if (message.text !== '')
                content.push({ type: 'text', text: message.text });
            message.toolCalls.forEach((call, at) => {
                content.push({ type: 'tool_use', id: callIdOf(call, at), name: call.name, input: parseArguments(call.arguments) });
            });
            push('assistant', content);
            continue;
        }
        if (message.role === 'tool') {
            push('user', [{
                    type: 'tool_result',
                    tool_use_id: message.toolCallId ?? '',
                    content: message.text,
                    ...(message.isError === true ? { is_error: true } : {}),
                }]);
            continue;
        }
        push('user', message.text === '' ? [] : [{ type: 'text', text: message.text }]);
    }
    // Anthropic 拒绝以 assistant 开头的会话。
    while (out.length > 0 && out[0]?.role === 'assistant')
        out.shift();
    return out;
}
function anthropicRequestBody(parts) {
    const system = [
        systemTextOf(parts.messages),
        ...parts.messages.filter(m => m.role === 'developer').map(developerTextOf),
    ].filter(t => t !== '').join('\n\n');
    const body = {
        model: parts.model,
        // max_tokens 是 Anthropic 的必填字段；调用方没给就写了默认上限。
        max_tokens: parts.maxTokens ?? 4096,
        messages: anthropicMessages(parts.messages),
        stream: true,
    };
    if (system !== '')
        body['system'] = system;
    if (parts.tools.length > 0) {
        body['tools'] = parts.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
        }));
    }
    if (parts.temperature !== undefined)
        body['temperature'] = parts.temperature;
    if (parts.stops.length > 0)
        body['stop_sequences'] = parts.stops;
    return { path: '/messages', body };
}
function geminiContents(messages) {
    const toolNames = new Map();
    for (const message of messages) {
        for (const call of message.toolCalls)
            if (call.id !== '')
                toolNames.set(call.id, call.name);
    }
    const out = [];
    const push = (role, parts) => {
        if (parts.length === 0)
            return;
        const last = out[out.length - 1];
        if (last !== undefined && last.role === role)
            last.parts.push(...parts);
        else
            out.push({ role, parts });
    };
    for (const message of messages) {
        if (message.role === 'system' || message.role === 'developer')
            continue; // → systemInstruction
        if (message.role === 'assistant') {
            const parts = [];
            if (message.text !== '')
                parts.push({ text: message.text });
            for (const call of message.toolCalls) {
                parts.push({ functionCall: { name: call.name, args: parseArguments(call.arguments) } });
            }
            push('model', parts);
            continue;
        }
        if (message.role === 'tool') {
            const callId = message.toolCallId ?? '';
            push('user', [{
                    functionResponse: {
                        // functionResponse 只认工具名，不认 call id：从历史里的 assistant 块反查。
                        name: toolNames.get(callId) ?? callId,
                        response: { result: message.text },
                    },
                }]);
            continue;
        }
        push('user', message.text === '' ? [] : [{ text: message.text }]);
    }
    return out;
}
function geminiRequestBody(parts) {
    const system = [
        systemTextOf(parts.messages),
        ...parts.messages.filter(m => m.role === 'developer').map(developerTextOf),
    ].filter(t => t !== '').join('\n\n');
    const generationConfig = {};
    if (parts.temperature !== undefined)
        generationConfig['temperature'] = parts.temperature;
    if (parts.maxTokens !== undefined)
        generationConfig['maxOutputTokens'] = parts.maxTokens;
    if (parts.stops.length > 0)
        generationConfig['stopSequences'] = parts.stops;
    const body = { contents: geminiContents(parts.messages) };
    if (system !== '')
        body['systemInstruction'] = { parts: [{ text: system }] };
    if (parts.tools.length > 0) {
        body['tools'] = [{
                functionDeclarations: parts.tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                })),
            }];
    }
    if (Object.keys(generationConfig).length > 0)
        body['generationConfig'] = generationConfig;
    return { path: '', body };
}
// ---------------------------------------------------------------------------
// buildRequest
// ---------------------------------------------------------------------------
/** 按 SDK 形状构造发往上游的请求。baseURL 已由 loader 决定（可能为空 = 用 provider 的 api）。 */
export function buildRequest(input) {
    const sdk = input.sdk;
    const base = baseUrlOf(sdk, input.baseURL);
    const opts = asRecord(input.options) ?? {};
    const parts = {
        model: input.model,
        messages: normalizeMessages(input.options),
        tools: readTools(input.options),
        temperature: numberOf(opts['temperature']),
        maxTokens: numberOf(opts['maxTokens']),
        stops: readStops(input.options),
        reasoningEffort: textOf(opts['reasoningEffort']),
    };
    const headers = headersOf(sdk, input.apiKey, input.headers);
    let url;
    let body;
    if (sdk === SDK_ANTHROPIC) {
        const built = anthropicRequestBody(parts);
        url = joinUrl(base, built.path);
        body = built.body;
    }
    else if (sdk === SDK_GOOGLE) {
        url = geminiUrl(base, parts.model);
        body = geminiRequestBody(parts).body;
    }
    else if (sdk === SDK_OPENAI) {
        const built = responsesRequestBody(parts);
        url = joinUrl(base, built.path);
        body = built.body;
    }
    else {
        // 含未知 SDK：按 chat completions（magpie 的默认形状）。
        const built = chatRequestBody(parts);
        url = joinUrl(base, built.path);
        body = built.body;
    }
    return {
        url,
        init: { method: 'POST', headers, body: JSON.stringify(body) },
    };
}
/**
 * 在缓冲里找**事件分隔**（空行）。
 *
 * 认 `\n\n`、`\r\n\r\n`、`\r\r`、`\n\r\n`；末尾孤立的 `\r` 返回 undefined，
 * 等下一个 chunk —— 否则 CRLF 被切在两个 chunk 之间时会凭空多出一个事件边界。
 */
function findEventEnd(buffer) {
    for (let i = 0; i < buffer.length; i++) {
        const code = buffer.charCodeAt(i);
        if (code === 10) { // \n
            if (buffer.charCodeAt(i + 1) === 10)
                return { at: i, len: 2 };
            if (buffer.charCodeAt(i + 1) === 13 && buffer.charCodeAt(i + 2) === 10)
                return { at: i, len: 3 };
        }
        else if (code === 13) { // \r
            if (buffer.charCodeAt(i + 1) === 10 && buffer.charCodeAt(i + 2) === 13 && buffer.charCodeAt(i + 3) === 10) {
                return { at: i, len: 4 };
            }
            if (buffer.charCodeAt(i + 1) === 13)
                return { at: i, len: 2 };
            if (i === buffer.length - 1)
                return undefined;
        }
    }
    return undefined;
}
function parseSseEvent(raw) {
    if (raw === '')
        return undefined;
    let event;
    const data = [];
    for (const line of raw.split(/\r\n|\n|\r/)) {
        if (line === '' || line.startsWith(':'))
            continue; // 空行 / 注释（心跳）
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' '))
            value = value.slice(1); // `data: x` 的单空格
        if (field === 'data')
            data.push(value);
        else if (field === 'event')
            event = value;
    }
    const joined = data.join('\n'); // 多行 data 用 \n 连接（SSE 规范）
    return event === undefined ? { data: joined } : { event, data: joined };
}
/** 把字节流切成完整事件；跨 chunk 的多字节字符交给 TextDecoder 的 stream 模式。 */
async function* sseEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let drained = false;
    let sawFirst = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done === true)
                break;
            if (value === undefined)
                continue;
            buffer += decoder.decode(value, { stream: true });
            if (!sawFirst) {
                sawFirst = true;
                if (buffer.charCodeAt(0) === 0xfeff)
                    buffer = buffer.slice(1); // BOM
            }
            let end = findEventEnd(buffer);
            while (end !== undefined) {
                const event = parseSseEvent(buffer.slice(0, end.at));
                buffer = buffer.slice(end.at + end.len);
                if (event !== undefined && event.data !== '')
                    yield event;
                end = findEventEnd(buffer);
            }
        }
        buffer += decoder.decode();
        if (buffer.charCodeAt(0) === 0xfeff)
            buffer = buffer.slice(1);
        if (buffer.trim() !== '') {
            const event = parseSseEvent(buffer);
            if (event !== undefined && event.data !== '')
                yield event;
        }
        drained = true;
    }
    finally {
        // 消费方提前退出（例如 [DONE]）时把上游的 body 立刻关掉，别吊着连接。
        if (!drained) {
            try {
                await reader.cancel();
            }
            catch {
                // 已经 errored/closed 就没什么可取消的
            }
        }
        try {
            reader.releaseLock();
        }
        catch {
            // 已释放
        }
    }
}
function usageOf(acc) {
    if (acc.input === undefined && acc.output === undefined && acc.total === undefined
        && acc.cacheRead === undefined && acc.cacheWrite === undefined && acc.reasoning === undefined)
        return undefined;
    return {
        inputTokens: acc.input ?? 0,
        outputTokens: acc.output ?? 0,
        ...(acc.total === undefined ? {} : { totalTokens: acc.total }),
        ...(acc.cacheRead === undefined ? {} : { cacheReadTokens: acc.cacheRead }),
        ...(acc.cacheWrite === undefined ? {} : { cacheWriteTokens: acc.cacheWrite }),
        ...(acc.reasoning === undefined ? {} : { reasoningTokens: acc.reasoning }),
    };
}
/**
 * 把上游的增量翻译成 DSH 的 `block-start` / `*-delta` / `block-end` 序列。
 *
 * key 由各解析器自己定（上游的 index、item id…），同一个 key 复用同一个块；
 * key 复用但类型变了就先关掉旧块（Gemini 的「文本 → 工具 → 文本」会这样）。
 */
class BlockStream {
    nextIndex = 0;
    open = new Map();
    order = [];
    pending = [];
    usage;
    finish;
    /** 取走本步产生的 chunk（顺序即上游顺序）。 */
    drain() {
        if (this.pending.length === 0)
            return [];
        const out = this.pending.slice();
        this.pending.length = 0;
        return out;
    }
    begin(key, kind) {
        const existing = this.open.get(key);
        if (existing !== undefined) {
            if (existing.kind === kind)
                return existing;
            this.close(key);
        }
        const index = this.nextIndex++;
        const block = kind === 'text'
            ? { kind: 'text', index, text: '' }
            : kind === 'reasoning'
                ? { kind: 'reasoning', index, text: '' }
                : { kind: 'tool-call', index, id: '', name: '', args: '', announced: false };
        this.open.set(key, block);
        this.order.push(key);
        this.pending.push({ type: 'block-start', index, blockType: kind });
        return block;
    }
    /** 显式开一个空块（Anthropic 的 content_block_start 只有类型、没有增量）。 */
    beginText(key) {
        this.begin(key, 'text');
    }
    beginReasoning(key) {
        this.begin(key, 'reasoning');
    }
    text(key, delta) {
        if (delta === '')
            return;
        const block = this.begin(key, 'text');
        block.text += delta;
        this.pending.push({ type: 'text-delta', index: block.index, text: delta });
    }
    reasoning(key, delta) {
        if (delta === '')
            return;
        const block = this.begin(key, 'reasoning');
        block.text += delta;
        this.pending.push({ type: 'reasoning-delta', index: block.index, text: delta });
    }
    /**
     * 工具调用增量：`id`/`name` 只在有值时给；首次必须带 `id`（DSH 契约），
     * 上游一次都没给就补一个稳定的合成 id。
     */
    tool(key, delta) {
        const block = this.begin(key, 'tool-call');
        const args = delta.argumentsDelta ?? '';
        if (delta.id !== undefined && delta.id !== '')
            block.id = delta.id;
        if (delta.name !== undefined && delta.name !== '')
            block.name = delta.name;
        block.args += args;
        if (!block.announced) {
            if (block.id === '')
                block.id = `call_${block.index}`;
            this.pending.push({
                type: 'tool-call-delta',
                index: block.index,
                id: block.id,
                ...(block.name === '' ? {} : { name: block.name }),
                argumentsDelta: args,
            });
            block.announced = true;
            return;
        }
        if (args !== '') {
            this.pending.push({ type: 'tool-call-delta', index: block.index, id: block.id, argumentsDelta: args });
        }
    }
    /** 已经收到的工具参数（判断上游是否只发了 `.done` 而没发增量）。 */
    toolArguments(key) {
        const block = this.open.get(key);
        return block !== undefined && block.kind === 'tool-call' ? block.args : '';
    }
    /** 已经收到的文本（判断是否只有 `.done` 给了整段）。 */
    textValue(key) {
        const block = this.open.get(key);
        return block !== undefined && block.kind === 'text' ? block.text : '';
    }
    close(key) {
        const block = this.open.get(key);
        if (block === undefined)
            return;
        this.open.delete(key);
        const at = this.order.indexOf(key);
        if (at !== -1)
            this.order.splice(at, 1);
        const final = block.kind === 'text'
            ? { type: 'text', text: block.text }
            : block.kind === 'reasoning'
                ? { type: 'reasoning', text: block.text }
                : { type: 'tool-call', id: block.id === '' ? `call_${block.index}` : block.id, name: block.name, arguments: block.args };
        this.pending.push({ type: 'block-end', index: block.index, block: final });
    }
    setUsage(usage) {
        if (usage !== undefined)
            this.usage = usage;
    }
    finishWith(reason) {
        this.finish = reason;
    }
    /** 收尾：关掉所有块 → usage（有才发）→ finish。 */
    finalize() {
        for (const key of this.order.slice())
            this.close(key);
        if (this.usage !== undefined)
            this.pending.push({ type: 'usage', usage: this.usage });
        this.pending.push({ type: 'finish', reason: this.finish ?? { kind: 'stop' } });
        return this.drain();
    }
}
function parseJson(data) {
    try {
        return asRecord(JSON.parse(data));
    }
    catch {
        // 坏事件（有的网关插 "data: ping"）：跳过。整条流一个都没解析出来时由外层报错。
        return undefined;
    }
}
/** OpenAI 的 content 可能是字符串，也可能是 parts 数组（部分网关如此）。 */
function textOfContent(value) {
    if (typeof value === 'string')
        return value;
    const parts = asArray(value);
    if (parts === undefined)
        return undefined;
    const texts = [];
    for (const part of parts) {
        if (typeof part === 'string') {
            texts.push(part);
            continue;
        }
        const record = asRecord(part);
        if (record === undefined)
            continue;
        const text = textOf(record['text']);
        if (text !== undefined)
            texts.push(text);
    }
    return texts.length === 0 ? undefined : texts.join('');
}
function readOpenAiUsage(value, acc) {
    const usage = asRecord(value);
    if (usage === undefined)
        return;
    const prompt = numberOf(usage['prompt_tokens']) ?? numberOf(usage['input_tokens']);
    const completion = numberOf(usage['completion_tokens']) ?? numberOf(usage['output_tokens']);
    const details = asRecord(usage['prompt_tokens_details']) ?? asRecord(usage['input_tokens_details']);
    const cached = numberOf(details?.['cached_tokens']);
    const outputDetails = asRecord(usage['completion_tokens_details']) ?? asRecord(usage['output_tokens_details']);
    const reasoning = numberOf(outputDetails?.['reasoning_tokens']);
    if (prompt !== undefined) {
        // DSH 的 inputTokens 只算未缓存输入：把缓存部分减出去（可能为负则夹到 0）。
        acc.cacheRead = cached;
        acc.input = cached === undefined ? prompt : Math.max(0, prompt - cached);
    }
    if (completion !== undefined)
        acc.output = completion;
    const total = numberOf(usage['total_tokens']);
    if (total !== undefined)
        acc.total = total;
    if (reasoning !== undefined)
        acc.reasoning = reasoning;
}
function mapOpenAiFinish(reason, sawToolCall) {
    if (reason === 'length' || reason === 'max_tokens')
        return { kind: 'max-tokens' };
    if (sawToolCall)
        return { kind: 'tool-calls' };
    if (reason === 'tool_calls' || reason === 'function_call')
        return { kind: 'tool-calls' };
    // content_filter 等 DSH 没有对应 kind，按正常收尾处理（正文里能看出来）。
    return { kind: 'stop' };
}
/** `@ai-sdk/openai-compatible` —— Chat completions（本层的主路径）。 */
async function* parseChatCompletions(body, stats) {
    const writer = new BlockStream();
    const acc = {};
    let finish = '';
    let sawToolCall = false;
    for await (const event of sseEvents(body)) {
        const data = event.data.trim();
        if (data === '')
            continue;
        if (data === '[DONE]')
            break;
        const json = parseJson(data);
        if (json === undefined)
            continue;
        stats.events++;
        const error = streamErrorOf(json);
        if (error !== undefined)
            throw error;
        readOpenAiUsage(json['usage'], acc);
        const choice = asRecord((asArray(json['choices']) ?? [])[0]);
        if (choice !== undefined) {
            const delta = asRecord(choice['delta']);
            if (delta !== undefined) {
                const reasoning = textOfContent(delta['reasoning_content']) ?? textOfContent(delta['reasoning']);
                if (reasoning !== undefined)
                    writer.reasoning('reasoning', reasoning);
                const content = textOfContent(delta['content']);
                if (content !== undefined)
                    writer.text('text', content);
                const calls = asArray(delta['tool_calls']);
                if (calls !== undefined) {
                    calls.forEach((item, position) => {
                        const call = asRecord(item);
                        if (call === undefined)
                            return;
                        const at = numberOf(call['index']) ?? position;
                        const fn = asRecord(call['function']) ?? {};
                        const id = textOf(call['id']);
                        const name = textOf(fn['name']);
                        const args = textOf(fn['arguments']);
                        writer.tool(`tool:${at}`, {
                            ...(id === undefined ? {} : { id }),
                            ...(name === undefined ? {} : { name }),
                            argumentsDelta: args ?? '',
                        });
                        sawToolCall = true;
                    });
                }
            }
            const reason = textOf(choice['finish_reason']);
            if (reason !== undefined)
                finish = reason;
        }
        yield* writer.drain();
    }
    writer.setUsage(usageOf(acc));
    writer.finishWith(mapOpenAiFinish(finish, sawToolCall));
    yield* writer.finalize();
}
/** OpenAI Responses 的 item 键：优先 item_id，退回 output_index。 */
function responsesItemKey(json) {
    const itemId = textOf(json['item_id']) ?? textOf(asRecord(json['item'])?.['id']);
    if (itemId !== undefined && itemId !== '')
        return `item:${itemId}`;
    const outputIndex = numberOf(json['output_index']);
    return `out:${outputIndex ?? 0}`;
}
/** `@ai-sdk/openai` —— OpenAI Responses。 */
async function* parseOpenAiResponses(body, stats) {
    const writer = new BlockStream();
    const acc = {};
    let finish;
    let sawToolCall = false;
    for await (const event of sseEvents(body)) {
        const data = event.data.trim();
        if (data === '')
            continue;
        if (data === '[DONE]')
            break;
        const json = parseJson(data);
        if (json === undefined)
            continue;
        stats.events++;
        const type = textOf(json['type']) ?? event.event ?? '';
        const error = streamErrorOf(json);
        if (error !== undefined)
            throw error;
        const item = asRecord(json['item']);
        switch (type) {
            case 'response.output_item.added': {
                if (item?.['type'] !== 'function_call')
                    break;
                const callId = textOf(item['call_id']) ?? textOf(item['id']);
                const name = textOf(item['name']);
                writer.tool(responsesItemKey(json), {
                    ...(callId === undefined ? {} : { id: callId }),
                    ...(name === undefined ? {} : { name }),
                    argumentsDelta: '',
                });
                sawToolCall = true;
                break;
            }
            case 'response.output_text.delta': {
                const delta = textOf(json['delta']);
                if (delta !== undefined)
                    writer.text(responsesItemKey(json), delta);
                break;
            }
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta': {
                const delta = textOf(json['delta']);
                if (delta !== undefined)
                    writer.reasoning(responsesItemKey(json), delta);
                break;
            }
            case 'response.function_call_arguments.delta': {
                const delta = textOf(json['delta']);
                if (delta !== undefined)
                    writer.tool(responsesItemKey(json), { argumentsDelta: delta });
                break;
            }
            case 'response.function_call_arguments.done': {
                // 只发了 done、没发增量的上游：补一次整段参数，避免空参数的工具调用。
                const key = responsesItemKey(json);
                const full = textOf(json['arguments']);
                if (full !== undefined && full !== '' && writer.toolArguments(key) === '') {
                    writer.tool(key, { argumentsDelta: full });
                }
                break;
            }
            case 'response.output_text.done': {
                const key = responsesItemKey(json);
                const full = textOf(json['text']);
                if (full !== undefined && full !== '' && writer.textValue(key) === '') {
                    writer.text(key, full);
                }
                break;
            }
            case 'response.output_item.done': {
                const key = responsesItemKey(json);
                const text = textOf(asRecord((asArray(item?.['content']) ?? [])[0])?.['text']);
                if (item?.['type'] === 'message' && text !== undefined && text !== '' && writer.textValue(key) === '') {
                    writer.text(key, text);
                }
                writer.close(key);
                break;
            }
            case 'response.completed':
            case 'response.incomplete': {
                const response = asRecord(json['response']);
                const usage = usageOf(readResponsesUsage(response));
                writer.setUsage(usage);
                const status = textOf(response?.['status']);
                const incomplete = textOf(asRecord(response?.['incomplete_details'])?.['reason']);
                finish = status === 'incomplete' || incomplete !== undefined
                    ? { kind: 'max-tokens' }
                    : mapOpenAiFinish('', sawToolCall);
                break;
            }
            case 'response.failed': {
                const response = asRecord(json['response']);
                const failure = asRecord(response?.['error']);
                throw upstreamError(`upstream failed the response: ${textOf(failure?.['message']) ?? 'unknown error'}`);
            }
            case 'error': {
                throw upstreamError(`upstream stream error: ${textOf(json['message']) ?? safeStringify(json)}`);
            }
            default:
                break;
        }
        yield* writer.drain();
    }
    writer.finishWith(finish ?? mapOpenAiFinish('', sawToolCall));
    yield* writer.finalize();
}
function readResponsesUsage(response) {
    const acc = {};
    if (response === undefined)
        return acc;
    readOpenAiUsage(response['usage'], acc);
    return acc;
}
function readAnthropicUsage(value, acc) {
    const usage = asRecord(value);
    if (usage === undefined)
        return;
    const input = numberOf(usage['input_tokens']);
    if (input !== undefined)
        acc.input = input; // anthropic 的 input_tokens 已排除缓存
    const output = numberOf(usage['output_tokens']);
    if (output !== undefined)
        acc.output = output;
    const cacheRead = numberOf(usage['cache_read_input_tokens']);
    if (cacheRead !== undefined)
        acc.cacheRead = cacheRead;
    const cacheWrite = numberOf(usage['cache_creation_input_tokens']);
    if (cacheWrite !== undefined)
        acc.cacheWrite = cacheWrite;
}
function mapAnthropicFinish(reason, sawToolCall) {
    if (reason === 'max_tokens' || reason === 'model_context_window_exceeded')
        return { kind: 'max-tokens' };
    if (sawToolCall || reason === 'tool_use')
        return { kind: 'tool-calls' };
    return { kind: 'stop' };
}
/** `@ai-sdk/anthropic` —— Messages。 */
async function* parseAnthropic(body, stats) {
    const writer = new BlockStream();
    const acc = {};
    const keys = new Map();
    let finish = '';
    let sawToolCall = false;
    for await (const event of sseEvents(body)) {
        const data = event.data.trim();
        if (data === '')
            continue;
        if (data === '[DONE]')
            break;
        const json = parseJson(data);
        if (json === undefined)
            continue;
        stats.events++;
        const type = textOf(json['type']) ?? event.event ?? '';
        if (type === 'error') {
            throw upstreamError(`upstream stream error: ${textOf(asRecord(json['error'])?.['message']) ?? safeStringify(json)}`);
        }
        switch (type) {
            case 'message_start': {
                readAnthropicUsage(asRecord(asRecord(json['message'])?.['usage']), acc);
                break;
            }
            case 'content_block_start': {
                const at = numberOf(json['index']) ?? keys.size;
                const block = asRecord(json['content_block']);
                const blockType = textOf(block?.['type']) ?? '';
                const key = `block:${at}`;
                keys.set(at, key);
                if (blockType === 'tool_use' || blockType === 'server_tool_use') {
                    const id = textOf(block?.['id']);
                    const name = textOf(block?.['name']);
                    writer.tool(key, {
                        ...(id === undefined ? {} : { id }),
                        ...(name === undefined ? {} : { name }),
                        argumentsDelta: '',
                    });
                    sawToolCall = true;
                }
                else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
                    writer.beginReasoning(key);
                }
                else {
                    writer.beginText(key);
                }
                break;
            }
            case 'content_block_delta': {
                const at = numberOf(json['index']) ?? 0;
                const key = keys.get(at) ?? `block:${at}`;
                const delta = asRecord(json['delta']);
                const deltaType = textOf(delta?.['type']) ?? '';
                if (deltaType === 'text_delta') {
                    const text = textOf(delta?.['text']);
                    if (text !== undefined)
                        writer.text(key, text);
                }
                else if (deltaType === 'thinking_delta') {
                    const text = textOf(delta?.['thinking']);
                    if (text !== undefined)
                        writer.reasoning(key, text);
                }
                else if (deltaType === 'input_json_delta') {
                    const partial = textOf(delta?.['partial_json']);
                    if (partial !== undefined)
                        writer.tool(key, { argumentsDelta: partial });
                }
                // signature_delta 等不参与 DSH 的形状，忽略。
                break;
            }
            case 'content_block_stop': {
                const at = numberOf(json['index']) ?? 0;
                writer.close(keys.get(at) ?? `block:${at}`);
                keys.delete(at);
                break;
            }
            case 'message_delta': {
                readAnthropicUsage(json['usage'], acc);
                const reason = textOf(asRecord(json['delta'])?.['stop_reason']);
                if (reason !== undefined)
                    finish = reason;
                break;
            }
            default:
                break;
        }
        yield* writer.drain();
    }
    writer.setUsage(usageOf(acc));
    writer.finishWith(mapAnthropicFinish(finish, sawToolCall));
    yield* writer.finalize();
}
function readGeminiUsage(value, acc) {
    const usage = asRecord(value);
    if (usage === undefined)
        return;
    const prompt = numberOf(usage['promptTokenCount']);
    const cached = numberOf(usage['cachedContentTokenCount']);
    if (prompt !== undefined) {
        acc.cacheRead = cached;
        acc.input = cached === undefined ? prompt : Math.max(0, prompt - cached);
    }
    const output = numberOf(usage['candidatesTokenCount']);
    if (output !== undefined)
        acc.output = output;
    const total = numberOf(usage['totalTokenCount']);
    if (total !== undefined)
        acc.total = total;
    const reasoning = numberOf(usage['thoughtsTokenCount']);
    if (reasoning !== undefined)
        acc.reasoning = reasoning;
}
function mapGeminiFinish(reason, sawToolCall) {
    if (reason === 'MAX_TOKENS')
        return { kind: 'max-tokens' };
    if (sawToolCall)
        return { kind: 'tool-calls' };
    return { kind: 'stop' };
}
/** `@ai-sdk/google` —— Gemini streamGenerateContent(alt=sse)。 */
async function* parseGemini(body, stats) {
    const writer = new BlockStream();
    const acc = {};
    let finish = '';
    let sawToolCall = false;
    let toolSeq = 0;
    for await (const event of sseEvents(body)) {
        const data = event.data.trim();
        if (data === '')
            continue;
        const json = parseJson(data);
        if (json === undefined)
            continue;
        stats.events++;
        const error = streamErrorOf(json);
        if (error !== undefined)
            throw error;
        const blockReason = textOf(asRecord(json['promptFeedback'])?.['blockReason']);
        if (blockReason !== undefined)
            throw upstreamError(`upstream blocked the prompt: ${blockReason}`);
        readGeminiUsage(json['usageMetadata'], acc);
        for (const raw of asArray(json['candidates']) ?? []) {
            const candidate = asRecord(raw);
            if (candidate === undefined)
                continue;
            for (const rawPart of asArray(asRecord(candidate['content'])?.['parts']) ?? []) {
                const part = asRecord(rawPart);
                if (part === undefined)
                    continue;
                const text = textOf(part['text']);
                if (text !== undefined)
                    writer.text('text', text);
                const call = asRecord(part['functionCall']);
                if (call !== undefined) {
                    // Gemini 没有工具调用 id，也没有增量：一次给全 ⇒ 一个调用一个块，立刻收尾。
                    const seq = toolSeq++;
                    const key = `tool:${seq}`;
                    writer.close('text');
                    writer.tool(key, {
                        id: `call_${seq}`,
                        name: textOf(call['name']) ?? '',
                        argumentsDelta: call['args'] === undefined ? '{}' : safeStringify(call['args']),
                    });
                    writer.close(key);
                    sawToolCall = true;
                }
            }
            const reason = textOf(candidate['finishReason']);
            if (reason !== undefined)
                finish = reason;
        }
        yield* writer.drain();
    }
    writer.setUsage(usageOf(acc));
    writer.finishWith(mapGeminiFinish(finish, sawToolCall));
    yield* writer.finalize();
}
// ---------------------------------------------------------------------------
// parseResponse
// ---------------------------------------------------------------------------
/** 非 2xx：读出 body（截断）连状态码一起抛，绝不静默返回空流。 */
async function upstreamErrorOf(response) {
    let body = '';
    try {
        body = await response.text();
    }
    catch {
        // body 读不出来就只报状态码
    }
    const snippet = truncate(body, ERROR_BODY_LIMIT);
    const detail = snippet === '' ? '' : `: ${snippet}`;
    const message = `upstream responded ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}${detail}`;
    return upstreamError(message, response.status, snippet);
}
/** 2xx 但不是 SSE（典型是风控/网关回的 text/html、或 JSON 错误体）。 */
function nonStreamContentType(response) {
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (type === '' || type.includes('text/event-stream'))
        return undefined;
    return type.includes('json') || type.includes('html') ? type : undefined;
}
/** 把上游 Response 解析成 DSH 的 StreamChunk 流。 */
export async function* parseResponse(input) {
    const response = input.response;
    if (response.ok !== true)
        throw await upstreamErrorOf(response);
    const wrongType = nonStreamContentType(response);
    if (wrongType !== undefined) {
        let body = '';
        try {
            body = await response.text();
        }
        catch {
            // 读不出来就只报类型
        }
        const snippet = truncate(body, ERROR_BODY_LIMIT);
        throw upstreamError(`upstream did not stream (content-type: ${wrongType})${snippet === '' ? '' : `: ${snippet}`}`, response.status, snippet);
    }
    const body = response.body;
    if (body === null)
        throw upstreamError('upstream returned an empty body', response.status);
    const stats = { events: 0 };
    const stream = input.sdk === SDK_ANTHROPIC
        ? parseAnthropic(body, stats)
        : input.sdk === SDK_GOOGLE
            ? parseGemini(body, stats)
            : input.sdk === SDK_OPENAI
                ? parseOpenAiResponses(body, stats)
                : parseChatCompletions(body, stats);
    for await (const chunk of stream) {
        yield chunk;
    }
    // 一条事件都没解析出来（内容类型是 event-stream 但 body 是垃圾）：报错而不是静默空流。
    if (stats.events === 0) {
        const type = response.headers.get('content-type') ?? 'unknown';
        throw upstreamError(`upstream returned an empty event stream (status ${response.status}, content-type: ${type})`, response.status);
    }
}
//# sourceMappingURL=protocols.js.map