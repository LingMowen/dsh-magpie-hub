/**
 * Magpie 插件宿主 —— 钩子编排（M1-M20 契约的落地）。
 *
 * 宿主对插件只做 magpie 会做的事，且只在 magpie 会做的时机做：
 *
 * | 时机 | 调什么 |
 * |---|---|
 * | 启动 / 装完插件 | 每个插件的 `config(cfg)`（原地改，`??=` 不覆盖用户配置） |
 * | 列账号 | 读 `plugin-auth.json` |
 * | 登录 | `auth.methods[].authorize(inputs)` → flow{url,method,callback} |
 * | 登录成功 | `callback()` → `{type:'success',...}` → `signInKey` + `settle` 写盘 |
 * | 每次请求前 | `auth.refresh(auth)`（expires 距今 < refreshLead 时）、`auth.loader(getAuth)` |
 * | 列模型 | `provider.models(provider, {auth})`（每账号一次，账号作用域内） |
 * | 面板刷新 | `auth.usage(getAuth)` / `auth.checkin(getAuth)` |
 * | 每请求 | `chat.headers(input, output)`（后者覆盖前者） |
 */
import { accountsOf, freshKey, settleKey } from './store.js';
import { requireScope, runInScope } from './scope.js';
import { providersOf } from './runtime.js';
import { whoOf } from './types.js';
const DEFAULT_REFRESH_LEAD_MS = 5 * 60_000;
const RENEWAL_RETRY_MS = 30_000;
/**
 * 宿主本体：持有插件列表、账号存储、进行中的登录与续期。
 *
 * ⚠️ 一个 provider 可能被**多个插件**声明（同 id）——契约说这时只由其中一个
 * 提供（选定的，否则后添加的）。这里按加载顺序后者覆盖前者并记下冲突。
 */
