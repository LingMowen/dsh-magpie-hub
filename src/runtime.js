/**
 * 插件加载与运行时装配。
 *
 * magpie 的加载规则（照抄）：
 * 1. 包入口按 package.json 的 `exports["./server"]` → `main` → `exports["."]`
 *    → `index.ts`/`tsx`/`js`/`mjs`/`cjs` 顺序找；
 * 2. **导出的每个函数都被当成一个插件**（所以入口文件不许导出 helper）；
 * 3. 一个包可以有多个插件函数 → 多个 provider。
 *
 * 本宿主不做 bun 安装（不自带包管理器）：`spec` 解析成**已在磁盘上的目录**
 * 后按 Node ESM 动态 import。解析规则：
 * - 绝对路径 / `file:` → 直接用；
 * - `github:owner/repo`、npm 包名 → `<root>/node_modules/<name>`（用户自己装）；
 * - 相对路径 → 相对 `<root>`。
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
/**
 * 把一个绝对路径变成**能绕开模块缓存**的 import URL。
 *
 * ## 为什么要 cache-bust
 *
 * Node / Bun 的 ESM 会按 URL 永久缓存已求值的模块。用户改完插件代码（或
 * 重装了一个新版本）再让宿主重扫时，`import()` 会**拿回旧模块**，于是
 * 「重载了但没变化」——而且不报错，看起来像插件没生效。
 *
 * 在 URL 后面挂 `?v=<mtime>-<size>`：文件一动，URL 就变，模块重新求值。
 * 文件没动时（常态）URL 稳定，缓存照常命中，重扫几乎零成本。
 *
 * ⚠️ 只对**入口文件**做这件事。入口 import 的相对依赖仍走原有缓存 —— 这是
 * 有意的取舍：把整棵依赖树都 cache-bust 会打乱 ESM 的单例语义（React、共享
 * store 会各拿到一份新副本）。改 `src/` 里被 import 的模块通常伴随入口的
 * mtime 变化（构建产物会重新写），实测够用。
 *
 * @param absolute 入口文件的绝对路径
 * @returns 带版本参数的 file:// URL
 */
export async function hotUrl(absolute) {
    const base = pathToFileURL(absolute);
    try {
        const info = await stat(absolute);
        base.searchParams.set('v', `${Math.floor(info.mtimeMs)}-${info.size}`);
    }
    catch {
        // 拿不到 mtime（权限/删除竞态）：退回不带版本的 URL，至少不炸
    }
    return base.href;
}
/** 入口文件的候选顺序（magpie 的 findEntry）。 */
const ENTRY_NAMES = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs'];
/**
 * 列出入口候选，**按 magpie 的顺序**（`host.js` 的 `entries()` 原文）：
 * `exports["./server"]` → `main` → `exports["."]` → `exports` 字符串 → index 文件。
 *
 * ⚠️ `main` **在** `exports["."]` **之前**是必须的：社区包常把 `exports["."]`
 * 指给 OpenCode 2.x 的适配层（codearts 的 `opencode2.mjs` 导出 `setup` /
 * `pluginsOf` / `packageOf` 一堆辅助函数），真正的 1.x 插件在 `main` 里。
 * 反过来读会把适配层当插件，收获一堆「不是一个插件」的失败。
 */
