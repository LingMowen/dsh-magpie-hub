/**
 * 插件宿主的存储层：插件目录的发现 + 登录态（OpenCode auth.json 形状）。
 *
 * 目录布局（与 magpie 的 `~/.config/magpie` 同构，但落在 DSH 自己的家目录下，
 * **不碰 magpie 的目录** —— 宿主与 magpie 可并存，互不写对方的文件）：
 *
 * ```
 * <root>/
 *   plugins.json          已安装插件清单：[{ spec, enabled, options? }]
 *   plugin-auth.json      登录态：{ "<provider>" | "<provider>#<slot>": StoredAuth }
 *   plugin-providers.json 上次列出的供应商与模型（缓存，可删）
 * ```
 *
 * ⚠️ 写入一律「先读 → 合并 → 原子替换（临时文件 + rename）」，避免半截文件
 * 让下次启动的解析直接失败（magpie 自己也是这么做的）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
export function hostPaths(root) {
    return {
        root,
        plugins: join(root, 'plugins.json'),
        auth: join(root, 'plugin-auth.json'),
        providers: join(root, 'plugin-providers.json'),
        // 插件装在 `<root>/plugins/node_modules/`，不是 `<root>/node_modules/`：
        // magpie 的 `internal/plugin/store.go:122` 是 `Dir() = <设置目录>/plugins`，
        // 而 `:392` 把包装进 `Join(Dir(), "node_modules", …)`。
        // 本机实测：`~/.config/magpie/plugins/node_modules/@magpie-community/…`。
        modules: join(root, 'plugins', 'node_modules'),
        settings: join(root, 'hub-settings.json'),
    };
}
async function readJson(file, fallback) {
    try {
        const text = await readFile(file, 'utf8');
        const parsed = JSON.parse(text);
        return parsed === null ? fallback : parsed;
    }
    catch {
        // 不存在、是目录、或 JSON 坏了：一律退回兜底，绝不抛给启动路径
        return fallback;
    }
}
/** 原子写：同目录临时文件 + rename（跨盘不适用，但这里永远同目录）。 */
async function writeJson(file, value) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
}
/** 插件清单的读 / 增 / 删 / 改。 */
export class PluginStore {
    paths;
    constructor(paths) {
        this.paths = paths;
    }
    async list() {
        const raw = await readJson(this.paths.plugins, []);
        if (Array.isArray(raw)) {
            return raw.filter((x) => typeof x === 'object' && x !== null && typeof x.spec === 'string');
        }
        // 兼容 { plugins: [...] } 形状（magpie 的 plugins.json 就是这样）
        const nested = raw?.plugins;
        if (Array.isArray(nested)) {
            return nested.filter((x) => typeof x === 'object' && x !== null && typeof x.spec === 'string');
        }
        return [];
    }
    async add(spec, options) {
        const list = await this.list();
        const at = list.findIndex((x) => x.spec === spec);
        const entry = { spec, enabled: true, ...(options === undefined ? {} : { options }) };
        if (at < 0)
            list.push(entry);
        else
            list[at] = { ...list[at], ...entry };
        await writeJson(this.paths.plugins, list);
        return list;
    }
    async remove(spec) {
        const list = (await this.list()).filter((x) => x.spec !== spec);
        await writeJson(this.paths.plugins, list);
        return list;
    }
    async setEnabled(spec, enabled) {
        const list = await this.list();
        const at = list.findIndex((x) => x.spec === spec);
        if (at >= 0)
            list[at] = { ...list[at], enabled };
        await writeJson(this.paths.plugins, list);
        return list;
    }
    /**
     * 改一个插件的运行选项（`runtime.js` 把它当第二参传给插件工厂）。
     *
     * `null` = 清空这个键，让插件按自己的缺省跑 —— 与 magpie 桌面端
     * 「Clear」按钮同义（`ui/plugins.js` 的 `act(spec, 'options', { options: null })`）。
     */
    async setOptions(spec, options) {
        const list = await this.list();
        const at = list.findIndex((x) => x.spec === spec);
        if (at >= 0) {
            const next = { ...list[at] };
            if (options === null || options === undefined)
                delete next.options;
            else
                next.options = options;
            list[at] = next;
        }
        await writeJson(this.paths.plugins, list);
        return list;
    }
}
/**
 * 本宿主自己的偏好（`hub-settings.json`）。
 *
 * 目前只有一项：桌面端「面板入口」（`sidebar` / `settings`，二选一）。
 * 与 `plugins.json` 分开放的理由见 {@link HostPaths.settings}。
 */
