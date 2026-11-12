/**
 * 把 magpie 自己的 Web UI **原样**托管在 DSH 里。
 *
 * 为什么是「原样」而不是重写：用户要的是「UI 直接搬」。magpie 的界面是
 * `internal/gui/assets` 下的静态资源（12 MB / 265 文件，app.js 两万四千行），
 * 重写等于从头再做一遍；而 DSH 的 webServer 支持 `kind: 'prefix'` 路由，
 * 可以直接把整份资源挂在 `/magpie-hub/` 下。
 *
 * 两层：
 *   `/magpie-hub/…`      静态资源（index.html、app.js、app.css、icons…）
 *   `/magpie-hub/api/…`  magpie UI 调的后端接口 ← 由 `handlers` 表分派
 *
 * UI 里的 `/api/` 已在搬运时改写成 `/magpie-hub/api/`（app.js / ctxtext.js /
 * omarchy.js 三处），所以它不需要知道自己在谁下面跑。
 *
 * ⚠ 后端接口**不是**全都要实现：删掉页面后，对应接口就不会被调用。
 * 未实现的统一回 501 并带上原因，便于从浏览器控制台一眼看出还缺哪个。
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** UI 资源目录（`<包>/ui`）。 */
const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
/** 挂载前缀。 */
export const MOUNT = '/magpie-hub';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};

/**
 * 注册 UI 托管。
 *
 * @param ctx DSH 上下文（需要 `inject` 与 `effect`）
 * @param deps `{ handlers, log }`
 *   handlers: `{ '<api 路径>': (req, body) => any }`，路径不含 `/magpie-hub/api/`
 * @returns 注销函数（没有 webServer 时返回 undefined）
 */
export function registerUi(ctx, deps) {
    const withInject = ctx;
    if (typeof withInject.inject !== 'function') {
        deps.log?.('[magpie-hub] ctx.inject 不可用，UI 托管未注册');
        return undefined;
    }
    let stop;
    withInject.inject(['webServer'], (scoped) => {
        stop = mount(scoped, deps);
        // cordis 把 inject 回调的返回值当该作用域的清理函数
        return () => { stop?.(); stop = undefined; };
    });
    return () => { stop?.(); stop = undefined; };
}

/** 在持有 webServer 的作用域里挂前缀路由（拆出来便于单测）。 */
export function mount(scoped, deps) {
    const web = scoped?.webServer;
    if (web === undefined || typeof web.register !== 'function') {
        deps.log?.('[magpie-hub] 作用域里没有 webServer，UI 托管未注册');
        return undefined;
    }
    const route = {
        kind: 'prefix',
        path: MOUNT,
        // ⚠ 要**返回** promise：`void handle(...)` 会立刻返回，调用方（含测试）
        // 拿不到「已经写完响应」的时刻，断言就会跑在写入之前。
        handler: (req, res) => handle(req, res, deps),
    };
    console.error('[magpie-hub][UI_DIR]', UI_DIR);
    const disposers = [];
    const add = (r) => {
        try {
            disposers.push(web.register(r));
        }
        catch (e) {
            // 重复路径会抛：宿主自己对 `/magpie-hub` 也许已经有路由，忽略即可
            deps.log?.(`[magpie-hub] 路由 ${r.kind} ${r.path} 未注册：${e instanceof Error ? e.message : String(e)}`);
        }
    };
    add(route);
    // ⚠ 裸根路径（`/magpie-hub` 与 `/magpie-hub/`）实测**不会**落到 prefix 路由上：
    // 同一实例里 `/magpie-hub/app.css` 返 200、`/magpie-hub/` 返 404，说明宿主对
    // 「只有前缀本身」的请求另有处理。所以额外注册两条 exact 路由兜住它。
    for (const p of [MOUNT, `${MOUNT}/`]) {
        add({ kind: 'exact', path: p, handler: (req, res) => handle(req, res, deps) });
    }
    deps.log?.(`[magpie-hub] UI 已挂载：${MOUNT}/ › ${UI_DIR}`);
    return () => { for (const d of disposers) d?.(); };
}

