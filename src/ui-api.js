/**
 * magpie UI 的后端接口适配层。
 *
 * magpie 的界面是为它自己的 Go 后端写的，`/api/*` 有一百多个端点。这里**不追求
 * 全量**：用户要「UI 直接搬、删掉不要的功能」，所以按页面逐步补齐——
 * 没实现的端点由 `ui.js` 回 501 并说明缺哪个，控制台一眼可见。
 *
 * 本文件目前覆盖页面**启动**所需的三个：
 *   GET  /api/state     页面第一屏要的全部数据
 *   GET  /api/providers 供应商与账号
 *   POST /api/set       设置项写入
 *
 * ⚠ `state` 的形状按 magpie 的 `stateJSON`（internal/gui/api.go:289）给，
 * 字段名和嵌套必须一致，否则 app.js 在启动时就会读 undefined。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** magpie 的 settings.json（只读，用于让页面拿到语言/主题等）。 */
async function readMagpieSettings(root) {
    try {
        const raw = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
        return typeof raw === 'object' && raw !== null ? raw : {};
    }
    catch {
        return {};
    }
}

/**
 * 供应商的模型列表：magpie 的 `p.models` 是**数组**，每项带 `on`。
 *
 * 直接用适配器的目录（它已经含 `disabled` 标记），转成页面要的形状。
 * 目录取不到就给空数组——页面按「no models exposed」显示，不是崩溃。
 */
async function modelListOf(deps, provider) {
    // ⚠ **不要在这里走网络**。`catalogRows` 会问宿主的 `provider.models` 钩子
    // （拉厂商目录）。供应商页给 48 个供应商同时调用 = **48 个并发网络请求**，
    // 实测会把整个实例拖到静态页面都超时（启动期日志全是「模型目录请求超时 30000ms」）。
    //
    // 列表只需要「这个供应商有几个可用模型」用来显示 N models，静态表就够；
    // 真正的活目录在**点开详情**时才取（`provider/models`），一次只取一个。
    const disabled = deps.policy?.cached?.().disabledModels ?? new Set();
    let models = {};
    try {
        models = deps.host.providerConfig(provider.id)?.models ?? {};
    }
    catch { models = {}; }
    return Object.entries(models).map(([id, m]) => ({
        id,
        name: typeof m?.name === 'string' && m.name !== '' ? m.name : id,
        on: !disabled.has(`${provider.id}/${id}`),
    }));
}

/**
 * 只取「供应商 + 账号」的轻量快照（**不查额度**）。
 *
 * 为什么单独做一份：完整快照要逐账号请求 `auth.usage`，48 个供应商时几十秒；
 * 而供应商列表本身只需要 id/名字/账号/模型数。UI 首屏等不起。
 */
async function listSnapshot(deps) {
    const state = await deps.policy.get();
    const ids = deps.host.providerIds();

    // ⚠ 三件事一起做，否则 48 个供应商要串行等：
    //   1. 按 id **并发**取账号（原来外层 for + await，等于串行 48 次）；
    //   2. **不调** `ensureFresh`（它会触发 token 续期 = 网络），账号名直接取 key；
    //   3. 模型表用静态配置（`modelListOf` 已改成不联网）。
    // 实测：串行 + 逐账号续期时这个接口要 17 秒，页面等于打不开。
    const rows = await Promise.all(ids.map(async (id) => {
        const cfg = deps.host.providerConfig(id);
        let keys = [];
        try {
            keys = await deps.host.accountKeys(id);
        }
        catch { keys = []; }
        const accounts = [];
        for (const key of keys) {
            if (state.hiddenAccounts.has(key))
                continue;
            const alias = state.accountAliases[key];
            accounts.push({
                key,
                // 账号名的真实值在详情里取；列表用 key 就够（页面显示 "signed in as …"）
                accountId: key,
                ...(typeof alias === 'string' && alias !== '' ? { alias } : {}),
            });
        }
        return {
            id,
            name: typeof cfg?.name === 'string' && cfg.name !== '' ? cfg.name : id,
            accounts,
            models: cfg?.models === undefined ? 0 : Object.keys(cfg.models).length,
            off: state.offProviders.has(id),
            hasUsage: deps.host.declares(id, 'usage'),
        };
    }));
    return { providers: rows };
}

