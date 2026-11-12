/**
 * magpie-hub 的管理 API：服务端一侧。
 *
 * ## 这是给谁用的
 *
 * **桌面端（DSH Web 界面）** 的面板要读服务端状态（装了哪些 magpie 插件、每个
 * provider 登录了什么、额度、用量、路由），这走不了 `dshGo`（那是手机 App 的原生
 * 面板通道），于是走 DSH 自己的客户端↔服务端 RPC：
 *
 * ```
 * Client: connection.rpc.call('/api', 'magpie-hub', { method, payload })
 * Host:   connection.fetch.register({ path: '/api/magpie-hub', methods: ['POST'] })
 * ```
 *
 * ## 为什么端点是 `/api/magpie-hub` 而不是别的
 *
 * `/api/` 前缀下的路由会先过 DSH 自己的会话认证（只有登录了 Web 界面的人能打），
 * 等于白拿了一层鉴权。**不要**把这类端点挂到 `/dsh-go/` 之类自建前缀上。
 *
 * ## 信封格式（照抄 DSH 的 connection.rpc 约定）
 *
 * 请求 `{ type: 'client-request', rpcId, method, payload: { method, payload } }`
 * 响应 `{ type: 'server-response', rpcId, result }`
 * 失败一律包成 `{ ok: false, error: { code, message } }` 放在 `result` 里 ——
 * **不要**用 HTTP 4xx 表达业务错误：客户端 `rpc.call` 只看 `result.ok`，
 * HTTP 状态码会被它当成传输层故障。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentScope } from './scope.js';
/** 通道名（`/api/<这个名字>`）。 */
export const MAGPIE_HUB_ENDPOINT = 'magpie-hub';
/** 把结果包成 DSH 的 server-response。 */
function reply(rpcId, result) {
    return Response.json({ type: 'server-response', rpcId, result });
}
/** 包一个成功值。 */
function ok(value) {
    return { ok: true, value };
}
/** 包一个业务错误（不用 HTTP 状态码表达）。 */
function fail(code, message) {
    return { ok: false, error: { code, message } };
}
/**
 * 注册 `/api/magpie-hub`。
 *
 * ## ⚠️ 必须走 `ctx.inject(['connection'], …)`
 *
 * `connection` 这个服务**只由 Web bundle（`dsh-client-connection`）提供**，
 * headless / CLI profile 里根本不存在。它也不在本插件的静态 `inject` 里
 * （声明了会让那些 profile 整个插件 pending，进而 profile 启动失败）。
 *
 * 所以取它的**唯一正确姿势**是与 codearts 相同的那一种：
 * ```js
 * ctx.inject(['connection'], (scoped) => { /* 在这里注册 *\/ })
 * ```
 * 直接把 `ctx.connection` 当属性读是拿不到的（cordis 未声明服务读取即抛，
 * 我先前用 try/catch 包了一层 → 静默 undefined → 端点从未注册 → 客户端
 * 一直 `transport failure for /api/magpie-hub HTTP 404`）。
 *
 * @param ctx DSH 上下文（要能用 `inject`）
 * @param deps 宿主依赖
 * @returns 注销函数（`ctx.effect` 用）；没有 `inject` 能力时返回 undefined
 */
export function registerMagpieHubApi(ctx, deps) {
    const withInject = ctx;
    if (typeof withInject.inject !== 'function') {
        deps.log('[magpie-hub] ctx.inject 不可用，桌面面板的 RPC 端点未注册（手机原生面板不受影响）');
        return undefined;
    }
    // ⚠️ 回调里**返回 disposer**：cordis 把 `inject` 回调的返回值当作该作用域的
    //    清理函数（与 `ctx.effect` 同一语义）。早先这里返回 undefined，端点注册
    //    后永远撤不掉 —— 热替换一次就多一个 handler，`path` 冲突时后注册的会被
    //    拒或遮住前一个，而两种都不报错。
    let stop;
    withInject.inject(['connection'], (scoped) => {
        stop = registerInScope(scoped, deps);
        return () => {
            stop?.();
            stop = undefined;
        };
    });
    // 返回一个手动撤销入口（`ctx.effect` 里调用时同样有效）
    return () => {
        stop?.();
        stop = undefined;
    };
}
/**
 * 在持有 `connection` 的作用域里注册端点（从 `registerMagpieHubApi` 抽出，
 * 便于单测直接用假作用域调用）。
 */