async function entriesOf(dir) {
    let pkg;
    try {
        pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    }
    catch {
        pkg = undefined;
    }
    /** magpie 的 `pick`：字符串本身，或 `{import}` / `{default}`。 */
    const pick = (v) => {
        if (typeof v === 'string')
            return v.trim() === '' ? undefined : v.trim();
        if (v !== null && typeof v === 'object') {
            const o = v;
            const inner = o.import ?? o.default;
            if (typeof inner === 'string' && inner.trim() !== '')
                return inner.trim();
        }
        return undefined;
    };
    const out = [];
    const exportsField = pkg?.['exports'];
    const exMap = typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField)
        ? exportsField
        : undefined;
    if (exMap !== undefined) {
        const server = pick(exMap['./server']);
        if (server !== undefined)
            out.push(server);
    }
    const main = pick(pkg?.['main']);
    if (main !== undefined)
        out.push(main);
    if (exMap !== undefined) {
        const dot = pick(exMap['.']);
        if (dot !== undefined)
            out.push(dot);
    }
    if (typeof exportsField === 'string') {
        const bare = pick(exportsField);
        if (bare !== undefined)
            out.push(bare);
    }
    out.push(...ENTRY_NAMES);
    // 去重 + 只留真实存在的文件（magpie 的 `[...new Set(out)]` 之后由调用方探测）
    const seen = new Set();
    const files = [];
    for (const rel of out) {
        const full = resolve(dir, rel);
        if (seen.has(full))
            continue;
        seen.add(full);
        try {
            const info = await stat(full);
            if (info.isFile())
                files.push(full);
        }
        catch {
            // 不存在：跳过
        }
    }
    return files;
}
/**
 * 从 spec 里取出 `node_modules` 下的那一段目录名。
 *
 * magpie 的 `plugins.json` 里存的是**带版本的 spec**（`@magpie-community/opencode-joycode-auth@latest`），
 * 而磁盘目录只有包名。直接把带 `@latest` 的名字拼进路径必然找不到目录——
 * 这就是「10 个插件只有 1 个能装」的原因。
 *
 * 只剥**包名之后**的那个 `@`：`@scope/name@ver` 的包名是 `@scope/name`，
 * 第一个 `@` 是作用域标记，不能碰。
 */
export function moduleNameOf(spec) {
    const github = spec.startsWith('github:') ? spec.slice('github:'.length) : spec;
    if (github !== spec) {
        // github:owner/repo → repo
        return github.split('/').pop() ?? github;
    }
    const slash = spec.indexOf('/');
    // 作用域包从斜杠之后找版本分隔符；裸包名从一开始找
    const from = spec.startsWith('@') && slash > 0 ? slash : 0;
    const at = spec.indexOf('@', from);
    return at > 0 ? spec.slice(0, at) : spec;
}
/** 把 spec 变成磁盘目录。 */
async function dirOfSpec(spec, paths) {
    if (spec.startsWith('file:')) {
        const raw = spec.slice('file:'.length);
        return realpath(isAbsolute(raw) ? raw : resolve(paths.root, raw));
    }
    if (isAbsolute(spec))
        return realpath(spec);
    if (spec.startsWith('.'))
        return realpath(resolve(paths.root, spec));
    // 裸名 / github: / npm 包名：一律在宿主自己的 node_modules 下找。
    // 支持 `@scope/name` 的两段，并剥掉 `@version` 后缀。
    const name = moduleNameOf(spec);
    const candidates = [
        join(paths.modules, name),
        join(paths.modules, ...name.split('/')),
    ];
    for (const dir of candidates) {
        try {
            const info = await stat(dir);
            if (info.isDirectory())
                return realpath(dir);
        }
        catch {
            // 继续
        }
    }
    throw new Error(`没有找到插件目录：${spec}（在 ${paths.modules} 下找过）`);
}
/** 读包名（卡片标题用）。 */
async function packageNameOf(dir) {
    try {
        const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        return typeof pkg.name === 'string' ? pkg.name : '';
    }
    catch {
        return '';
    }
}
/** 从钩子里收集它声明的 provider id。 */
export function providersOf(hooks) {
    const ids = new Set();
    const many = hooks;
    const auths = [];
    const provs = [];
    const configs = [];
    // 单数形状
    if (hooks.auth !== undefined)
        auths.push(hooks.auth);
    if (hooks.provider !== undefined)
        provs.push(hooks.provider);
    if (typeof hooks.config === 'function')
        configs.push(hooks.config);
    // 复数形状（一个插件多 provider 时的数组写法）
    for (const key of ['auths', 'providers', 'configs']) {
        const v = many[key];
        if (Array.isArray(v)) {
            if (key === 'auths')
                auths.push(...v);
            else if (key === 'providers')
                provs.push(...v);
            else
                configs.push(...v);
        }
    }
    for (const a of auths) {
        const id = a?.provider;
        if (typeof id === 'string' && id !== '')
            ids.add(id);
    }
    for (const p of provs) {
        const id = p?.id;
        if (typeof id === 'string' && id !== '')
            ids.add(id);
    }
    void configs; // config 钩子里的 provider 要跑过才知道；这里只做静态收集
    return [...ids];
}
/** 判断一个导出值是不是插件工厂（magpie 把**每个函数**都当插件）。 */
function isFactory(v) {
    return typeof v === 'function';
}
/**
 * 加载一个已安装插件：解析目录 → import → 对每个导出函数调用一次，收集钩子。
 *
 * ⚠️ 加载失败**不抛**：一条坏插件不该让整个宿主起不来（用户还得能看到面板、
 * 卸载它）。失败原因进 `failed`，由面板显示。
 */