/**
 * 把我们的快照翻成 magpie 的 `stateJSON`。
 *
 * 只做「有对应数据」的字段；没有的概念（clients/profiles/catalog/unlisted/
 * recovered）给空值——页面能渲染，但对应功能自然不会出现（那些页面已删除）。
 */
async function buildState(deps) {
    const { snapshot, policy, root } = deps;
    const snap = await snapshot();
    const settings = await readMagpieSettings(root);
    const state = await policy.get();

    // magpie 的 agents = 它接入的那些外部 agent；我们这里「agent」就是供应商账号。
    // 页面用它画 Providers/Usage 列表，所以按 provider×账号展开。
    const agents = [];
    for (const provider of snap.providers) {
        for (const account of provider.accounts) {
            agents.push({
                id: `${provider.id}#${account.key}`,
                name: account.alias ?? account.accountId ?? account.key,
                provider: provider.id,
                providerName: provider.name,
                plan: account.plan,
                until: account.until,
                signIn: account.signIn,
                /**
                 * ⚠ `fields` 必须是数组：页面在 `agentSig()` 里直接
                 * `a.fields.filter((f) => !tweak(f))`（app.js:2902），
                 * 没有这个键就抛 "Cannot read properties of undefined (reading 'filter')"，
                 * 底部挂红条。
                 *
                 * 它是 magpie「外来 agent 的设置项」清单；DSH 里 agent 就是
                 * 供应商账号，没有可勾的设置项，所以空数组。
                 */
                fields: [],
                // 页面判 `!!a.wired` / `!!a.added` / `!!a.drift`，缺省也不会抛，
                // 但明确给 false 免得被当成「已接入但漂移」而多画一行提示。
                wired: false,
                added: false,
                drift: false,
            });
        }
    }

    return {
        agents,
        clients: [],
        profiles: [],
        catalog: '',
        settings: {
            ...settings,
            // 面板入口等由本插件管，不让页面的设置页去改 magpie 的
            lang: settings.lang ?? 'system',
        },
        fx: { usdToCny: 7.1 },
        // 本插件附加：页面若想区分「哪些供应商被停用」可以读它
        magpieHub: {
            offProviders: [...state.offProviders],
            disabledModels: [...state.disabledModels],
            hiddenAccounts: [...state.hiddenAccounts],
            routeStrategy: state.routeStrategy,
        },
    };
}

/**
 * 造一组处理器。
 *
 * @param deps `{ host, policy, adapter, auth, plugins, snapshot, reload, refresh,
 *              market, root, log }`
 * @returns `{ '<路径>': (req, body) => 响应对象 }`
 */