/** 请求分发：API 走 handlers，其余当静态文件。 */
async function handle(req, res, deps) {
    try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        // ⚠ 前缀可能已经被宿主剥掉（真实 DSH 里实测过：`/magpie-hub/app.js`
        // 进来的 `req.url` 只剩 `/app.js`）。所以两种形式都要认，否则只有
        // 根路径能出、其余全 404（我曾因此以为托管没生效）。
        const path = pathname.startsWith(MOUNT) ? pathname : `${MOUNT}${pathname === '/' ? '/' : pathname}`;
        if (path === MOUNT || path === `${MOUNT}/`) {
            return serveFile(res, join(UI_DIR, 'index.html'));
        }
        if (path.startsWith(`${MOUNT}/api/`)) {
            return serveApi(req, res, deps, path.slice(`${MOUNT}/api/`.length));
        }
        // 静态：把前缀剥掉，剩下的当相对路径（防目录穿越）
        const rel = decodeURIComponent(path.slice(MOUNT.length + 1));
        // `boot.js` **不是静态文件**：magpie 由 `/boot.js` 这条 Go 路由动态生成，
        // 内容是 `window.bootPrefs`（语言/主题/字号/是否 web/版本/被关掉的功能）。
        // 页面里的 theme.js、layout.js、app.js 开头都要读它，缺了整页白屏
        // （实测就是左上角一个小 404）。这里给一份等价的。
        if (rel === 'boot.js')
            return serveBoot(res, deps);
        const safe = normalize(rel).replace(/^([.][.][\\/])+/, '');
        if (safe.includes(`..${sep}`) || safe.startsWith('..')) {
            return send(res, 400, 'text/plain; charset=utf-8', 'bad path');
        }
        return serveFile(res, join(UI_DIR, safe));
    }
    catch (e) {
        deps.log?.(`[magpie-hub] UI 请求失败：${e instanceof Error ? e.message : String(e)}`);
        return send(res, 500, 'text/plain; charset=utf-8', 'internal error');
    }
}

/**
 * 生成 `boot.js`：页面在**首次绘制前**要读的偏好。
 *
 * 字段与 magpie 的 `/boot.js`（internal/gui/api.go:1015）对齐：
 * `lang`/`theme`/`textSize`/`web`/`version`。`web: true` 表示「这是浏览器里的一份」，
 * 页面据此隐藏桌面专属功能；`featuresOff` 列被关掉的内置插件。
 */
async function serveBoot(res, deps) {
    const settings = await deps.magpieSettings?.() ?? {};
    const prefs = {
        lang: typeof settings.lang === 'string' ? settings.lang : 'system',
        theme: typeof settings.theme === 'string' ? settings.theme : 'system',
        textSize: typeof settings.textSize === 'number' ? settings.textSize : 100,
        // 我们永远是「浏览器里的一份」（DSH 的 Web 界面里内嵌）
        web: true,
        version: deps.version ?? '0.2.0',
        // 被裁掉的功能：让页面在首帧就知道它们不存在。
        //
        // ⚠ 用 magpie 自己的机制（`data-feature` + 这里的数组）来隐藏页面，
        // **不删 DOM**：早先直接删 index.html 里的页面与脚本，结果 magpie 的
        // `load()` 在到达 `loadProviders()` 之前就碰到被删元素的 DOM 而中断，
        // 供应商页永远停在骨架屏。留着元素、只隐藏，启动链就是完整的。
        featuresOff: ['agents', 'sessions', 'library', 'gateway', 'redact', 'otel'],
    };
    const body = `window.bootPrefs=${JSON.stringify(prefs)};`;
    res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
    });
    res.end(body);
}

/** 静态文件（找不到就 404，不猜）。 */
async function serveFile(res, file) {
    try {
        const info = await stat(file);
        if (!info.isFile())
            return send(res, 404, 'text/plain; charset=utf-8', 'not found');
        const body = await readFile(file);
        const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, {
            'content-type': type,
            'content-length': String(body.length),
            // UI 资源随插件版本变化；用 no-cache 让浏览器每次校验，避免改了代码还看旧页面
            'cache-control': 'no-cache',
        });
        res.end(body);
    }
    catch {
        return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    }
}

/** API 分派：未实现的回 501，并说明缺哪个（便于从控制台定位）。 */
async function serveApi(req, res, deps, name) {
    const key = name.replace(/\/+$/, '');
    const handler = deps.handlers?.[key];
    if (typeof handler !== 'function') {
        return send(res, 501, 'application/json; charset=utf-8', JSON.stringify({
            error: 'not-implemented',
            api: key,
            message: '这个 magpie 接口还没在本插件里实现（对应页面也可能已删除）',
        }));
    }
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
            body = await readJson(req);
        }
        catch {
            return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'bad-json' }));
        }
    }
    try {
        const out = await handler(req, body);
        // 处理器可以直接给原始响应（比如文件流）
        if (out !== null && typeof out === 'object' && typeof out.writeHead === 'function') {
            return out;
        }
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(out ?? null));
    }
    catch (e) {
        return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({
            error: 'handler-failed',
            api: key,
            message: e instanceof Error ? e.message : String(e),
        }));
    }
}

/** 读请求体（限 1 MB，别让一个坏请求把内存吃掉）。 */
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024)
            throw new Error('body too large');
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? undefined : JSON.parse(text);
}

function send(res, status, type, body) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
}