export async function loadPlugin(installed, paths, ctx) {
    const plugins = [];
    const failures = [];
    let dir;
    try {
        dir = await dirOfSpec(installed.spec, paths);
    }
    catch (e) {
        failures.push({ spec: installed.spec, error: e instanceof Error ? e.message : String(e) });
        return { plugins, failures };
    }
    const packageName = await packageNameOf(dir);
    let entries;
    try {
        entries = await entriesOf(dir);
    }
    catch (e) {
        failures.push({ spec: installed.spec, error: e instanceof Error ? e.message : String(e) });
        return { plugins, failures };
    }
    if (entries.length === 0) {
        // 目录里没有可识别的入口：把顶层列出来，方便用户看出「装的是个什么」
        let top = [];
        try {
            top = (await readdir(dir)).slice(0, 12);
        }
        catch { /* 读不到就算了 */ }
        failures.push({
            spec: installed.spec,
            error: `没有找到插件入口（找过 package.json 的 exports["./server"] / main / exports["."] 与 ${ENTRY_NAMES.join(' / ')}）；目录内容：${top.join(', ')}`,
        });
        return { plugins, failures };
    }
    // ⚠️ 逐个候选试，**不是只试第一个**：magpie 的 `entries()` 返回一串，
    // 第一个 import 成功但没有插件函数时继续下一个（codearts 就是这种情况 ——
    // `main` 是 1.x 插件、`exports["."]` 是 2.x 适配层；也有包反过来）。
    for (const entry of entries) {
        let module;
        try {
            module = await import(await hotUrl(entry));
        }
        catch (e) {
            failures.push({
                spec: installed.spec,
                error: `import 失败（${entry.slice(dir.length + 1)}）：${e instanceof Error ? e.message : String(e)}`,
            });
            continue;
        }
        // ⚠ 按**函数身份**去重：很多插件把同一个函数既具名导出又 `export default`，
        // 逐个调就会把它装两遍（同一个 provider 出现两行、账号池读两份）。
        // magpie 的 `host.js` servers() 也是按对象身份去重的（seen Set）。
        const seen = new Set();
        const exported = [];
        for (const [exportName, value] of Object.entries(module)) {
            if (!isFactory(value) || seen.has(value))
                continue;
            seen.add(value);
            exported.push([exportName, value]);
        }
        if (exported.length === 0) {
            // 这个入口只有辅助函数（2.x 适配层就是这样）：试下一个，不报错
            continue;
        }
        let found = 0;
        for (const [exportName, factory] of exported) {
            try {
                const hooks = await factory(ctx, installed.options);
                if (hooks === undefined || hooks === null || typeof hooks !== 'object') {
                    // 辅助函数被当插件调过：不算失败（magpie 也这么宽容），静默跳过
                    continue;
                }
                plugins.push({
                    spec: installed.spec,
                    packageName,
                    dir,
                    exportName,
                    providers: providersOf(hooks),
                    hooks,
                });
                found += 1;
            }
            catch (e) {
                failures.push({ spec: installed.spec, error: `导出 ${exportName} 调用失败：${e instanceof Error ? e.message : String(e)}` });
            }
        }
        // 这个入口拿到了插件就到此为止（magpie 同理：一个包只从它命中的入口取）
        if (found > 0)
            break;
    }
    if (plugins.length === 0 && !failures.some((f) => f.spec === installed.spec && f.error.includes('调用失败'))) {
        failures.push({ spec: installed.spec, error: '这个包没有导出任何插件函数（magpie 把每个导出函数当插件）' });
    }
    return { plugins, failures };
}
/** 加载全部已安装（且启用）的插件。逐个隔离失败。 */
export async function loadAll(installed, paths, ctx) {
    const loaded = [];
    const failed = [];
    for (const item of installed) {
        if (item.enabled === false)
            continue;
        const out = await loadPlugin(item, paths, ctx);
        loaded.push(...out.plugins);
        failed.push(...out.failures);
    }
    return { loaded, failed };
}
//# sourceMappingURL=runtime.js.map