export function registerInScope(scoped, deps) {
    const connection = connectionOf(scoped);
    if (connection === undefined) {
        deps.log('[magpie-hub] 作用域里没有 connection，桌面面板的 RPC 端点未注册');
        return undefined;
    }
    /** 方法表：客户端能调的全在这里。 */
    const handlers = {
        /** 面板快照（四页签的全部数据）。 */
        'panel.snapshot': async () => ok(await deps.snapshot()),
        /** 重新扫描插件目录。 */
        'plugins.reload': async () => {
            const out = await deps.reload();
            return ok(out);
        },
        /**
         * 商店：市场清单。
         *
         * ⚠️ 安装是慢操作（整仓 tarball ~10MB，实测 ~2 分钟），**不在清单请求里
         * 做任何下载**——客户端先拿列表渲染，点「安装」再单独调 `market.install`。
         *
         * @param payload `{ force?: boolean }` 强制刷新缓存
         */
        'market.list': async (payload) => {
            const force = payload?.force === true;
            const listings = await deps.marketListings(force);
            // 只回面板用得上的字段（icon 可能是几 MB 的 data URI，截掉超大的）
            return ok(listings.map((l) => ({
                package: l.package,
                name: l.name,
                icon: l.icon === undefined ? undefined : String(l.icon).length > 100_000 ? undefined : l.icon,
                providers: l.providers,
                community: l.community,
                kind: l.kind,
                summary: l.summary,
            })));
        },
        /**
         * 商店：安装一个插件（**慢**，客户端要给 loading 态；AbortSignal 可取消下载）。
         *
         * 安装成功后宿主的热重载会自动重扫，客户端再调 `panel.snapshot` 就能看到。
         */
        'market.install': async (payload, signal) => {
            const pkg = payload?.package;
            if (typeof pkg !== 'string' || pkg === '')
                return fail('bad-request', '缺少 package');
            const out = await deps.marketInstall(pkg, signal);
            return out.ok ? ok({ dir: out.dir }) : fail('install-failed', out.error ?? '安装失败');
        },
        /** 商店：卸载（删目录 + 从 plugins.json 移除）。 */
        'market.uninstall': async (payload) => {
            const pkg = payload?.package;
            if (typeof pkg !== 'string' || pkg === '')
                return fail('bad-request', '缺少 package');
            await deps.marketUninstall(pkg);
            return ok({ removed: pkg });
        },
        /** 切时间窗。 */
        'stats.period': async (payload) => {
            const raw = payload?.period;
            if (raw !== 'today' && raw !== '7d' && raw !== '30d' && raw !== 'all') {
                return fail('bad-request', 'period 必须是 today / 7d / 30d / all');
            }
            await deps.setPeriod(raw);
            return ok({ period: deps.period() });
        },
        /** 概览文本（「复制概览」用）。 */
        'panel.summary': async (payload) => {
            const locale = payload?.locale;
            return ok({ text: deps.summary(typeof locale === 'string' ? locale : undefined) });
        },
        /**
         * 读「面板入口」偏好（`sidebar` / `settings`，二选一）。
         *
         * 桌面端的两处入口靠它互斥：任一时刻只有一个存在。
         */
        'panel.entry': async () => ok({ entry: await deps.entry() }),
        /** 写「面板入口」偏好。非法值不落盘（回 `bad-request`）。 */
        'panel.setEntry': async (payload) => {
            const raw = payload?.entry;
            if (raw !== 'sidebar' && raw !== 'settings') {
                return fail('bad-request', 'entry 必须是 sidebar / settings');
            }
            await deps.setEntry(raw);
            return ok({ entry: await deps.entry() });
        },
        /** 一个 provider 的登录方式（面板据此画登录按钮）。 */
        'auth.methods': async (payload) => {
            const provider = payload?.provider;
            if (typeof provider !== 'string' || provider === '')
                return fail('bad-request', '缺少 provider');
            const methods = deps.host.methodsOf(provider).map((m, i) => ({
                index: i,
                type: m.type,
                label: m.label,
            }));
            return ok({ provider, methods });
        },
        /**
         * 开始登录：**只取 flow 就返回**（契约：authorize 里不能等用户）。
         *
         * 需要用户在浏览器里完成时回 `{ url, instructions, method }`；`api` 型
         * （粘贴 key）直接回 `{ done: true, accountId }`。手机/桌面之后调
         * `auth.signInFinish` 收尾。
         */
        'auth.signIn': async (payload) => {
            const body = (payload ?? {});
            const provider = typeof body.provider === 'string' ? body.provider : '';
            if (provider === '')
                return fail('bad-request', '缺少 provider');
            const index = typeof body.index === 'number' ? body.index : 0;
            const out = await deps.host.startSignIn(provider, index, body.inputs);
            // api 型（粘贴 key）会**直接**返回成功：`startSignIn` 给它补了 accountId
            // 且没有 url。此时登录已经落盘，不需要再调 signInFinish。
            if (out.url === undefined || out.url === '') {
                return ok({ done: true, ...(out.accountId === undefined ? {} : { accountId: out.accountId }) });
            }
            return ok({
                done: false,
                url: out.url,
                instructions: out.instructions ?? '',
                method: out.method ?? 'auto',
            });
        },
        /** 收尾登录（浏览器回调返回后）。 */
        'auth.signInFinish': async (payload) => {
            const body = (payload ?? {});
            const provider = typeof body.provider === 'string' ? body.provider : '';
            if (provider === '')
                return fail('bad-request', '缺少 provider');
            const index = typeof body.index === 'number' ? body.index : 0;
            const code = typeof body.code === 'string' ? body.code : undefined;
            try {
                const out = await deps.host.finishSignIn(provider, index, code);
                return ok({ key: out.key, accountId: out.accountId });
            }
            catch (e) {
                return fail('sign-in-failed', e instanceof Error ? e.message : String(e));
            }
        },
        /** 直接用 key 登录（`api` 型，等价于 `client.auth.set`）。 */
        'auth.saveKey': async (payload) => {
            const body = (payload ?? {});
            const provider = typeof body.provider === 'string' ? body.provider : '';
            const key = typeof body.key === 'string' ? body.key : '';
            if (provider === '' || key === '')
                return fail('bad-request', '缺少 provider 或 key');
            // 走 startSignIn 的 api 路径：它会做 settle/freshKey 并把记录落盘，
            // 与插件自己调 `client.auth.set` 的结果一致。
            const out = await deps.host.startSignIn(provider, 0, { key });
            return ok({ accountId: out.accountId ?? '' });
        },
        /** 删账号。 */
        'auth.remove': async (payload) => {
            const key = payload?.key;
            if (typeof key !== 'string' || key === '')
                return fail('bad-request', '缺少 key');
            await deps.auth.remove(key);
            return ok({ removed: key });
        },
        /** 额度（重跑 `auth.usage`）。 */
        'usage.refresh': async (payload) => {
            const body = (payload ?? {});
            const provider = typeof body.provider === 'string' ? body.provider : '';
            const key = typeof body.key === 'string' ? body.key : '';
            if (provider === '' || key === '')
                return fail('bad-request', '缺少 provider 或 key');
            const usage = await deps.host.usageOf(provider, key);
            return ok(usage ?? null);
        },
        /** 签到（慢操作，逐账号）。 */
        'checkin': async (payload, signal) => {
            const provider = payload?.provider;
            const target = typeof provider === 'string' ? provider : '';
            return ok(await deps.checkin(target, signal));
        },
        /**
         * 某个供应商的模型目录**含被禁用的**（面板画开关要用）。
         *
         * 与 `listModels` 的区别：那个是给 DSH 模型选择器的（已过滤），
         * 这个是给面板的（一条不少，带 `disabled` 标记）。
         */
        'catalog.rows': async (payload) => {
            const provider = typeof payload?.provider === 'string' ? payload.provider : '';
            if (provider === '')
                return fail('bad-request', '缺少 provider');
            try {
                const rows = await deps.adapter.catalogRows(provider);
                return ok({ provider, rows });
            }
            catch (e) {
                return fail('catalog-failed', e instanceof Error ? e.message : String(e));
            }
        },
        /** 模型目录（失效后重取）。 */
        'catalog.refresh': async () => {
            // 模型目录缓存在 adapter 里，这里只让面板快照重算（下次读会重取）
            await deps.reload();
            return ok({ ok: true });
        },
        // ── 模型开关 ──────────────────────────────────────────────────────────
        /**
         * 启停一个模型。
         *
         * `off: true` 禁用（从模型选择器消失），`off: false` 恢复。
         * 被禁用的模型**仍然**在面板目录里可见（带 `disabled` 标记），否则
         * 关掉之后就再也没有入口能把它打开。
         */
        'model.toggle': async (payload) => {
            const body = (payload ?? {});
            const provider = typeof body.provider === 'string' ? body.provider : '';
            const model = typeof body.model === 'string' ? body.model : '';
            if (provider === '' || model === '')
                return fail('bad-request', '缺少 provider 或 model');
            await deps.policy.setModelDisabled(provider, model, body.off === true);
            return ok({ disabled: await deps.policy.isModelDisabled(provider, model) });
        },
        /** 批量启停：一次给一串模型。 */
        'model.setMany': async (payload) => {
            const body = (payload ?? {});
            const provider = typeof body.provider === 'string' ? body.provider : '';
            const models = Array.isArray(body.models) ? body.models.filter((m) => typeof m === 'string') : [];
            if (provider === '' || models.length === 0)
                return fail('bad-request', '缺少 provider 或 models');
            await deps.policy.setModelsDisabled(models.map((model) => ({ provider, model })), body.off === true);
            return ok({ count: models.length, off: body.off === true });
        },
        /**
         * 失效模型清理：把「已禁用但目录里已经没有」的键删掉。
         *
         * 为什么要清：供应商会下线模型，这些键留在状态里越积越多，
         * 将来同名模型重新上线时会被静默禁用，而用户找不到原因。
         */
        'model.clearDead': async () => {
            const state = await deps.policy.get();
            const alive = new Set();
            for (const provider of deps.host.providerIds()) {
                let rows = [];
                try {
                    rows = await deps.adapter.catalogRows(provider);
                }
                catch { /* 目录取不到就跳过这个 provider，别误删 */ }
                for (const row of rows) alive.add(`${provider}/${row.id}`);
            }
            const dead = [...state.disabledModels].filter((key) => !alive.has(key));
            if (dead.length > 0) {
                // 逐个恢复：它们本来就已经不在目录里，恢复后也不会冒出来
                await deps.policy.setModelsDisabled(dead.map((key) => {
                    const slash = key.indexOf('/');
                    return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
                }), false);
            }
            return ok({ cleared: dead.length, keys: dead.slice(0, 20) });
        },
        // ── 供应商启停 ────────────────────────────────────────────────────────
        /** 停用/启用一个供应商（停用后不进模型选择器）。 */
        'provider.setOff': async (payload) => {
            const body = (payload ?? {});
            const provider = typeof body.provider === 'string' ? body.provider : '';
            if (provider === '')
                return fail('bad-request', '缺少 provider');
            await deps.policy.setProviderOff(provider, body.off === true);
            // 注册表要跟着变：停用 = 从 DSH 的 provider 列表里摘掉
            await deps.reload();
            return ok({ off: await deps.policy.isProviderOff(provider) });
        },
        // ── 账号 ──────────────────────────────────────────────────────────────
        /** 给账号起个别名（空名字 = 清除，回到真实名字）。 */
        'account.rename': async (payload) => {
            const body = (payload ?? {});
            const key = typeof body.key === 'string' ? body.key : '';
            if (key === '')
                return fail('bad-request', '缺少 key');
            await deps.policy.setAccountAlias(key, typeof body.name === 'string' ? body.name : '');
            return ok({ alias: (await deps.policy.aliasOf(key)) ?? null });
        },
        /** 隐藏账号（面板不显示，路由/请求照常可用）。 */
        'account.setHidden': async (payload) => {
            const body = (payload ?? {});
            const key = typeof body.key === 'string' ? body.key : '';
            if (key === '')
                return fail('bad-request', '缺少 key');
            await deps.policy.setAccountHidden(key, body.hidden === true);
            return ok({ hidden: await deps.policy.isAccountHidden(key) });
        },
        /**
         * 这个账号只能跑哪些模型（`[]` = 取消限制）。
         *
         * 取号时会跳过不允许当前模型的账号，所以这比「发出去被上游 403」更早。
         */
        'account.setModels': async (payload) => {
            const body = (payload ?? {});
            const key = typeof body.key === 'string' ? body.key : '';
            if (key === '')
                return fail('bad-request', '缺少 key');
            await deps.policy.setAccountModels(key, Array.isArray(body.models) ? body.models : []);
            return ok({ models: (await deps.policy.modelsOfAccount(key)) ?? [] });
        },
        /**
         * 重测账号：再问一次额度、再看一次模型目录，把结果回报给调用方。
         *
         * 失败也返回 `ok`（带 `error` 字段）：这是「测一下看看」的动作，
         * 探测失败本身就是结果，不应该让整个请求变成错误。
         */
        'account.retest': async (payload) => {
            const body = (payload ?? {});
            const key = typeof body.key === 'string' ? body.key : '';
            const provider = typeof body.provider === 'string'
                ? body.provider
                : key.includes('#') ? key.slice(0, key.indexOf('#')) : key;
            if (key === '' || provider === '')
                return fail('bad-request', '缺少 provider 或 key');
            let usage;
            let models;
            try {
                usage = await deps.host.usageOf(provider, key);
            }
            catch (e) {
                usage = { error: e instanceof Error ? e.message : String(e) };
            }
            try {
                models = Object.keys(await deps.host.modelsOf(provider, key)).length;
            }
            catch {
                models = undefined;
            }
            return ok({
                provider,
                key,
                ...(models === undefined ? {} : { models }),
                ...(usage?.error === undefined ? {} : { error: String(usage.error) }),
                ...(usage?.plan === undefined ? {} : { plan: usage.plan }),
                windows: Array.isArray(usage?.windows) ? usage.windows.length : 0,
            });
        },
        /**
         * 清除某个账号的额度缓存（`fastest` 排序不再参考它）。
         *
         * magpie 的「重置」清的是限流标记；这里清的是**我自己算出来的额度缓存**
         * ——额度刚被上游重置时，缓存里的旧百分比会把账号排到队尾。
         */
        'account.resetQuota': async (payload) => {
            const body = (payload ?? {});
            const key = typeof body.key === 'string' ? body.key : '';
            const provider = typeof body.provider === 'string'
                ? body.provider
                : key.includes('#') ? key.slice(0, key.indexOf('#')) : key;
            if (key === '' || provider === '')
                return fail('bad-request', '缺少 provider 或 key');
            deps.clearQuota?.(provider, key);
            return ok({ cleared: `${provider}#${key}` });
        },
        // ── 路由 ──────────────────────────────────────────────────────────────
        /** 路由策略：`first`（按顺序）/ `fastest`（按剩余额度）/ `cheapest`。 */
        'route.strategy': async (payload) => {
            const next = payload?.strategy;
            if (next !== 'first' && next !== 'fastest' && next !== 'cheapest')
                return fail('bad-request', 'strategy 只能是 first / fastest / cheapest');
            return ok({ strategy: await deps.policy.setStrategy(next) });
        },
        /** 设置某个聚合键的候选顺序（`[]` = 清掉这组）。 */
        'route.setGroup': async (payload) => {
            const body = (payload ?? {});
            const key = typeof body.key === 'string' ? body.key : '';
            if (key === '')
                return fail('bad-request', '缺少 key');
            await deps.policy.setGroup(key, Array.isArray(body.candidates) ? body.candidates : []);
            return ok({ key, candidates: (await deps.policy.groups())[key] ?? [] });
        },
        // ── 插件升级 ──────────────────────────────────────────────────────────
        /**
         * 已装插件的版本与来源。
         *
         * 市场清单里**没有版本字段**（只有 package/name/icon/providers/summary），
         * 所以这里报的是「本地 package.json 里的版本」，不是「有没有新版」——
         * 不编造一个「最新版」来对比。
         */
        'plugins.versions': async () => {
            const rows = [];
            for (const spec of await deps.plugins.list()) {
                // spec 有两种：npm 包名（在 modulesDir 下）与**本地绝对路径 / git URL**
                // （插件直接指向磁盘目录或仓库，不在 node_modules 里）。
                // 后者不能拿 moduleNameOf 当包名拼路径，要直接用它自己。
                const raw = spec.spec;
                const local = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(raw) || raw.startsWith('file:') || raw.startsWith('github:') || /^https?:/.test(raw);
                const name = local ? raw : deps.moduleNameOf(raw);
                const dir = local && !raw.startsWith('github:') && !/^https?:/.test(raw)
                    ? raw.replace(/^file:/, '')
                    : join(deps.modulesDir, name);
                let version = null;
                let error = null;
                try {
                    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
                    version = typeof pkg.version === 'string' ? pkg.version : null;
                }
                catch (e) {
                    error = e instanceof Error ? e.message : String(e);
                }
                rows.push({
                    spec: raw,
                    name,
                    source: local ? 'local' : 'npm',
                    ...(version === null ? {} : { version }),
                    ...(error === null ? {} : { error }),
                });
            }
            return ok({ plugins: rows, total: rows.length });
        },
        /**
         * 升级一个插件：从市场**重新拉最新**并覆盖安装，然后重载。
         *
         * ⚠ 清单没有版本号，所以无法判断「有没有新版」，只能重新装一次。
         * 调用方应该把它当「重装」而不是「升级」来理解（返回里也如实说明）。
         */
        'plugins.update': async (payload, signal) => {
            const pkg = typeof payload?.package === 'string' ? payload.package : '';
            if (pkg === '')
                return fail('bad-request', '缺少 package');
            const result = await deps.marketInstall(pkg, signal, { force: true });
            if (result?.ok === false)
                return fail('install-failed', String(result.error ?? '安装失败'));
            // 装完必须重载：否则模块缓存里还是旧代码
            await deps.reload();
            return ok({ package: pkg, reinstalled: true });
        },
        // ── 签到排期 ──────────────────────────────────────────────────────────
        /** 自动签到开关与状态（每天固定时段跑一次，见 index.js 的调度器）。 */
        'checkin.schedule': async (payload) => {
            const body = (payload ?? {});
            if (body.enabled === undefined) {
                return ok(await deps.checkinSchedule());
            }
            const state = await deps.checkinSchedule(body.enabled === true);
            return ok(state);
        },
    };
    const stop = connection.fetch.register({
        path: `/api/${MAGPIE_HUB_ENDPOINT}`,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            if (request.method !== 'POST') {
                return new Response('method not allowed', { status: 405 });
            }
            const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
            if (contentType !== 'application/json') {
                return new Response('content type must be application/json', { status: 415 });
            }
            let message;
            try {
                message = await request.json();
            }
            catch {
                return new Response('body is not JSON', { status: 400 });
            }
            const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request';
            const call = message.payload;
            if (message.type !== 'client-request'
                || typeof message.rpcId !== 'string'
                || message.method !== MAGPIE_HUB_ENDPOINT
                || call === undefined
                || typeof call.method !== 'string'
                || !Object.prototype.hasOwnProperty.call(call, 'payload')) {
                return reply(rpcId, fail('bad-request', 'Invalid magpie-hub management request.'));
            }
            const handler = handlers[call.method];
            if (handler === undefined) {
                return reply(rpcId, fail('unknown-method', `未知方法：${call.method}`));
            }
            try {
                return reply(rpcId, await handler(call.payload, request.signal));
            }
            catch (e) {
                return reply(rpcId, fail('internal', e instanceof Error ? e.message : String(e)));
            }
        },
    });
    return typeof stop === 'function' ? stop : undefined;
}
/**
 * 取 `connection`：DSH 的 ctx 有两个访问路径（属性与 `get()`），两种都试。
 *
 * ⚠️ 不能只用 `ctx.connection`：cordis 里未声明的服务是**取值即抛**的，
 * 而 `inject` 只对本插件的顶层声明生效 —— 这里用 `get()` 更稳。
 */
function connectionOf(ctx) {
    if (ctx === null || typeof ctx !== 'object')
        return undefined;
    const withProps = ctx;
    const direct = withProps.connection;
    if (isConnectionLike(direct))
        return direct;
    if (typeof withProps.get === 'function') {
        try {
            const viaGet = withProps.get('connection');
            if (isConnectionLike(viaGet))
                return viaGet;
        }
        catch {
            // 未注入：没有 connection
        }
    }
    return undefined;
}
function isConnectionLike(v) {
    return v !== null
        && typeof v === 'object'
        && typeof v.fetch?.register === 'function';
}
//# sourceMappingURL=rpc.js.map