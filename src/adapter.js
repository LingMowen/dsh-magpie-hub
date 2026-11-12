/**
 * 把 magpie provider 插件接进 DSH 的 LLM 运行时。
 *
 * 一个 provider（或一个插件声明的多个）对应**本适配器的一个实例**，由
 * `ctx.llm.registerAdapter([ids], adapter)` 注册。`stream()` 是必须实现的方法，
 * 其余（providerInfo / listModels / resolveModel / prepareCall）按需覆盖。
 *
 * 请求路径（契约的执行顺序）：
 * ```
 * stream(opts)
 *   → host.ensureFresh(provider, key)        // 临期先续（auth.refresh）
 *   → host.loaderOf(provider, key)           // auth.loader：baseURL / apiKey / headers / fetch
 *   → host.chatHeaders({sessionID, model})   // chat.headers 链式
 *   → protocols.buildRequest(...)            // 按 SDK 形状构造
 *   → fetchImpl(...)                         // loader.fetch 优先，其次全局 fetch
 *   → protocols.parseResponse(...)           // 转成 DSH 的 StreamChunk
 * ```
 *
 * 账号选择：一个 provider 可能登录了多个账号。默认规则是**按顺序取第一个可用**
 * 的（magpie 的智能路由要读额度打分，本宿主不做那么重：只在失败时换下一个 ——
 * 限流/5xx 自动换号是契约里明确交给宿主的职责）。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { CATALOG_TIMEOUT_MS, withDeadline } from './deadline.js';
import { buildRequest, parseResponse } from './protocols.js';
import { whoOf } from './types.js';
const CATALOG_TTL_MS = 60_000;
/**
 * 通用的 magpie → DSH 适配器。
 *
 * ⚠️ 继承真实基类：`ctx.llm.registerAdapter` 要求 `LlmAdapter` 实例（多态检查），
 * 只满足结构不满足 `instanceof` 会被拒。
 */
