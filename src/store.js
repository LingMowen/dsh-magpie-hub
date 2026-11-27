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
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
    /**
     * 写回 `plugins.json`。
     *
     * ⚠ **必须是 `{ plugins: [...] }`，不能是裸数组**。`list()` 两种形状都读，
     * 但 magpie 自己（`internal/plugin/store.go`）只认外层对象；写成数组后
     * magpie 打开面板会当成「没有装任何插件」，手机端也一样。
     *
     * 这是实测踩到的：`add` / `remove` / `setEnabled` / `setOptions` 以前各自
     * `writeJson(paths.plugins, list)`，只经过一次写操作文件就被写坏。
     */
    async writePlugins(list) {
        await writeJson(this.paths.plugins, { plugins: list });
        return list;
    }
    async add(spec, options) {
        const list = await this.list();
        const at = list.findIndex((x) => x.spec === spec);
        const entry = { spec, enabled: true, ...(options === undefined ? {} : { options }) };
        if (at < 0)
            list.push(entry);
        else
            list[at] = { ...list[at], ...entry };
        return this.writePlugins(list);
    }
    async remove(spec) {
        const list = (await this.list()).filter((x) => x.spec !== spec);
        return this.writePlugins(list);
    }
    async setEnabled(spec, enabled) {
        const list = await this.list();
        const at = list.findIndex((x) => x.spec === spec);
        if (at >= 0)
            list[at] = { ...list[at], enabled };
        return this.writePlugins(list);
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
        return this.writePlugins(list);
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
    /**
     * 这份缓存对应磁盘上那个文件的 mtime / size（毫秒 + 字节）。
     *
     * 桌面 magpie 与我们读的是**同一个文件**（`configRoot()` 优先命中
     * `~/.config/magpie`）。它在自己的进程里登录、刷新、删账号时直接改这个
     * JSON —— 我们这边没有写文件，所以 `cache` 会一直停在旧内容上，直到进程
     * 重启。记下 mtime + size 后，`all()` 能自己发现有别人动过。
     *
     * 用 mtime + size 而不是只看 mtime：Windows 上同一毫秒内改写（magpie 的
     * 刷新很快）会让 mtime 看起来没变，而字节数几乎一定会变。
     */
    stamp;
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
        if (this.cache !== undefined) {
            // 缓存还在，但先问一句「磁盘上那个文件还是我读的那一份吗」。
            // 有人（桌面 magpie）改过就丢掉缓存重读 —— 这是本插件与 magpie
            // 共用同一个数据根时唯一需要「同步」的地方，不加任何 watcher。
            if (await this.unchanged())
                return this.cache;
            this.cache = undefined;
        }
        const read = await readJson(this.paths.auth, {});
        this.cache = read;
        this.stamp = await this.fileStamp();
        return this.cache;
    }
    /** 磁盘上那个文件的 mtime + size；读不到（不存在/被删）时返回 undefined。 */
    async fileStamp() {
        try {
            const info = await stat(this.paths.auth);
            return {
                mtimeMs: info.mtimeMs,
                size: info.size,
            };
        }
        catch {
            return undefined;
        }
    }
    /**
     * 「我上次读完之后，没人动过这个文件」。
     *
     * 两种「没记录过」的情况都算**变过**（返回 false），宁可多读一次盘：
     * - `stamp` 是 undefined（还没读过）；
     * - 现在读不到文件但缓存里说有（文件被删了 → 该重读成空）。
     */
    async unchanged() {
        if (this.stamp === undefined)
            return false;
        const now = await this.fileStamp();
        if (now === undefined)
            return false;
        return now.mtimeMs === this.stamp.mtimeMs && now.size === this.stamp.size;
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
        // 自己刚写完：把 stamp 对齐，避免下一次 all() 又白读一遍磁盘。
        this.stamp = await this.fileStamp();
        this.changed();
    }
    /** 浅合并一条记录（`auth.refresh` 返回值的语义）。 */
    async merge(key, patch) {
        const all = { ...(await this.all()) };
        const next = { ...(all[key] ?? {}), ...patch };
        all[key] = next;
        this.cache = all;
        await writeJson(this.paths.auth, all);
        // 自己刚写完：把 stamp 对齐，避免下一次 all() 又白读一遍磁盘。
        this.stamp = await this.fileStamp();
        this.changed();
        return next;
    }
    async remove(key) {
        const all = { ...(await this.all()) };
        delete all[key];
        this.cache = all;
        await writeJson(this.paths.auth, all);
        // 自己刚写完：把 stamp 对齐，避免下一次 all() 又白读一遍磁盘。
        this.stamp = await this.fileStamp();
        this.changed();
    }
    /** 测试与「外部改了文件」时用。 */
    invalidate() {
        this.cache = undefined;
        this.stamp = undefined;
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