export class MagpieHost {
    paths;
    auth;
    plugins = [];
    failures = [];
    config = { provider: {} };
    sessions = new Map();
    renewing = new Map();
    renewFailures = new Map();
    /** provider id → 所有声明它的插件（可能多于一个，冲突时面板要提示）。 */
    owners = new Map();
    constructor(paths, auth) {
        this.paths = paths;
        this.auth = auth;
        void this.paths;
    }
    /** 装好的插件列表（面板读）。 */
    get loaded() {
        return this.plugins;
    }
    get loadFailures() {
        return this.failures;
    }
    /** 某个 provider 由哪个插件提供（冲突时是最后一个）。 */
    ownerOf(provider) {
        const list = this.owners.get(provider);
        return list === undefined ? undefined : list[list.length - 1];
    }
    /** provider 的所有声明者（>1 说明冲突）。 */
    ownersOf(provider) {
        return this.owners.get(provider) ?? [];
    }
    /** provider 的配置（跑过 config 钩子之后的）。 */
    providerConfig(provider) {
        return this.config.provider[provider];
    }
    /**
     * 这个 provider 的插件声明了某个钩子吗（面板据此决定给不给按钮）。
     *
     * ⚠️ 判据是**函数存在**，不是 truthy：契约里钩子是可选属性，插件把
     * `checkin: undefined` 写进对象与完全不写是同一件事，但对
     * `typeof x === 'function'` 都返回 false，符合预期。
     */
    declares(provider, hook) {
        const owner = this.ownerOf(provider);
        if (owner === undefined)
            return false;
        const auth = owner.hooks.auth;
        if (auth === undefined)
            return false;
        const value = auth[hook];
        return typeof value === 'function';
    }
    /** 全部 provider id（面板读）。 */
    providerIds() {
        return Object.keys(this.config.provider);
    }
    /**
     * 装配插件：跑每个插件的 `config(cfg)`，合并出 provider 表。
     *
     * ⚠️ config 钩子**原地改**传进去的对象（契约），所以这里把同一个 `this.config`
     * 传给每个插件——它们各自 `cfg.provider[id] ??= {...}`，互不覆盖对方已写的字段。
     * 插件自己内部也要遵守「不覆盖用户配置」，宿主不再二次干预。
     */
    async assemble(plugins, failures) {
        this.plugins = plugins;
        this.failures = failures.map((f) => ({ spec: f.spec, error: f.error }));
        this.owners.clear();
        // 每个插件的 config 钩子跑一次；失败只记错，不影响别的插件。
        for (const plugin of plugins) {
            const fn = plugin.hooks.config;
            if (typeof fn !== 'function')
                continue;
            try {
                await fn(this.config);
            }
            catch (e) {
                this.failures.push({
                    spec: plugin.spec,
                    error: `${plugin.exportName}.config 失败：${e instanceof Error ? e.message : String(e)}`,
                });
            }
        }
        // provider 归属：auth.provider 与 provider.id 都算声明。
        for (const plugin of plugins) {
            const ids = new Set(plugin.providers);
            for (const id of providersOf(plugin.hooks))
                ids.add(id);
            for (const id of ids) {
                const list = this.owners.get(id) ?? [];
                if (!list.includes(plugin))
                    list.push(plugin);
                this.owners.set(id, list);
                // config 没声明但 auth/provider 声明了的，补一个空壳（面板要能列出它）
                this.config.provider[id] ??= { models: {} };
            }
        }
    }
    // ── 账号 ──────────────────────────────────────────────────────────────
    /** provider 下的全部账号 key。 */
    async accountKeys(provider) {
        return accountsOf(await this.auth.all(), provider);
    }
    /** 全部有账号的 provider id。 */
    async signedInProviders() {
        const all = await this.auth.all();
        const ids = new Set();
        for (const key of Object.keys(all)) {
            ids.add(key.includes('#') ? key.slice(0, key.indexOf('#')) : key);
        }
        return [...ids];
    }
    /**
     * 在当前作用域里跑的 `getAuth`（契约：只传给 loader / models / usage / checkin）。
     * 它读的是**作用域里那个账号**，不是「随便一个」。
     */
    getAuthFor(provider, key) {
        return async () => {
            this.auth.invalidate();
            return this.auth.get(key);
        };
    }
    /** 造一个账号作用域（`inScope`）。 */
    scopeFor(provider, key) {
        return {
            provider,
            key,
            auth: () => this.authSnapshot(key),
            setAuth: async (body) => { await this.auth.set(key, body); },
        };
    }
    /** 作用域里的同步读数（AsyncLocalStorage 的 auth() 是同步的，故留一份镜像）。 */
    mirrors = new Map();
    authSnapshot(key) {
        return this.mirrors.get(key);
    }
    /** 把某个账号的记录读进镜像（进作用域前调）。 */
    async prime(key) {
        this.auth.invalidate();
        const stored = await this.auth.get(key);
        this.mirrors.set(key, stored);
        return stored;
    }
    /** 在某个账号的作用域里跑一段代码。 */
    async inScope(provider, key, fn) {
        await this.prime(key);
        return runInScope(this.scopeFor(provider, key), fn);
    }
    // ── 登录 ──────────────────────────────────────────────────────────────
    /** provider 可用的登录方式（面板列出来给用户选）。 */
    methodsOf(provider) {
        const owner = this.ownerOf(provider);
        const methods = owner?.hooks.auth?.methods;
        return Array.isArray(methods) ? methods : [];
    }
    /**
     * 开始一次登录：调 `authorize(inputs)` 拿 flow。
     *
     * ⚠️ 契约明令：`authorize()` 里**不能等用户**（会与宿主双向死锁）。
     * 所以这里只取 flow 就返回，真正的等待在 `finishSignIn` 里。
     */
    async startSignIn(provider, methodIndex, inputs) {
        const methods = this.methodsOf(provider);
        const method = methods[methodIndex];
        if (method === undefined)
            throw new Error(`没有第 ${methodIndex} 个登录方式（provider ${provider}）`);
        const result = await method.authorize(inputs);
        // api 类型可以**直接**返回成功：没有 authorize 时 magpie 原样存 key，
        // 有 authorize 时由它校验后回 success —— 两条路都认。
        if (result !== null && typeof result === 'object' && result.type === 'success') {
            const key = await this.saveSignIn(provider, result);
            return { accountId: whoOf(await this.auth.get(key)) };
        }
        if (result !== null && typeof result === 'object' && result.type === 'failed') {
            throw new Error(result.error ?? '登录失败');
        }
        const flow = result;
        const sessionKey = `${provider}:${methodIndex}`;
        this.sessions.set(sessionKey, { provider, method, inputs: inputs ?? {}, flow, startedAt: Date.now() });
        return {
            url: flow.url,
            instructions: flow.instructions,
            method: flow.method,
            ...(flow.method === 'code' ? { code: '请输入验证码' } : {}),
        };
    }
    /** 判断是否有进行中的登录（面板轮询用）。 */
    hasSignIn(provider, methodIndex = 0) {
        return this.sessions.has(`${provider}:${methodIndex}`);
    }
    /**
     * 完成登录：等 `callback(code)`，拿到 `{type:'success'}` 后写盘。
     * `code` 只在 `method: 'code'` 的形态下需要。
     */
    async finishSignIn(provider, methodIndex, code) {
        const sessionKey = `${provider}:${methodIndex}`;
        const session = this.sessions.get(sessionKey);
        if (session === undefined)
            throw new Error('没有进行中的登录（可能已超时，请重新开始）');
        const callback = session.flow.callback;
        if (typeof callback !== 'function')
            throw new Error('这个登录方式没有回调，无法等待结果');
        const result = await callback(code);
        if (result.type === 'failed') {
            this.sessions.delete(sessionKey);
            throw new Error(result.error);
        }
        const key = await this.saveSignIn(provider, result);
        this.sessions.delete(sessionKey);
        const stored = await this.auth.get(key);
        return { accountId: whoOf(stored), key };
    }
    /**
     * 写一条登录记录：先找同名账号（`settle`）→ 否则选一个空 key
     * （`signInKey`）。`single: true` 的 provider 直接覆盖自己的 key。
     */
    async saveSignIn(provider, result) {
        const all = await this.auth.all();
        const owner = this.ownerOf(provider);
        const single = owner?.hooks.auth?.single === true;
        let key;
        if (single) {
            key = provider;
        }
        else {
            // 契约的 settle 顺序：accountId 相同（且 uid 相同）⇒ 替换，否则比 secret，
            // 都不中就占一个新槽位（`provider#<slot>`）。
            const incoming = { ...result, type: 'oauth' };
            const settled = settleKey(all, provider, incoming);
            key = settled ?? freshKey(provider, accountsOf(all, provider), incoming.access ?? incoming.key);
        }
        // ⚠️ `result.type` 是**登录结果的** 'success'，不是存储记录的 'api'/'oauth'：
        // 契约里 authorize 只回报成功与否，凭据种类由调用方（或用户）决定，默认 oauth。
        const body = { ...result, type: 'oauth' };
        await this.auth.set(key, body);
        this.mirrors.set(key, body);
        // 契约：host 保存了登录要主动告诉宿主（这里用监听者代替 stdout 事件）
        this.notify('auth', provider, key);
        return key;
    }
    watchers = new Set();
    onEvent(fn) {
        this.watchers.add(fn);
        return () => { this.watchers.delete(fn); };
    }
    notify(event, provider, account) {
        for (const fn of this.watchers) {
            try {
                fn(event, provider, account);
            }
            catch { /* 监听者自己的错 */ }
        }
    }
    // ── 续期 ──────────────────────────────────────────────────────────────
    /** 该账号要不要续期（expires 距今 < refreshLead）。 */
    shouldRenew(provider, stored) {
        if (stored === undefined)
            return false;
        const expires = stored.expires;
        // 契约：expires 为 0 或不存在的账号永不续期。
        if (typeof expires !== 'number' || expires <= 0)
            return false;
        const owner = this.ownerOf(provider);
        const lead = owner?.hooks.auth?.refreshLead;
        const leadMs = typeof lead === 'number' && Number.isFinite(lead) && lead >= 0 ? lead : DEFAULT_REFRESH_LEAD_MS;
        const failure = this.renewFailures.get(this.keyOf(provider, stored));
        if (failure?.gone === true)
            return false;
        if (failure?.failed !== undefined && Date.now() - failure.failed < RENEWAL_RETRY_MS)
            return false;
        return expires - Date.now() < leadMs;
    }
    keyOf(provider, stored) {
        return stored.accountId ?? stored.uid ?? provider;
    }
    /**
     * 续期（同账号串行 —— 契约：一次性 refresh_token 的厂商绝不能被并发用两次）。
     * 返回合并后的记录；失败时按契约分档：`signIn: 'expired'` 标记不再重试，
     * 其它错误 30 秒后可重试。
     */
    async refresh(provider, key) {
        const inflight = this.renewing.get(key);
        if (inflight !== undefined)
            return inflight;
        const run = (async () => {
            const owner = this.ownerOf(provider);
            const fn = owner?.hooks.auth?.refresh;
            if (typeof fn !== 'function')
                return undefined;
            const stored = await this.prime(key);
            if (stored === undefined)
                return undefined;
            try {
                const patch = await this.inScope(provider, key, async () => fn(stored, provider));
                if (patch === undefined)
                    return undefined;
                const next = await this.auth.merge(key, patch);
                this.mirrors.set(key, next);
                this.renewFailures.delete(this.keyOf(provider, next));
                this.notify('auth', provider, key);
                return next;
            }
            catch (e) {
                const signIn = e?.signIn;
                const prev = this.renewFailures.get(this.keyOf(provider, stored)) ?? { at: Date.now() };
                if (signIn === 'expired') {
                    this.renewFailures.set(this.keyOf(provider, stored), { ...prev, gone: true });
                }
                else {
                    this.renewFailures.set(this.keyOf(provider, stored), { ...prev, failed: Date.now() });
                }
                return undefined;
            }
        })();
        this.renewing.set(key, run);
        try {
            return await run;
        }
        finally {
            this.renewing.delete(key);
        }
    }
    /** 请求前：临期就先续（契约的运行时机）。 */
    async ensureFresh(provider, key) {
        const stored = await this.prime(key);
        if (!this.shouldRenew(provider, stored))
            return stored;
        return (await this.refresh(provider, key)) ?? stored;
    }
    // ── 模型目录 ──────────────────────────────────────────────────────────
    /**
     * 某个账号的模型目录（`provider.models`）。失败时**保留静态表**（契约：三态降级）。
     */
    async modelsOf(provider, key) {
        const base = this.config.provider[provider]?.models ?? {};
        const owner = this.ownerOf(provider);
        if (owner === undefined)
            return base;
        const fn = owner.hooks.provider?.models;
        if (typeof fn !== 'function')
            return base;
        await this.ensureFresh(provider, key);
        overrideFellBack(owner.hooks, false);
        try {
            return await this.inScope(provider, key, async () => {
                const stored = await this.prime(key);
                const target = { ...(this.config.provider[provider] ?? { models: {} }), models: base };
                const out = await fn(target, stored === undefined ? {} : { auth: stored });
                if (out === undefined || out === null || typeof out !== 'object')
                    return base;
                const merged = Object.keys(out).length === 0 ? base : out;
                return fellBackOf(owner.hooks) ? base : merged;
            });
        }
        catch {
            // 契约：目录失败退回静态表，不抛（登录失效由 loader 的 401 报）。
            return base;
        }
    }
    // ── 额度 / 签到 ───────────────────────────────────────────────────────
    async usageOf(provider, key) {
        const owner = this.ownerOf(provider);
        const fn = owner?.hooks.auth?.usage;
        if (typeof fn !== 'function')
            return undefined;
        await this.ensureFresh(provider, key);
        try {
            const out = await this.inScope(provider, key, async () => fn(this.getAuthFor(provider, key), provider));
            if (out === undefined || out === null)
                return undefined;
            this.notify('usage', provider, key);
            return out;
        }
        catch (e) {
            return { error: e instanceof Error ? e.message : String(e), windows: [] };
        }
    }
    async checkinOf(provider, key) {
        const owner = this.ownerOf(provider);
        const fn = owner?.hooks.auth?.checkin;
        if (typeof fn !== 'function')
            return undefined;
        await this.ensureFresh(provider, key);
        try {
            const out = await this.inScope(provider, key, async () => fn(this.getAuthFor(provider, key), provider));
            return out ?? { outcome: 'failed', message: '没有返回结果' };
        }
        catch (e) {
            // 契约：钩子抛异常等同 failed。
            return { outcome: 'failed', message: e instanceof Error ? e.message : String(e) };
        }
    }
    // ── loader（请求接管）──────────────────────────────────────────────────
    /**
     * 取某个账号的 loader 结果。契约：每账号一次，登录信息变化后重跑。
     */
    async loaderOf(provider, key) {
        const owner = this.ownerOf(provider);
        const fn = owner?.hooks.auth?.loader;
        if (typeof fn !== 'function')
            return {};
        await this.ensureFresh(provider, key);
        const out = await this.inScope(provider, key, async () => fn(this.getAuthFor(provider, key), provider));
        return out ?? {};
    }
    /** `chat.headers`：全部插件的链式调用（后者覆盖前者）。 */
    async chatHeaders(input) {
        const output = { headers: {} };
        for (const plugin of this.plugins) {
            const fn = plugin.hooks['chat.headers'];
            if (typeof fn !== 'function')
                continue;
            try {
                await fn(input, output);
            }
            catch {
                // 契约：chat.headers 出错只记日志，不影响请求。
            }
        }
        return { ...output.headers };
    }
    /** 登录前的问题序列（`get prompts` 与多步 `ask`）。 */
    promptsOf(provider, methodIndex) {
        const method = this.methodsOf(provider)[methodIndex];
        if (method === undefined)
            return [];
        try {
            const list = method.prompts;
            return Array.isArray(list) ? list : [];
        }
        catch {
            return [];
        }
    }
    /** 多步问答：返回下一个问题（问完 = null）。 */
    async nextPrompt(provider, methodIndex, inputs) {
        const method = this.methodsOf(provider)[methodIndex];
        if (method === undefined)
            return null;
        if (typeof method.ask === 'function') {
            const next = await method.ask(inputs);
            return next ?? null;
        }
        return null;
    }
    /** 当前配置（`client.config.get` 的返回）。 */
    currentConfig() {
        return this.config;
    }
}
/**
 * `Symbol.for('magpie.fellBack')` —— 契约的失败标记：插件在自己的列表上设它
 * 表示「这是退回的旧目录」，宿主应整份丢弃。
 */
const FELL_BACK = Symbol.for('magpie.fellBack');
function overrideFellBack(hooks, value) {
    const target = hooks;
    try {
        target[FELL_BACK] = value;
    }
    catch {
        // 冻结的对象：契约允许插件用返回原列表/抛异常两种别的写法，不强行设。
    }
}
function fellBackOf(hooks) {
    return hooks[FELL_BACK] === true;
}
export { requireScope };
//# sourceMappingURL=host.js.map