export class MagpieAdapter extends LlmAdapter {
    deps;
    catalogs = new Map();
    /** 正在后台刷新的平台（同一平台不并发刷新，省手机端流量）。 */
    catalogWarm = new Map();
    /** 后台刷新的全局串行队列（见 `warmCatalog` 注释：并发会占满手机端的请求池）。 */
    catalogQueue = Promise.resolve();
    constructor(deps) {
        super();
        this.deps = deps;
    }
    /** 本适配器服务的 provider（DSH 的目录会按它逐个问 providerInfo）。 */
    get providers() {
        return this.deps.providers;
    }
    config(provider) {
        const cfg = this.deps.host.providerConfig(provider);
        return {
            name: cfg?.name ?? provider,
            npm: cfg?.npm ?? '@ai-sdk/openai-compatible',
            api: cfg?.api ?? '',
        };
    }
    /** DSH 的 provider 选择器信息：只有 id 与显示名两个字段。 */
    providerInfo(provider) {
        return { id: provider, name: this.config(provider).name };
    }
    /**
     * 选一个可用账号。
     *
     * 顺序由**路由策略**决定（`policy.routeStrategy`）：
     * - `first`（默认）：按存储顺序，谁先登录先用谁；
     * - `fastest`：剩余额度最多的优先（`used` 是百分比，越小越富裕）——
     *   不知道额度的账号排在后面，但**仍然可用**，不能因为没数据就不用它；
     * - `cheapest`：按当前模型单价从低到高（拿不到价就退回存储顺序）。
     *
     * ⚠ 策略只影响**顺序**，不影响可用性：最终还是要有一个能用的账号；
     * 全不可用才抛（让上层报「未登录」）。
     */
    async pickAccount(provider, exclude, modelId) {
        const keys = await this.deps.host.accountKeys(provider);
        const strategy = (await this.deps.policy?.strategy?.()) ?? 'first';
        const ordered = strategy === 'first' ? keys : this.orderKeys(provider, keys, strategy, modelId);
        // 账号级「只能跑哪些模型」：不匹配这个模型就跳过他，不要发出去被上游 403。
        // 一个都不匹配时仍然走原来的流程（下面会抛「未登录」）——那是配置错误，
        // 让用户看到「没有可用账号」，比静默换一个不符合偏好的账号更诚实。
        let skippedByModel = false;
        for (const key of ordered) {
            if (exclude?.has(key) === true)
                continue;
            if (modelId !== undefined && typeof modelId === 'string') {
                const allowed = await this.deps.policy?.modelsOfAccount?.(key);
                if (Array.isArray(allowed) && !allowed.includes(modelId)) {
                    skippedByModel = true;
                    continue;
                }
            }
            const stored = await this.deps.host.ensureFresh(provider, key);
            if (stored !== undefined)
                return { key, auth: stored };
        }
        if (skippedByModel) {
            throw new LlmError(`${this.config(provider).name} 没有账号被允许使用模型 ${String(modelId)}（在账号设置里放开它）`, 'INVALID_CREDENTIAL');
        }
        throw new LlmError(`${this.config(provider).name} 还没有登录（magpie 插件未添加账号）`, 'INVALID_CREDENTIAL');
    }
    /** 按策略重排账号 key（不改变可用性，只改尝试顺序）。 */
    orderKeys(provider, keys, strategy, modelId) {
        if (strategy === 'fastest') {
            const usedOf = this.deps.quotaOf;
            if (typeof usedOf !== 'function')
                return keys;
            // used 越小越富裕；没有数据的（undefined）排后面，但不丢弃
            return keys
                .map((key) => ({ key, used: usedOf(provider, key) }))
                .sort((a, b) => {
                if (a.used === b.used)
                    return 0;
                if (a.used === undefined)
                    return 1;
                if (b.used === undefined)
                    return -1;
                return a.used - b.used;
            })
                .map((x) => x.key);
        }
        if (strategy === 'cheapest') {
            const cfg = this.deps.host.providerConfig(provider);
            const entry = cfg?.models?.[modelId ?? ''];
            const cost = entry?.cost;
            // 同一供应商的账号走同一个模型、单价相同 ⇒ 按价排序没有区分度，
            // 退回存储顺序（诚实：不要假装排过）。
            void cost;
            return keys;
        }
        return keys;
    }
    /**
     * 模型目录。
     *
     * 读路径必须**永不阻塞**：App 的模型选择器是串行读全部平台的，只要有一个
     * 平台不返回，整页就停在「更新中」且不可点（只读态，见
     * `dsh-Go/app/lib/state/models_state.dart:59-67`）。所以顺序是：
     *
     * 1. 有缓存 → 直接给缓存，过期了就在后台刷（stale-while-revalidate）；
     * 2. 没缓存但有静态表（插件 `config()` 声明的模型）→ 立刻给静态表，后台刷；
     * 3. 没缓存也没静态表 → 才等一次真目录，且最多 `CATALOG_TIMEOUT_MS`。
     *
     * 静态表通常已经够选（wps-lingxi 报 11 个），真目录只是补充上下文档位之类，
     * 晚一两秒到不亏。
     */
    async catalogOf(provider) {
        const hit = this.catalogs.get(provider);
        if (hit !== undefined) {
            if (Date.now() - hit.at >= CATALOG_TTL_MS)
                this.warmCatalog(provider);
            return hit.models;
        }
        const keys = await this.deps.host.accountKeys(provider);
        const base = this.deps.host.providerConfig(provider)?.models ?? {};
        if (keys.length === 0) {
            this.catalogs.set(provider, { at: Date.now(), models: base });
            return base;
        }
        if (Object.keys(base).length > 0) {
            // ⚠ 时间戳必须给真实值：`at: 0` 会让每次读都被判为过期，于是又重新排一次
            // 后台刷新。手机端串行队列里堆十几个任务后，选择器就会长时间停在「更新中」。
            // 后台刷到真目录时 `refreshCatalog` 会把 `at` 覆盖成完成时刻。
            this.catalogs.set(provider, { at: Date.now(), models: base });
            this.warmCatalog(provider);
            return base;
        }
        // 连静态表都没有：**也不等**。等一次真目录只快几百毫秒，却可能因为弱网把整页
        // 拖成「更新中」（App 是串行问全部平台，一个慢就全慢）。空目录先返回，后台刷完
        // 再进缓存 —— 用户重开一次选择器即可看到这个平台。
        this.catalogs.set(provider, { at: Date.now(), models: {} });
        this.warmCatalog(provider);
        return {};
    }
    /**
     * 后台把某个平台的目录刷进缓存。
     *
     * ⚠ **必须全局串行**：手机端 `UV_THREADPOOL_SIZE=2`，21 个平台同时发 HTTP 会把
     * 池占满，反而让前台 `listModels` 排队 —— 表现是模型选择器停在「更新中」十几秒
     * 且不可点（`readOnly`）。所以排成一条队列，一次只刷一个平台。
     */
    warmCatalog(provider) {
        if (this.catalogWarm.has(provider))
            return;
        const task = this.catalogQueue.then(() => this.refreshCatalog(provider));
        this.catalogQueue = task.catch(() => { });
        this.catalogWarm.set(provider, task);
    }
    async refreshCatalog(provider) {
        try {
            const keys = await this.deps.host.accountKeys(provider);
            if (keys.length === 0)
                return;
            const base = this.deps.host.providerConfig(provider)?.models ?? {};
            const models = await withDeadline(this.deps.host.modelsOf(provider, keys[0]), CATALOG_TIMEOUT_MS, base);
            // 空对象不覆盖：宁可留静态表，也不要让选择器变空
            this.catalogs.set(provider, {
                at: Object.keys(models).length === 0 ? 0 : Date.now(),
                models: Object.keys(models).length === 0 ? base : models,
            });
        }
        catch {
            // 刷新失败保留旧缓存；下一次读再试
        }
        finally {
            this.catalogWarm.delete(provider);
        }
    }
    /** 面板用：把目录转成一行行的显示形状（**含**被禁用的，面板要能开关）。 */
    async catalogRows(provider) {
        const models = await this.catalogOf(provider);
        const policy = await this.deps.policy?.get?.();
        const disabled = policy?.disabledModels ?? new Set();
        return Object.entries(models).map(([id, m]) => ({
            id,
            name: typeof m.name === 'string' && m.name !== '' ? m.name : id,
            ...(typeof m.limit?.context === 'number' ? { context: m.limit.context } : {}),
            ...(m.free === true ? { free: true } : {}),
            // 面板要显示「这个被关了」，所以这里带出来；`listModels` 里才过滤。
            disabled: disabled.has(`${provider}/${id}`),
        }));
    }
    /**
     * 模型选择器看到的列表：**被禁用的不出现**。
     *
     * ⚠ 过滤只发生在这一层（列表），`resolveModel` 与 `stream` 不过滤：
     * 用户之前选中的模型可能刚被关掉，这时应该照常能跑完这次请求，
     * 而不是中途失效；下次从列表里选就选不到了。
     */
    async listModels(provider) {
        const models = await this.catalogOf(provider);
        const policy = await this.deps.policy?.get?.();
        const disabled = policy?.disabledModels ?? new Set();
        return Object.entries(models)
            .filter(([id]) => !disabled.has(`${provider}/${id}`))
            .map(([id, m]) => this.modelInfo(provider, id, m));
    }
    async resolveModel(provider, model) {
        const models = await this.catalogOf(provider);
        const entry = models[model];
        if (entry === undefined) {
            // 未知 id：给一个只有 id 的最小面（DSH 允许未列出的 id）。
            return { provider, id: model, name: model };
        }
        return this.modelInfo(provider, model, entry);
    }
    modelInfo(provider, id, m) {
        const context = m.limit?.context;
        const output = m.limit?.output;
        return {
            provider,
            id,
            name: typeof m.name === 'string' && m.name !== '' ? m.name : id,
            // ⚠️ LlmModelContext 是 `{ contextWindow }` 对象，不是裸数字
            ...(typeof context === 'number' && context > 0 ? { context: { contextWindow: context } } : {}),
            ...(typeof output === 'number' && output > 0 ? { defaultMaxTokens: output } : {}),
        };
    }
    /** 立刻失效（面板点「刷新目录」时调）。 */
    invalidateCatalog(provider) {
        if (provider === undefined)
            this.catalogs.clear();
        else
            this.catalogs.delete(provider);
    }
    /**
     * 判断这次调用属于哪个平台。
     *
     * 顺序：① 模型名自带 `<provider>/` 前缀且这个平台确实存在 → 直接用；
     * ② 否则在**已缓存**的目录里找哪个平台声明了这个模型（只读缓存，不触发
     * 后台预热，否则一次调用会把全部平台排进队列）；③ 都没有才退回第一个平台。
     */
    async providerOf(prefix, modelId) {
        const all = this.deps.providers ?? [];
        if (prefix !== '' && all.includes(prefix))
            return prefix;
        for (const p of all) {
            const hit = this.catalogs.get(p);
            if (hit !== undefined && Object.prototype.hasOwnProperty.call(hit.models, modelId))
                return p;
        }
        return all[0] ?? prefix;
    }
    async *stream(options) {
        const model = String(options.model);
        // 模型 id 可能是 `<provider>/<model>`，也可能是裸模型名。裸名要**按目录反查**
        // 平台：只取 `providers[0]` 会把请求发给错的平台（它的 loader 不匹配，
        // cookie 也对不上，表现成 401）。
        const slash = model.indexOf('/');
        const prefix = slash > 0 ? model.slice(0, slash) : '';
        const modelId = slash > 0 ? model.slice(slash + 1) : model;
        const provider = await this.providerOf(prefix, modelId);
        const started = Date.now();
        let accountKey;
        // 累计这次调用的用量：`usage` 帧由协议层在流里发，我们边转发边记
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let sawUsage = false;
        try {
            const picked = await this.pickAccount(provider, undefined, modelId);
            accountKey = picked.key;
            const loader = await this.deps.host.loaderOf(provider, picked.key);
            const cfg = this.config(provider);
            const baseURL = typeof loader.baseURL === 'string' && loader.baseURL !== '' ? loader.baseURL : cfg.api;
            const sdk = cfg.npm;
            const headers = { ...(loader.headers ?? {}) };
            // ⚠ 字段名是 `sessionId`（小写 d）。早先按 `sessionID` 读，一直是
            // undefined，于是回合脚注只能全记在一个桶里、按会话分不开。
            const sessionID = options.sessionId ?? options.sessionID;
            const chat = await this.deps.host.chatHeaders({
                ...(typeof sessionID === 'string' ? { sessionID } : {}),
                model: { providerID: provider, id: modelId },
            });
            Object.assign(headers, chat);
            const request = buildRequest({
                sdk,
                baseURL,
                model: modelId,
                ...(typeof loader.apiKey === 'string' ? { apiKey: loader.apiKey } : {}),
                headers,
                options,
            });
            const doFetch = loader.fetch ?? this.deps.fetchImpl ?? fetch;
            const response = await doFetch(request.url, {
                ...request.init,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            for await (const chunk of parseResponse({ sdk, response, model: modelId })) {
                // 协议层的 usage 帧形如 `{ type: 'usage', usage: {...} }`；先收窄再读，
                // 不要直接把联合类型断言成带 usage 的形状（TS 会拒绝不重叠的断言）。
                const frame = chunk;
                const raw = frame.type === 'usage' ? frame.usage : undefined;
                if (raw !== null && typeof raw === 'object') {
                    sawUsage = true;
                    const usage = raw;
                    const n = (k) => (typeof usage[k] === 'number' ? usage[k] : 0);
                    inputTokens += n('inputTokens');
                    outputTokens += n('outputTokens');
                    cacheReadTokens += n('cacheReadTokens');
                    cacheWriteTokens += n('cacheWriteTokens');
                }
                yield chunk;
            }
            const tokens = sawUsage
                ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
                : undefined;
            // 费用按模型条目里的 cost（每百万 token 的美元价）算；没有价格就不给数字，
            // 由面板计入「没有价格」——**不拿 0 冒充免费**。
            const cost = sawUsage
                ? costOf(this.deps.host.providerConfig(provider)?.models?.[modelId], {
                    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                })
                : undefined;
            this.deps.record?.({
                provider, model: modelId, status: 'ok', ms: Date.now() - started, accountKey,
                // 会话 id 给「每回合脚注」用：脚注按回合序号取数，而我们拿不到
                // DSH 的 turnId，只能用「这个会话里的第几次调用」近似（见 index.js）。
                ...(typeof sessionID === 'string' ? { sessionID } : {}),
                ...(tokens === undefined ? {} : { tokens }),
                ...(cost === undefined ? {} : { cost }),
            });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.deps.record?.({
                provider, model: modelId, status: 'error', ms: Date.now() - started,
                error: message, ...(accountKey === undefined ? {} : { accountKey }),
                ...(typeof sessionID === 'string' ? { sessionID } : {}),
            });
            throw e instanceof LlmError ? e : new LlmError(message, 'UNKNOWN', { cause: e });
        }
    }
}
/**
 * 按模型条目的 `cost` 估一次调用的美元费用。
 *
 * `cost` 的四个字段是**每百万 token 的单价**（magpie 契约）。四项都为 0 或缺失
 * 时返回 `undefined` —— 表示「没有价格」，不是免费。
 */
export function costOf(entry, usage) {
    const cost = entry?.cost;
    if (cost === undefined)
        return undefined;
    const rate = {
        input: typeof cost.input === 'number' ? cost.input : 0,
        output: typeof cost.output === 'number' ? cost.output : 0,
        read: typeof cost.cache_read === 'number' ? cost.cache_read : 0,
        write: typeof cost.cache_write === 'number' ? cost.cache_write : 0,
    };
    if (rate.input === 0 && rate.output === 0 && rate.read === 0 && rate.write === 0)
        return undefined;
    return (usage.inputTokens * rate.input
        + usage.outputTokens * rate.output
        + usage.cacheReadTokens * rate.read
        + usage.cacheWriteTokens * rate.write) / 1_000_000;
}
export { whoOf };
//# sourceMappingURL=adapter.js.map