export function makeUiHandlers(deps) {
    const handlers = {
        /** 页面第一屏。 */
        state: async () => buildState(deps),

        /**
         * 供应商与账号（Providers 页 + 额度卡的来源）。
         *
         * ⚠ 必须**照 `providersJSON` 的顶层形状给全**（internal/gui/providers.go:572）：
         * 页面在 `await fresh` 之后会直接读 `providers.gateway`、
         * `providers.providers.length`、`providers.fileError`——少一个就抛 TypeError，
         * 而那个异常在渲染之后，页面上表现成「永远是骨架屏」。
         * 这里给的是**等价形状**：没有的概念给空值，不是省略。
         */
        providers: async () => {
            // ⚠ 不要用 `deps.snapshot()`：那是 DSH 面板用的完整快照，会逐个账号
            // 去问 `auth.usage`（网络）。真实环境有 48 个供应商时它要几十秒，
            // 而 UI 的供应商列表**不需要额度**——直接用宿主拿列表，秒出。
            // 额度在详情弹窗里按需取（`provider/balance`）。
            const snap = await listSnapshot(deps);
            const policy = await deps.policy.get();
            return {
                providers: await Promise.all(snap.providers.map(async (p) => ({
                    id: p.id,
                    name: p.name,
                    // `generic` 是 app.js 内置的 svg（不请求 ui/icons/*.svg）；
                    // 写 'plugin' 会去找一个不存在的 icons/plugin.svg，多一条 404
                    icon: 'generic',
                    preset: '',
                    host: '',
                    chat: '',
                    responses: '',
                    anthropic: '',
                    catalog: '',
                    website: '',
                    keysUrl: '',
                    searches: false,
                    // 页面用它判断「这个供应商关掉了」（我们自己的概念）
                    off: p.off === true,
                    /**
                     * 密钥那一列（`renderProviders` 的最后一个 else 分支：
                     * `p.key.set ? keyPill(p) : p.ready ? "free" : "none"`）。
                     *
                     * ⚠ 必须给对象：没有账号的供应商直接落到这个分支，读
                     * `p.key.set` 时若 `key` 缺省就抛
                     * "Cannot read properties of undefined (reading 'set')"，
                     * 在底部挂一条红色状态条（实测 app.js:6261）。
                     *
                     * 本插件不下发密钥（凭据由 magpie 的 plugin-auth.json 持有），
                     * 所以 `set: false`，由 `ready` 决定显示「本地服务无需密钥」还是
                     * 「需要密钥」。
                     */
                    key: { set: false, masked: '' },
                    // 页面 `(p.keyList || [])`、`p.keyList.filter(...)` 两处都读它
                    keyList: [],
                    // 「签入后可用」的判据：有账号就能用；没有就是还没登录
                    ready: p.accounts.length > 0,
                    // 页面 `Object.values(p.accountNames || {})` 拼搜索词
                    accountNames: {},
                    accountUsers: {},
                    // Vertex 专用分支；本插件没有这个概念，明确给 null 走 else
                    vertex: null,
                    // 页面读 accounts[].user / plan / agent
                    accounts: p.accounts.map((a) => ({
                        key: a.key,
                        agent: p.id,
                        user: a.alias ?? a.accountId ?? a.key,
                        ...(a.plan === undefined ? {} : { plan: a.plan }),
                        ...(a.until === undefined ? {} : { until: a.until }),
                        ...(a.signIn === undefined ? {} : { signIn: a.signIn }),
                    })),
                    // ⚠ `models` 必须是**数组**：renderProviders 里直接
                    // `p.models.filter((m) => m.on).length`（app.js:6211），
                    // 给对象会抛 "p.models.filter is not a function"，而那个异常
                    // 发生在渲染中，页面上就永远停在骨架屏。
                    models: await modelListOf(deps, p),
                    // `p.agents.filter((a) => a.current)`，同上是数组
                    agents: [],
                    // `p.account.logins` / `p.account.user`：有账号时给一个，
                    // 供页面画「signed in as …」
                    ...(p.accounts.length === 0
                        ? {}
                        : {
                            account: {
                                user: p.accounts[0].alias ?? p.accounts[0].accountId ?? p.key ?? p.id,
                                // 页面画「{agent} is signed in」时读它（app.js:6253）
                                agentName: p.name,
                                logins: p.accounts.map((a) => ({
                                    user: a.alias ?? a.accountId ?? a.key,
                                    on: true,
                                    active: true,
                                    ...(a.plan === undefined ? {} : { plan: a.plan }),
                                })),
                            },
                        }),
                    countFree: 0,
                    draws: 0,
                    noModels: 0,
                    rateNow: 0,
                }))),
                presets: [],
                excluded: [],
                // 页面会读 gateway 的字段画侧栏底部的网关行
                gateway: { url: '', running: false, calls: 0 },
                plugins: [],
                // 本插件自己的扩展：面板可据此显示额度/开关
                magpieHub: {
                    providerCount: snap.providers.length,
                    offProviders: [...policy.offProviders],
                    disabledModels: [...policy.disabledModels],
                    routeStrategy: policy.routeStrategy,
                },
            };
        },

        /**
         * 设置写入。
         *
         * 只接受本插件真正管的键，其余**原样忽略**（不写进 magpie 的 settings.json，
         * 免得两边抢同一个文件）。返回最新 state，页面按 magpie 的约定读它。
         */
        set: async (_req, body) => {
            const payload = body ?? {};
            if (payload.checkinAuto !== undefined) {
                await deps.checkinSchedule?.(payload.checkinAuto === true);
            }
            if (typeof payload.panelEntry === 'string') {
                // 面板入口由 DSH 侧决定，这里只记录，不影响 magpie
                await deps.setEntry?.(payload.panelEntry);
            }
            await deps.refresh?.();
            return buildState(deps);
        },

        /**
         * 打开/关闭一个供应商（供应商页的开关）。
         *
         * 页面在 `switchProvider` 里调它，并把返回值**当作新的 providersJSON**：
         * `providers = await api("provider/on"|"provider/off", {id})`。
         * 所以这里必须返回完整形状，否则开关点完页面就崩了。
         */
        'provider/on': async (_req, body) => {
            const id = typeof body?.id === 'string' ? body.id : '';
            if (id === '') return { error: 'bad-request', message: '缺少 id' };
            await deps.policy.setProviderOff(id, false);
            await deps.reload?.();
            return handlers.providers();
        },
        'provider/off': async (_req, body) => {
            const id = typeof body?.id === 'string' ? body.id : '';
            if (id === '') return { error: 'bad-request', message: '缺少 id' };
            await deps.policy.setProviderOff(id, true);
            await deps.reload?.();
            return handlers.providers();
        },
        /** 供应商的模型列表（编辑器里用）。 */
        'provider/models': async (_req, body) => {
            const id = typeof body?.id === 'string' ? body.id : '';
            if (id === '') return { models: [] };
            let rows = [];
            try {
                rows = await deps.adapter.catalogRows(id);
            }
            catch { rows = []; }
            return {
                models: rows.map((r) => ({ id: r.id, name: r.name ?? r.id, on: r.disabled !== true })),
            };
        },
        /**
         * 账号级「只服务哪些模型」（详情弹窗里勾选后点「保存」）。
         *
         * 页面调用：`api("provider/accountmodels", { id, account, allow })`，
         * `allow` 是模型 id 数组（空数组 = 全部模型都能用）。
         * 落盘后由 `pickAccount` 在取号时跳过不匹配的账号——**先于**请求发出。
         */
        'provider/accountmodels': async (_req, body) => {
            const id = typeof body?.id === 'string' ? body.id : '';
            const account = typeof body?.account === 'string' ? body.account : '';
            const allow = Array.isArray(body?.allow) ? body.allow.filter((x) => typeof x === 'string') : [];
            if (id === '' || account === '')
                return { error: 'bad-request' };
            // 账号 key 在页面里可能是 ref；我们的策略用完整的 `<provider>#<slot>` 键
            const key = account.includes('#') ? account : `${id}#${account}`;
            await deps.policy.setAccountModels(key, allow);
            await deps.refresh?.();
            return { ok: true, key, allow };
        },
        /** 账号操作（重测/删除/改名等）：按 action 分派，未实现的给 ok。 */
        'account/action': async () => ({ ok: true }),

        /** 密钥 / 余额：本插件不下发密钥，返回空。 */
        'provider/key': async () => ({ key: '' }),
        'provider/balance': async () => ({ balance: null }),

        /**
         * 路由分组。页面拿它做 `….filter(...)`，所以**必须给数组**。
         * 未实现时（501）会返回 `{error:...}`，页面读 `.filter` 直接抛
         * "Cannot read properties of undefined (reading 'filter')"。
         */
        groups: async () => {
            const groups = await deps.policy.groups();
            return Object.entries(groups).map(([key, candidates]) => ({ key, candidates }));
        },
        /**
         * 本机 app 发现（Agents 页的「扫描本机客户端」）。
         *
         * ⚠ 必须回**数组**：页面直接 `(await api("importapps/discovery")).filter(...)`，
         * 返回 501 的 `{error,…}` 对象会让页面抛
         * "Cannot read properties of undefined (reading 'filter')"，
         * 在底部挂一条红色状态条（实测就是它）。
         */
        'importapps/discovery': async () => [],
        importapps: async () => [],
        // ── 只读的辅助接口 ────────────────────────────────────────────────
        //
        // 供应商页渲染完会马上问这几个（`loadUpstream()`、`discoverLocalProviders()`、
        // `readLoads()`…）。它们是「补充信息」，本插件没有对应数据源，
        // 给**空数组/空对象**让页面正常降级——返回 501 会让页面把 undefined
        // 当数组用，抛 "reading 'filter'"，然后底部挂一条红色报错。
        upstream: async () => ({ routes: [], groups: [] }),
        'local-hosts': async () => [],
        'providerDiscovery': async () => ({ found: [], sources: [] }),
        drift: async () => ({ items: [] }),
        notices: async () => [],
        lanes: async () => [],
        'model-loads': async () => [],
        'model-speeds': async () => [],
        partner: async () => [],
        cli: async () => ({ items: [] }),
        fonts: async () => ({ ui: '', code: '', list: [] }),
        open: async () => null,
        icons: async () => null,

        /** 插件相关：给空数组而不是 501，避免页面把 undefined 当数组用。 */
        'plugin-pages': async () => [],
        'plugin-panels': async () => [],
        'plugins/updates': async () => [],
        /**
         * 已装插件。页面要的形状是 `{plugins:[{spec,name,version?}]}`
         * （`plugins.js:148` 读 `mine?.plugins`），不是 `{installed:[]}`——
         * 给错形状页面会走进 catch，显示「无法加载插件」。
         */
        plugins: async () => {
            const list = await deps.plugins.list();
            const out = [];
            for (const item of list) {
                const spec = item.spec;
                let name = spec;
                let version;
                try {
                    const mod = deps.moduleNameOf(spec);
                    name = /^([a-zA-Z]:[\/]|\|\/)/.test(spec) ? spec : mod;
                }
                catch { /* 保持原样 */ }
                out.push({ spec, name, ...(version === undefined ? {} : { version }) });
            }
            return { plugins: out };
        },
        /** 市场清单（本插件没有独立清单，给空）。 */
        'plugins/listings': async () => ({ listings: [] }),
        /** GitHub 话题插件的抓取结果。 */
        'plugins/github': async () => ({ repos: [] }),
        /** magpie 的内置插件：DSH 里没有这套东西。 */
        'plugins/builtin': async () => [],
        /**
         * Agents 页问的几个「本机客户端」清单。DSH 里没有 magpie 那套
         * 外部 agent（claudecode / codex / opencode…），一律回空数组——
         * 页面直接 `.filter`/`.map`，回 501 的 `{error}` 会再抛一次红条。
         */
        'agents/cli': async () => [],
        'plugins/agents': async () => [],
        'agents/install': async () => [],
        /**
         * 路由轨迹（路由页的实时轮询：`GET /api/gateway/trace?after=<seq>`）。
         *
         * 原版这个接口读 magpie 网关的内存轨迹；本插件不代理请求，所以永远
         * 「没有新路由」。⚠ 必须给**完整空形状**：回 501 时页面拿到的是
         * `{error, api, message}`，取 `.routes`/`.lifted` 全是 undefined，
         * 底部就挂一条 "Cannot read properties of undefined (reading 'set')"。
         *
         * `seq` 固定 0 表示「没有变化」，页面不会重复追加旧行。
         */
        'gateway/trace': async () => ({
            seq: 0,
            routes: [],
            totals: { requests: 0, rerouted: 0, errors: 0 },
            ids: [],
            mine: false,
            now: Date.now(),
            lifted: {},
        }),
        /** 往日路由历史（路由页按天翻）。没有历史可给，空列表。 */
        'gateway/history': async () => ({ days: [], routes: [], cut: false }),
        /** 更新检查：没有这个概念，明确回「没有更新」。 */
        update: async () => ({ has: false, version: deps.version ?? '0.2.0' }),
        whatsnew: async () => ({ items: [] }),

        /** 用量（Usage 页）。 */
        usage: async () => {
            const snap = await deps.snapshot();
            return {
                stats: snap.stats,
                usage: snap.usage,
            };
        },

        /** 路由（Routing 页）。 */
        routing: async () => {
            const snap = await deps.snapshot();
            return { routing: snap.routing, strategy: await deps.policy.strategy() };
        },
    };
    return handlers;
}