export class SettingsStore {
    paths;
    cache;
    constructor(paths) {
        this.paths = paths;
    }
    async all() {
        if (this.cache !== undefined)
            return this.cache;
        const raw = await readJson(this.paths.settings, {});
        this.cache = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
            ? raw
            : {};
        return this.cache;
    }
    async get(key) {
        return (await this.all())[key];
    }
    /** 写一项（读-改-写，保留其它键；原子落盘）。 */
    async set(key, value) {
        const all = await this.all();
        all[key] = value;
        await writeJson(this.paths.settings, all);
    }
}
/**
 * 登录态的读 / 写 —— magpie 的 `plugin-auth.json` 形状。
 *
 * ⚠️ key 的命名规则照抄 magpie：第一个账号存在 provider id 下，其余存
 * `<provider>#<slot>`。`accountsOf()` 按 magpie 的 `accountsOf` 实现。
 */
export class AuthStore {
    paths;
    /** 内存缓存：每次读盘太贵，而 getAuth 在每次请求前都会被调。 */
    cache;
    listeners = new Set();
    constructor(paths) {
        this.paths = paths;
    }
    onChange(fn) {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }
    changed() {
        for (const fn of this.listeners) {
            try {
                fn();
            }
            catch { /* 监听者自己的错不拖垮存储 */ }
        }
    }
    async all() {
        if (this.cache !== undefined)
            return this.cache;
        this.cache = await readJson(this.paths.auth, {});
        return this.cache;
    }
    async get(key) {
        return (await this.all())[key];
    }
    /** 整体替换一条记录（`client.auth.set` 的语义）。 */
    async set(key, body) {
        const all = { ...(await this.all()) };
        all[key] = body;
        this.cache = all;
        await writeJson(this.paths.auth, all);
        this.changed();
    }
    /** 浅合并一条记录（`auth.refresh` 返回值的语义）。 */
    async merge(key, patch) {
        const all = { ...(await this.all()) };
        const next = { ...(all[key] ?? {}), ...patch };
        all[key] = next;
        this.cache = all;
        await writeJson(this.paths.auth, all);
        this.changed();
        return next;
    }
    async remove(key) {
        const all = { ...(await this.all()) };
        delete all[key];
        this.cache = all;
        await writeJson(this.paths.auth, all);
        this.changed();
    }
    /** 测试与「外部改了文件」时用。 */
    invalidate() {
        this.cache = undefined;
    }
}
/** magpie 的 `accountsOf`：provider 自己的 key 在最前，其余 `<id>#<slot>`。 */
export function accountsOf(all, provider) {
    return Object.keys(all)
        .filter((k) => k === provider || k.startsWith(`${provider}#`))
        .sort((a, b) => (a === provider ? -1 : b === provider ? 1 : a.localeCompare(b)));
}
/**
 * magpie 的 `signInKey` 的落地：新账号放 provider 自己的 key（空着时），
 * 否则开一个 `<provider>#<slot>`。slot 取密钥指纹前 6 位（稳定、可复现）。
 */
export function freshKey(provider, taken, secret) {
    if (!taken.includes(provider))
        return provider;
    const seed = secret !== undefined && secret !== ''
        ? createHash('sha256').update(secret).digest('hex').slice(0, 6)
        : randomBytes(3).toString('hex');
    let key = `${provider}#${seed}`;
    let n = 1;
    while (taken.includes(key)) {
        key = `${provider}#${seed}${n++}`;
    }
    return key;
}
/**
 * magpie 的 `settle`：同一账号重复登录时替换旧记录，而不是新增一条。
 * 判定顺序：accountId+uid 相同 → 替换；都没有 accountId 但 secret 相同 → 替换。
 */
export function settleKey(all, provider, incoming) {
    const id = incoming.accountId;
    const uid = incoming.uid;
    for (const key of accountsOf(all, provider)) {
        const cur = all[key];
        if (cur === undefined)
            continue;
        if (id !== undefined && id !== '' && cur.accountId === id) {
            if ((uid === undefined || uid === '') || (cur.uid === undefined || cur.uid === ''))
                return key;
            if (cur.uid === uid)
                return key;
        }
    }
    if (id === undefined || id === '') {
        const secret = incoming.access ?? incoming.key;
        if (secret !== undefined && secret !== '') {
            for (const key of accountsOf(all, provider)) {
                const cur = all[key];
                if (cur === undefined)
                    continue;
                if ((cur.access ?? cur.key) === secret)
                    return key;
            }
        }
    }
    return undefined;
}
export { readJson, writeJson };
//# sourceMappingURL=store.js.map