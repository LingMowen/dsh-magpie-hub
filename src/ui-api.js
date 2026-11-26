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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_EXT, CorruptBackupError, NotBackupError, PassphraseError, applyAccounts, collectAccounts, open as openBackup, seal } from './backup.js';

/**
 * 导出文件落地的目录：用户的「下载」文件夹。
 *
 * 与 magpie 的 `downloads()` 同一个地方 —— 桌面用户在文件管理器里点一下就能拿到，
 * 不用去翻插件的私有目录。目录不存在时建一个（某些精简过的 Windows 镜像没有）。
 */
async function downloadsDir() {
    const dir = join(homedir(), 'Downloads');
    await mkdir(dir, { recursive: true }).catch(() => { });
    return dir;
}

/**
 * 把解封失败的三种原因翻成三句不同的话。
 *
 * 页面只显示 `error.message`，所以这里直接给中文；三句必须能区分开——
 * 「口令错了」「这不是备份文件」「文件坏了」对应三种完全不同的下一步动作
 * （重输口令 / 换文件 / 重新导出），混成一句用户就无从下手。
 */
function importFailure(e) {
    if (e instanceof PassphraseError)
        return "口令不对：这个文件是用另一个口令加密的";
    if (e instanceof NotBackupError)
        return "这不是 magpie 的备份文件";
    if (e instanceof CorruptBackupError)
        return "备份文件已损坏，请重新导出一份";
    return e instanceof Error ? e.message : String(e);
}

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
 * 原子写一个 JSON 文件：先写同目录的临时文件再 `rename`。
 *
 * 直接 `writeFile` 到目标文件时，进程在写一半退出会留下半个 JSON，
 * 下次 magpie 读它就是 `SyntaxError`（设置全丢）。`rename` 在同一分区内
 * 是原子的，所以要么是旧内容、要么是新内容。
 */
async function writeAtomic(file, value) {
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
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
                // 签到字段：额度卡的签到行读它（不联网，直接取内存里最后一次结果）
                ...(deps.host.declares(id, 'checkin')
                    ? {
                        checkins: true,
                        checkinBy: `plugin:${id}`,
                        checkinKey: key,
                        ...(typeof deps.lastCheckin === 'function' && deps.lastCheckin(key) !== undefined
                            ? { checkin: deps.lastCheckin(key) }
                            : {}),
                    }
                    : {}),
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
    // 首屏就要带签到字段：设置页的「预热」段与额度卡的签到行都从 `settings` 读
    // （`renderPluginCheckins` / `checkinRow`），少一个就整段不画。
    const settings = await settingsWithCheckin(deps);
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

/** 北京的「今天」（与上游 `wbToday()` 一致：UTC+8 切日，厂商以此为准）。 */
function beijingDay(now = Date.now()) {
    return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 账号清单（账号 key → `{provider, user, checkin}`）。
 *
 * 只读宿主已装载的东西，**不联网**：桌面额度页要秒开（48 个供应商时逐账号
 * `ensureFresh` 会触发 token 续期，那接口要十几秒）。
 */
async function accountIndex(deps) {
    const out = new Map();
    for (const id of deps.host.providerIds()) {
        if (!deps.host.declares(id, 'checkin'))
            continue;
        let keys = [];
        try {
            keys = await deps.host.accountKeys(id);
        }
        catch { keys = []; }
        for (const key of keys) {
            const last = typeof deps.lastCheckin === 'function' ? deps.lastCheckin(key) : undefined;
            out.set(key, { provider: id, user: key, ...(last === undefined ? {} : { checkin: last }) });
        }
    }
    return out;
}

/**
 * 「额度卡」（`plugins/usage/page.js` 读的形状）。
 *
 * 页面按 `q.checkinBy` / `q.checkinKey` / `q.checkin` / `q.checkins` 画签到行，
 * 按 `q.checkinOff` 画「这个账号被排除」，所以这五个字段必须给全。
 * `from` 是「额度来自别处」的标记，这里恒 false。
 */
/**
 * 把一次调用记录翻成 magpie ledger 的一行。
 *
 * 上游 `usage/requests` 的行形状很大（ttft/first/pricing/served/wire…），
 * 页面只对**存在的**字段做渲染，缺字段不会抛。所以这里只给真实有的：
 * 供应商、模型、账号、时间、耗时、token、费用、成败。数字缺的给 0 ——
 * `usageSum()` 只对数字求和，给 0 等价于「没有」，不会污染合计。
 */
function ledgerRow(row, nameOf) {
    const provider = typeof row.provider === 'string' ? row.provider : '';
    const ok = row.status !== 'error';
    const tokens = typeof row.tokens === 'number' ? row.tokens : 0;
    const cost = typeof row.cost === 'number' ? row.cost : undefined;
    return {
        t: row.at,
        provider,
        // records 里没有显示名，从 deps.providerName 补；拿不到才退回 id
        providerName: row.providerName ?? (typeof nameOf === 'function' ? nameOf(provider) : provider),
        model: row.model ?? '',
        agent: row.accountKey ?? '',
        status: ok ? 'ok' : 'error',
        ...(ok ? {} : { err: row.error ?? '' }),
        ms: typeof row.ms === 'number' ? row.ms : 0,
        // `in` 是输入 token、`out` 是输出，两个都没有时把总量放 `in`，
        // 页面按 `in + out` 显示会翻倍，所以只在有细分时拆。
        ...(typeof row.inputTokens === 'number' && typeof row.outputTokens === 'number'
            ? { in: row.inputTokens, out: row.outputTokens, cache: row.cacheReadTokens ?? 0 }
            : { in: tokens, out: 0 }),
        tokens,
        ...(cost === undefined ? {} : { priced: cost }),
        // 上游用 `first` 标「这次是新会话的第一条」，我们没有这个概念
        first: false,
        canceled: false,
        ...(typeof row.sessionID === 'string' && row.sessionID !== '' ? { session: row.sessionID } : {}),
    };
}

/** 周期 → 毫秒窗（与 `index.js` 的 `windowMs` 同口径；`all` 无上限）。 */
function windowOf(period, now = Date.now()) {
    const day = 24 * 60 * 60_000;
    if (period === 'today') {
        // 「今天」按北京时间切日，与签到、面板一致
        const shanghai = new Date(now + 8 * 3_600_000);
        shanghai.setUTCHours(0, 0, 0, 0);
        return now - (shanghai.getTime() - 8 * 3_600_000);
    }
    if (period === '7d')
        return 7 * day;
    if (period === '30d')
        return 30 * day;
    return undefined;
}

/** 北京时间 `YYYY-MM-DD`。 */
function beijingDate(at) {
    return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 把过滤条件应用到一行记录上（`usage/requests` 的 query 与面板筛选同义）。 */
function keepRow(row, query) {
    const pick = (k) => (typeof query.get(k) === 'string' && query.get(k) !== '' ? query.get(k) : undefined);
    const provider = pick('provider');
    if (provider !== undefined && row.provider !== provider)
        return false;
    const agent = pick('agent');
    if (agent !== undefined && row.accountKey !== agent)
        return false;
    const model = pick('model');
    if (model !== undefined && row.model !== model)
        return false;
    if (query.get('failed') === '1' && row.status !== 'error')
        return false;
    const day = pick('day');
    if (day !== undefined && beijingDate(row.at) !== day)
        return false;
    const q = pick('q');
    if (q !== undefined) {
        const needle = q.toLowerCase();
        const hay = `${row.provider ?? ''} ${row.model ?? ''} ${row.accountKey ?? ''}`.toLowerCase();
        if (!hay.includes(needle))
            return false;
    }
    return true;
}

/**
 * 从 `deps.usageRows()` 取行并压成 ledger。
 *
 * `deps.usageRows` 由 `index.js` 提供（读的是 adapter 写进去的 `records`），
 * 拿不到就当空 —— 页面会显示「这个时段没有请求」，而不是报错。
 */
function ledgerOf(deps, query) {
    const all = typeof deps.usageRows === 'function' ? deps.usageRows() : [];
    const rows = Array.isArray(all) ? all : [];
    const period = query.get('period') ?? 'today';
    const span = windowOf(period);
    const now = Date.now();
    const from = span === undefined ? undefined : now - span;
    const kept = rows
        .filter((r) => (from === undefined ? true : (typeof r.at === 'number' && r.at >= from)))
        .filter((r) => keepRow(r, query));
    // 按时间从新到旧（页面把第一页当「最近」）
    kept.sort((a, b) => (typeof b.at === 'number' ? b.at : 0) - (typeof a.at === 'number' ? a.at : 0));
    const offset = Number.parseInt(query.get('offset') ?? '0', 10) || 0;
    const limitRaw = Number.parseInt(query.get('limit') ?? '100', 10) || 100;
    const limit = Math.max(1, Math.min(500, limitRaw));
    const page = kept.slice(offset, offset + limit);
    let tokens = 0;
    let calls = 0;
    let errors = 0;
    let cost = 0;
    let unpriced = 0;
    // 表头合计分四列（`page.js:1617` 读 `l.input` / `l.output` /
    // `l.cache_read` / `l.cache_write`），少一个就是 NaN。
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    for (const r of kept) {
        calls += 1;
        tokens += typeof r.tokens === 'number' ? r.tokens : 0;
        input += typeof r.inputTokens === 'number' ? r.inputTokens : 0;
        output += typeof r.outputTokens === 'number' ? r.outputTokens : 0;
        cacheRead += typeof r.cacheReadTokens === 'number' ? r.cacheReadTokens : 0;
        cacheWrite += typeof r.cacheWriteTokens === 'number' ? r.cacheWriteTokens : 0;
        if (r.status === 'error')
            errors += 1;
        if (typeof r.cost === 'number')
            cost += r.cost;
        else
            unpriced += 1;
    }
    return {
        rows: page.map((r) => ledgerRow(r, deps.providerName)),
        total: kept.length,
        offset,
        calls,
        errors,
        tokens,
        input,
        output,
        // 页面的键名是下划线（magpie 的 JSON 风格），不是驼峰
        cache_read: cacheRead,
        cache_write: cacheWrite,
        cost,
        unpriced,
        // 页面按 `series` 画折线：`{label, tokens, calls, cost, by}`，
        // `by` 的键是「按什么分」（agent/provider/model），值是该键的数值。
        series: ledgerSeries(kept, period),
        chartBy: 'provider',
        day: period === 'today' ? beijingDate(now) : undefined,
        // 这些是上游有的分面计数；我们没有对应概念，给空数组让页面不画筛选行。
        agents: [],
        callerKeys: [],
    };
}

/** 把记录按时间桶聚成折线序列（今天按小时，其余按天）。 */
function ledgerSeries(rows, period) {
    const hourly = period === 'today';
    const buckets = new Map();
    for (const r of rows) {
        const d = new Date((typeof r.at === 'number' ? r.at : 0) + 8 * 3_600_000);
        const label = hourly
            ? `${String(d.getUTCHours()).padStart(2, '0')}:00`
            : `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        const bucket = buckets.get(label) ?? { tokens: 0, calls: 0, cost: 0, by: {} };
        const tokens = typeof r.tokens === 'number' ? r.tokens : 0;
        bucket.tokens += tokens;
        bucket.calls += 1;
        bucket.cost += typeof r.cost === 'number' ? r.cost : 0;
        const key = typeof r.provider === 'string' ? r.provider : '';
        bucket.by[key] = (bucket.by[key] ?? 0) + tokens;
        buckets.set(label, bucket);
    }
    return [...buckets.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([label, b]) => ({ label, tokens: b.tokens, calls: b.calls, cost: b.cost, by: b.by }));
}

/**
 * 热力图：`{from, to, days:[{date, calls, tokens, cost}]}`。
 *
 * 页面用 `from`/`to` 建日历网格、用 `days` 填格子，**日期必须连续**
 * （它自己会补齐缺的日期，所以这里只给有数据的天也行；但给全更省事）。
 */
function heatmapOf(deps, query) {
    const all = typeof deps.usageRows === 'function' ? deps.usageRows() : [];
    const rows = Array.isArray(all) ? all : [];
    const now = Date.now();
    const byDay = new Map();
    for (const r of rows) {
        if (typeof r.at !== 'number')
            continue;
        const date = beijingDate(r.at);
        const cell = byDay.get(date) ?? { date, calls: 0, tokens: 0, cost: 0 };
        cell.calls += 1;
        cell.tokens += typeof r.tokens === 'number' ? r.tokens : 0;
        cell.cost += typeof r.cost === 'number' ? r.cost : 0;
        byDay.set(date, cell);
    }
    // 窗口与请求里的 period 无关：热力图固定看最近 90 天（上游也是固定一段）
    const days = 90;
    const to = beijingDate(now);
    const from = beijingDate(now - (days - 1) * 24 * 60 * 60_000);
    const out = [];
    for (let i = 0; i < days; i += 1) {
        const date = beijingDate(now - (days - 1 - i) * 24 * 60 * 60_000);
        out.push(byDay.get(date) ?? { date, calls: 0, tokens: 0, cost: 0 });
    }
    void query;
    return { from, to, days: out };
}

/**
 * `usage/arrange` 的写入口：把页面传来的排布/隐藏/归并偏好写进 magpie 的
 * `settings.json`，再回这几个键的最新值。
 *
 * 页面每次写完都用返回值覆盖自己的 `state.settings`，所以**必须回全**这几个
 * 键（哪怕这次没改），否则刚设的值会被 `undefined` 冲掉。
 */
async function arrangeUsage(deps, body) {
    const root = deps.root;
    const file = join(root, 'settings.json');
    let prefs = {};
    try {
        const raw = JSON.parse(await readFile(file, 'utf8'));
        if (typeof raw === 'object' && raw !== null)
            prefs = raw;
    }
    catch {
        // 没有 settings.json：从空开始
    }
    if (Array.isArray(body?.order))
        prefs.usageOrder = body.order.filter((k) => typeof k === 'string');
    if (Array.isArray(body?.panelHidden))
        prefs.panelUsageHidden = body.panelHidden.filter((k) => typeof k === 'string');
    if (Array.isArray(body?.agentsHidden))
        prefs.usageAgentsHidden = body.agentsHidden.filter((k) => typeof k === 'string');
    if (typeof body?.count === 'object' && body.count !== null) {
        const { client, as } = body.count;
        if (typeof client === 'string') {
            const table = typeof prefs.clientAgents === 'object' && prefs.clientAgents !== null ? { ...prefs.clientAgents } : {};
            if (typeof as === 'string' && as !== '')
                table[client] = as;
            else
                delete table[client];
            prefs.clientAgents = table;
        }
    }
    await writeAtomic(file, prefs);
    return {
        usageOrder: Array.isArray(prefs.usageOrder) ? prefs.usageOrder : [],
        panelUsageHidden: Array.isArray(prefs.panelUsageHidden) ? prefs.panelUsageHidden : [],
        usageAgentsHidden: Array.isArray(prefs.usageAgentsHidden) ? prefs.usageAgentsHidden : [],
        clientAgents: typeof prefs.clientAgents === 'object' && prefs.clientAgents !== null ? prefs.clientAgents : {},
    };
}
async function checkinCards(deps) {
    const idx = await accountIndex(deps);
    const prefs = await readMagpieSettings(deps.root);
    const off = Array.isArray(prefs?.checkinOffAccounts) ? prefs.checkinOffAccounts : [];
    const today = beijingDay();
    const cards = [];
    for (const [key, info] of idx) {
        const r = info.checkin;
        // 与上游 `checkinDue`（app.js:18669）同义：今天已经有结果、且不是
        // failed、且不是「again」（厂商日还没翻）就算签过了。
        const due = !(r !== undefined && r.day === today && r.outcome !== 'failed' && r.again !== true && r.outcome !== 'inactive');
        cards.push({
            key,
            accountId: key,
            user: info.user,
            checkins: true,
            checkinBy: `plugin:${info.provider}`,
            checkinKey: key,
            checkinOff: off.includes(key),
            checkinDue: due,
            ...(r === undefined ? {} : { checkin: r }),
            from: false,
        });
    }
    return cards;
}

/**
 * 把签到相关字段并进 settings 响应。
 *
 * 桌面设置页的「预热」段与额度卡的签到行都从 `state.settings` 读，形状见
 * `renderPluginCheckins`（app.js:22947）：
 *   checkinPlugins  [{id, name, on, checkins:[{user, day, outcome, credit, streak, again, by}]}]
 *   checkinAccounts [{key, by, user, on}]
 *   checkinAt       "" | "HH:MM"（空串＝每个厂商日一到就签）
 */
async function settingsWithCheckin(deps, prefs) {
    const raw = prefs === undefined ? await readMagpieSettings(deps.root) : prefs;
    const idx = await accountIndex(deps);
    const globalOn = raw?.pluginCheckins !== null && typeof raw?.pluginCheckins === 'object' && !Array.isArray(raw.pluginCheckins)
        ? raw.pluginCheckins
        : {};
    const off = Array.isArray(raw?.checkinOffAccounts) ? raw.checkinOffAccounts : [];

    // 每个「会签到」的插件一行
    const byProvider = new Map();
    for (const [key, info] of idx) {
        const rows = byProvider.get(info.provider) ?? [];
        rows.push({ key, user: info.user, checkin: info.checkin });
        byProvider.set(info.provider, rows);
    }
    const checkinPlugins = [...byProvider].map(([id, rows]) => ({
        id,
        name: typeof deps.providerName === 'function' ? deps.providerName(id) : id,
        on: globalOn[id] === true,
        checkins: rows
            .filter((row) => row.checkin !== undefined)
            .map((row) => ({
                user: row.user,
                ...row.checkin,
                by: row.checkin?.by ?? `plugin:${id}`,
            })),
    }));

    const checkinAccounts = [...idx].map(([key, info]) => ({
        key,
        by: `plugin:${info.provider}`,
        user: info.user,
        on: !off.includes(key),
    }));

    return {
        ...raw,
        checkinPlugins,
        checkinAccounts,
        checkinAt: typeof raw?.checkinAt === 'string' ? raw.checkinAt : '',
    };
}

/**
 * 造一组处理器。
 *
 * @param deps `{ host, policy, adapter, auth, plugins, snapshot, reload, refresh,
 *              market, root, log }`
 * @returns `{ '<路径>': (req, body) => 响应对象 }`
 */
/**
 * 额度卡数组（`usage/quotas` 的返回形状）。
 *
 * 页面用到的字段（`renderQuotas`，app.js:15600–16560）：`provider`（平台 id）、
 * `user`、`plan`、`balance`、`windows`（`[{name, used, limit, amount, unit, resetsAt,
 * display}]`）、`error`、`checkins`/`checkinBy`/`checkinKey`/`checkin`/`checkinOff`。
 * 全靠 `snapshot()` 里的 `usage` 拼 —— 那是宿主已经按账号问过 `auth.usage` 的结果。
 */
async function quotaCards(deps) {
    const snap = await deps.snapshot();
    const prefs = await readMagpieSettings(deps.root);
    const off = Array.isArray(prefs?.checkinOffAccounts) ? prefs.checkinOffAccounts : [];
    const today = beijingDay();
    const cards = [];
    for (const item of Array.isArray(snap?.usage) ? snap.usage : []) {
        const provider = typeof item.provider === 'string' ? item.provider : '';
        const key = typeof item.accountKey === 'string' ? item.accountKey : '';
        const r = typeof deps.lastCheckin === 'function' ? deps.lastCheckin(key) : undefined;
        const due = !(r !== undefined && r.day === today && r.outcome !== 'failed' && r.again !== true && r.outcome !== 'inactive');
        const canCheckin = typeof deps.host?.declares === 'function' ? deps.host.declares(provider, 'checkin') : false;
        cards.push({
            key,
            provider,
            providerName: typeof deps.providerName === 'function' ? deps.providerName(provider) : provider,
            user: typeof item.user === 'string' ? item.user : key,
            ...(typeof item.plan === 'string' ? { plan: item.plan } : {}),
            ...(item.balance === undefined ? {} : { balance: item.balance }),
            ...(item.until === undefined ? {} : { until: item.until }),
            windows: Array.isArray(item.windows) ? item.windows : [],
            ...(typeof item.error === 'string' ? { error: item.error } : {}),
            ...(canCheckin
                ? {
                    checkins: true,
                    checkinBy: `plugin:${provider}`,
                    checkinKey: key,
                    checkinOff: off.includes(key),
                    checkinDue: due,
                    ...(r === undefined ? {} : { checkin: r }),
                }
                : {}),
            from: false,
        });
    }
    return cards;
}
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
            // 「被单独排除出每日签到」的账号（设置页里逐账号关掉的）
            const prefs0 = await readMagpieSettings(deps.root);
            const offAccounts = Array.isArray(prefs0?.checkinOffAccounts) ? prefs0.checkinOffAccounts : [];
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
                        // 签到：额度卡的每一行按这四个字段决定画什么
                        // （app.js:18669 checkinDue / 18567 checkinRow）
                        ...(a.checkins === true
                            ? {
                                checkins: true,
                                checkinBy: a.checkinBy,
                                checkinKey: a.checkinKey,
                                checkinOff: offAccounts.includes(a.key),
                                ...(a.checkin === undefined ? {} : { checkin: a.checkin }),
                            }
                            : {}),
                        from: false,
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
        // 页面要的是**数组**（`Array.isArray(list)` 否则抛 invalid font collection），
        // 给 `{ui, code, list}` 会被当成非法、那一行显示「无法读取已安装字体」。
        fonts: async () => [],
        /**
         * 额度卡（Usage › 额度）。
         *
         * 页面要一个**数组**（`Array.isArray(q)`，否则当成「读取失败」保留旧值），
         * 每项是一张卡（provider / user / windows / plan 等）。桌面端不在
         * 这里采集额度——那是手机面板的 `latest.usage`——回空数组即「还没有
         * 额度数据」，页面显示空态。
         */
        'usage/quotas': async () => quotaCards(deps),
        /**
         * 额度的历史曲线（`?days=45`）。页面把结果整体 `JSON.stringify` 比较，
         * 回空对象即可，曲线区不画。
         */
        'usage/quotas/history': async () => ({}),
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
        /**
         * 市场清单。
         *
         * ⚠ 这里以前回的是空数组，于是桌面 UI 的商店一张卡片都没有——
         * 「装不了插件」的第一层原因就是「没得装」。现在给真实清单，
         * 字段按 `ui/plugins.js` 的 `ghListing` 形状（`package`/`name`/
         * `icon`/`summary`/`providers`/`kind`）挑，`icon` 超过 100 KB 的
         * data URI 直接丢掉（一个图标几 MB，列表会被它撑死）。
         */
        'plugins/listings': async () => {
            const listings = await deps.market.listings().catch(() => []);
            return {
                listings: listings.map((l) => ({
                    package: l.package,
                    name: l.name,
                    ...(typeof l.icon === 'string' && l.icon.length <= 100_000 ? { icon: l.icon } : {}),
                    ...(Array.isArray(l.providers) && l.providers.length > 0 ? { providers: l.providers } : {}),
                    ...(l.community === undefined ? {} : { community: l.community }),
                    ...(l.kind === undefined ? {} : { kind: l.kind }),
                    ...(l.summary === undefined ? {} : { summary: l.summary }),
                })),
            };
        },
        /**
         * 装一个插件（商店卡片的 Install / 「+ 添加」手输）。
         *
         * 与手机面板同一条路径（`installOne`）：下载 → 解包 → 写 `plugins.json`
         * → 重扫。⚠ 慢（整仓 tarball 十几 MB），调用方要给 loading 态。
         */
        'plugins/add': async (_req, body) => {
            const spec = typeof body?.spec === 'string' ? body.spec.trim() : '';
            if (spec === '')
                throw new Error('缺少 spec');
            const out = await deps.installOne(spec);
            if (out.ok !== true)
                throw new Error(out.error ?? '安装失败');
            return { ok: true, name: out.name };
        },
        /** 升级到市场最新（`force` = 重装，否则已存在会被幂等短路）。 */
        'plugins/upgrade': async (_req, body) => {
            const spec = typeof body?.spec === 'string' ? body.spec.trim() : '';
            if (spec === '')
                throw new Error('缺少 spec');
            const out = await deps.installOne(spec, undefined, true);
            if (out.ok !== true)
                throw new Error(out.error ?? '升级失败');
            return { ok: true, name: out.name };
        },
        /** 启停一个插件（写 `plugins.json` 的 `enabled`，随后重扫才生效）。 */
        'plugins/off': async (_req, body) => {
            const spec = typeof body?.spec === 'string' ? body.spec.trim() : '';
            if (spec === '')
                throw new Error('缺少 spec');
            // 页面的 `off` 是「关掉」；`enabled` 是它的反面
            await deps.plugins.setEnabled(spec, body?.off !== true);
            await deps.reload?.();
            return { ok: true, off: body?.off === true };
        },
        /** 保存运行选项（`null` = 清空，与桌面端的 Clear 同义）。 */
        'plugins/options': async (_req, body) => {
            const spec = typeof body?.spec === 'string' ? body.spec.trim() : '';
            if (spec === '')
                throw new Error('缺少 spec');
            const options = body?.options ?? null;
            if (options !== null && (typeof options !== 'object' || Array.isArray(options)))
                throw new Error('选项必须是一个 JSON 对象');
            await deps.plugins.setOptions(spec, options);
            await deps.reload?.();
            return { ok: true };
        },
        /** 卸载（删目录 + 从 `plugins.json` 移除）。 */
        'plugins/remove': async (_req, body) => {
            const spec = typeof body?.spec === 'string' ? body.spec.trim() : '';
            if (spec === '')
                throw new Error('缺少 spec');
            const pkg = deps.moduleNameOf(spec);
            await deps.plugins.remove(spec);
            await deps.market.uninstall(pkg).catch(() => {});
            await deps.reload?.();
            return { ok: true };
        },
        /** 路由偏好：DSH 里没有「插件接管路由」这回事，收下不报错。 */
        'plugins/prefer': async () => ({ ok: true }),
        /**
         * 更新全部：对每个已装且能问到最新版的包做一次强制重装。
         *
         * 与原版一致：**逐个**装（并发下载会把带宽和 CPU 打满，且解包
         * 目录名可能冲突），失败的只记日志、不中断其余。
         */
        'plugins/update': async () => {
            const installed = await deps.plugins.list();
            const updated = [];
            const failed = [];
            for (const item of installed) {
                const spec = item.spec;
                if (typeof spec !== 'string' || spec === '')
                    continue;
                const pkg = deps.moduleNameOf(spec);
                const current = await deps.market.latestVersion(pkg).catch(() => undefined);
                if (current === undefined)
                    continue;
                const out = await deps.installOne(spec, undefined, true);
                if (out.ok === true)
                    updated.push(pkg);
                else
                    failed.push({ package: pkg, error: out.error ?? 'unknown' });
            }
            await deps.reload?.();
            return { ok: true, updated, failed };
        },
        /**
         * 检查更新：**同步**返回每个已装插件的最新版本与状态。
         *
         * 形状照 `ui/plugins.js:317` 的 `checkUpdates`：`{state, plugins:[...], at}`，
         * 每项 `{spec, package, latest?, head?, status, off?}`，`status` 取
         * `update` / `current` / `unknown`。GitHub 源没有版本号 → `unknown`。
         */
        'plugins/check': async () => {
            const installed = await deps.plugins.list();
            const plugins = [];
            for (const item of installed) {
                const spec = item.spec;
                if (typeof spec !== 'string' || spec === '')
                    continue;
                const pkg = deps.moduleNameOf(spec);
                const current = await deps.pluginVersion?.(pkg).catch(() => undefined);
                const latest = await deps.market.latestVersion(pkg).catch(() => undefined);
                const status = current === undefined || latest === undefined
                    ? 'unknown'
                    : (latest === current ? 'current' : 'update');
                plugins.push({
                    spec,
                    package: pkg,
                    ...(latest === undefined ? {} : { latest }),
                    ...(current === undefined ? {} : { version: current }),
                    status,
                    ...(item.enabled === false ? { off: true } : {}),
                });
            }
            return { state: null, plugins, at: Date.now() };
        },
        /**
         * npm 说某个包是什么（版本、周下载、许可证）。
         *
         * 页面拿到空对象就显示「unknown」并允许 Install——**不要回 501**，
         * 那会让商店整段走进 catch。这里只问 `dist-tags.latest`，问不到就空。
         */
        'plugins/npm': async (req) => {
            const names = new URL(req.url ?? '/', 'http://x').searchParams.get('names') ?? '';
            const out = {};
            for (const name of names.split(',').map((x) => x.trim()).filter((x) => x !== '')) {
                const version = await deps.market.latestVersion(name).catch(() => undefined);
                if (version !== undefined)
                    out[name] = { version, weekly: 0 };
            }
            return { npm: out };
        },
        /** GitHub 源插件的当前提交：不查，页面显示 unknown。 */
        'plugins/git': async () => ({ heads: {} }),
        /** GitHub 话题插件的抓取结果。 */
        'plugins/github': async () => ({ repos: [] }),
        /** magpie 的内置插件：DSH 里没有这套东西。 */
        'plugins/builtin': async () => [],

        /**
         * 设置页：magpie 自己的 `settings.json`。
         *
         * 页面 GET 读全量，POST 写回合并后的全量（`savePrefs` 每次都带齐
         * 所有字段，只发变化的键）。**直接落 magpie 的 settings.json**，而不是
         * 另存一份——设置页改的就是给 magpie 读的东西，另存等于改了不生效。
         *
         * `readMagpieSettings` 读不到时回 `{}`，所以首次写入会新建文件。
         */
        settings: async (_req, body) => {
            const current = await readMagpieSettings(deps.root);
            const isWrite = body !== undefined && body !== null && typeof body === 'object' && !Array.isArray(body);
            // 读与写都过 `settingsWithCheckin`：页面把返回值直接当 `prefs` 用，
            // 少了签到三件套，设置页的「预热」段就整段不画。
            if (!isWrite)
                return settingsWithCheckin(deps, current);
            const next = { ...current, ...body };
            await writeAtomic(join(deps.root, 'settings.json'), next);
            return settingsWithCheckin(deps, next);
        },
        /**
         * 每日签到：每个「自己会签到」的插件一行的开关（Settings › 预热）。
         *
         * 契约（`app.js:22494`）：`{provider, on}` 进来，回**合并后的完整 prefs** ——
         * 前端直接 `prefs = await writingPrefs(api(...))` 再拿它重画，所以不能只回
         * `{ok:true}`。开关本身落在 magpie `settings.json` 的 `pluginCheckins` 里，
         * 形状 `{[pluginId]: boolean}`（与上游一致）。
         */
        'settings/plugin-checkin': async (_req, body) => {
            const cur = await readMagpieSettings(deps.root);
            const provider = typeof body?.provider === 'string' ? body.provider : '';
            if (provider === '')
                throw new Error('缺少 provider');
            const on = body?.on === true;
            const map = cur?.pluginCheckins !== null && typeof cur?.pluginCheckins === 'object' && !Array.isArray(cur.pluginCheckins)
                ? { ...cur.pluginCheckins }
                : {};
            map[provider] = on;
            const next = { ...cur, pluginCheckins: map };
            await writeAtomic(join(deps.root, 'settings.json'), next);
            // 开关一变，宿主的自动签到也该跟着走（它读的是插件自己的 settings）
            if (typeof deps.setCheckinAuto === 'function')
                await deps.setCheckinAuto(on).catch(() => { });
            return settingsWithCheckin(deps, next);
        },
        /**
         * 单个账号要不要参与每日签到（Settings 里每个平台下 ≥2 个账号才画这一行）。
         *
         * 契约（`app.js:22528`）：`{key, on}` 进来，同样回完整 prefs。
         * 存储形状 `checkinOffAccounts: [accountKey]`（存「被排除的」，这样新账号
         * 默认参与，不会因为忘记录入而静悄悄不签到）。
         */
        'settings/checkin-account': async (_req, body) => {
            const cur = await readMagpieSettings(deps.root);
            const key = typeof body?.key === 'string' ? body.key : '';
            if (key === '')
                throw new Error('缺少 key');
            const off = Array.isArray(cur?.checkinOffAccounts) ? cur.checkinOffAccounts.filter((k) => typeof k === 'string') : [];
            const on = body?.on === true;
            const nextOff = on ? off.filter((k) => k !== key) : (off.includes(key) ? off : [...off, key]);
            const next = { ...cur, checkinOffAccounts: nextOff };
            await writeAtomic(join(deps.root, 'settings.json'), next);
            return settingsWithCheckin(deps, next);
        },
        /**
         * 立刻给一个账号签一次（额度卡的「立刻签到」与「全部签到」都用它）。
         *
         * 契约（`checkinnow.js` 的 `ciNowSend` → `api("usage/checkin-account", {by, key})`）：
         * 回**单个**结果对象 `{outcome, day, credit, streak, again, msg, asked, by}`，
         * 不动任何开关。页面用它把按钮状态就地改成结果文案。
         */
        'usage/checkin-account': async (_req, body) => {
            const key = typeof body?.key === 'string' ? body.key : '';
            if (key === '')
                throw new Error('缺少 key');
            const provider = typeof deps.providerOfKey === 'function' ? deps.providerOfKey(key) : '';
            if (provider === '')
                throw new Error('这个账号不属于任何平台');
            const result = await deps.host.checkinOf(provider, key);
            if (result === undefined)
                throw new Error('这个平台不支持签到');
            // 结果要落进快照，额度卡的下一屏才显示得出来
            if (typeof deps.recordCheckin === 'function')
                deps.recordCheckin(provider, key, result);
            const outcome = typeof result.outcome === 'string' ? result.outcome : 'failed';
            return {
                outcome,
                by: `plugin:${provider}`,
                asked: true,
                ...(typeof result.credit === 'undefined' ? {} : { credit: result.credit }),
                ...(typeof result.streak === 'undefined' ? {} : { streak: result.streak }),
                ...(result.again === true ? { again: true } : {}),
                ...(typeof result.message === 'string' && result.message !== '' ? { msg: result.message } : {}),
            };
        },
        /** 额度卡里「还没签到」的那批（「全部签到」按钮据此显示）。 */
        // 只给「该签但还没签」的：被单独排除的账号不能进「全部签到」的批次，
        // 否则设置里关掉的那个会被这一下签回来（与上游 checkinDue 的语义一致）。
        'usage/checkins/off': async () => (await checkinCards(deps)).filter((q) => q.checkins === true && q.checkinDue === true && q.checkinOff !== true),
        // ── usage/requests：请求流水（页面「请求」页签）────────────────────
        // 上游返回的是**一页**行 + 该时段的合计，页面自己分页。
        'usage/requests': async (req) => {
            const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
            return ledgerOf(deps, query);
        },
        // ── usage/heatmap：最近 90 天的每日用量 ───────────────────────────
        'usage/heatmap': async (req) => {
            const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
            return heatmapOf(deps, query);
        },
        // ── usage/arrange：额度卡的排布/隐藏/客户端归并 ────────────────────
        'usage/arrange': async (_req, body) => arrangeUsage(deps, body ?? {}),
        // ── usage/quotas/refresh：重新读某个平台的额度 ────────────────────
        'usage/quotas/refresh': async (_req, body) => {
            const provider = typeof body?.provider === 'string' ? body.provider : '';
            if (provider !== '' && typeof deps.refreshQuota === 'function')
                await deps.refreshQuota(provider).catch(() => { });
            // 页面拿返回值整体替换额度卡数组
            return typeof deps.quotaCards === 'function' ? await deps.quotaCards() : [];
        },
        // ── usage/quotas/history/holds：额度历史的「冻结」记录 ────────────
        // 上游用它画「什么时候到过上限」。我们的历史是 `usage/quotas/history`
        // 那份 `{}` 里的内容（没有），所以这里回空数组 —— 页面按空处理不画。
        'usage/quotas/history/holds': async () => [],
        // ── usage/codex-reset：用掉一次重置机会 ──────────────────────────
        // DSH 里没有「厂商重置配额」这个动作（那是 magpie 对 Codex 的专门支持），
        // 按钮点了要给明确答复，而不是 501 让页面挂红条。
        'usage/codex-reset': async () => {
            throw new Error('这里没有「重置配额」：本插件只代理请求，不代你操作厂商账户');
        },
        // ── tune：上下文调优建议（页面「上下文」页签的上半）──────────────
        // 上游按 agent 统计「哪个旋钮该调」。我们没有旋钮，回空列表 ->
        // 页面自己会显示「这个范围里调用太少，给不出建议」。
        tune: async (req) => {
            const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
            const days = Number.parseInt(query.get('days') ?? '7', 10) || 7;
            return { days, agents: [] };
        },
        // ── context：上下文占用（页面「上下文」页签的下半）───────────────
        context: async (req) => {
            const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
            const days = Number.parseInt(query.get('days') ?? '7', 10) || 7;
            return { days, agents: [], series: [] };
        },

        /**
         * 「会话历史读取」的两个开关（Settings › 隐私）。
         *
         * 页面要的形状是 `{asked, all, found:[]}`（`ui/plugins/sessions/settings.js:52`），
         * `found` 是「本机找到的 agent 列表」。DSH 不读各 agent 的 session
         * 历史，所以 `found` 恒为空数组；两个开关存在 settings.json 的
         * `sessionReads` 子对象里。
         */
        'sessions/reads': async (_req, body) => {
            const s = await readMagpieSettings(deps.root);
            const cur = {
                asked: s?.sessionReads?.asked === true,
                all: s?.sessionReads?.all === true,
                found: [],
            };
            if (body === undefined || body === null || typeof body !== 'object')
                return cur;
            const next = {
                asked: typeof body.asked === 'boolean' ? body.asked : cur.asked,
                all: typeof body.all === 'boolean' ? body.all : cur.all,
                found: [],
            };
            await writeAtomic(join(deps.root, 'settings.json'), { ...s, sessionReads: next });
            return next;
        },

        /**
         * 隐私模型（Settings › 隐私的「个人数据脱敏」）。
         *
         * 页面读 `{on, model, models, installed, downloading, failed, running, supported}`
         * 并直接画行。DSH 里没有本地脱敏模型，回空态：`on:false` + `models:[]`
         * 让那一行显示「未启用」，不报错。
         */
        'privacy-model': async () => ({
            on: false,
            model: '',
            models: [],
            installed: false,
            downloading: false,
            failed: false,
            running: false,
            supported: false,
        }),
        /**
         * WebDAV 同步（Settings › 同步与备份）。
         *
         * 页面 `api("davsync").catch(() => ({}))` 本来就兜底，回 `{}` 即空态；
         * 但回 501 会在控制台留一条红字，所以显式给空对象。
         */
        davsync: async () => ({}),
        /**
         * 导出账号（Settings › 同步与备份 → 导出）。
         *
         * 与 magpie 的 `POST /api/backup/export` 同一条路径、同一份文件格式
         * （见 `src/backup.js` 的说明），所以导出的文件在真正的 magpie 上也能
         * 导入，反过来也一样。差别只在**装什么**：这里只装「账号」——各平台
         * 的凭据（`plugin-auth.json`）、订阅类账号（`logins.json`），外加一份
         * 插件清单（自定义键 `hubPlugins`，magpie 读到会忽略）。
         *
         * 不带供应商配置：那是「这台机器上配了哪些模型入口」，与「我的账号」
         * 是两件事，混在一起导到手机上会多出一堆用不到的空供应商。
         *
         * 入参用小写 `pass`（桌面 UI 的 `exportForm` 就发小写；Go 那边靠
         * `encoding/json` 的大小写不敏感匹配吃掉了这个差异，我们得自己认）。
         */
        'backup/export': async (_req, body) => {
            const pass = typeof body?.pass === 'string' ? body.pass : '';
            if (pass === '')
                throw new Error('请设置一个口令：备份文件用它加密');
            const bundle = await collectAccounts(deps.root, { app: 'dsh-magpie-hub' });
            const data = seal(bundle, pass);
            const dir = await downloadsDir();
            const stamp = new Date().toISOString().slice(0, 10);
            // 与上游一样：同一天多次导出不覆盖前一份，加 -2、-3
            let file = join(dir, `magpie-${stamp}${BACKUP_EXT}`);
            for (let i = 2; i < 100; i += 1) {
                try {
                    await readFile(file);
                }
                catch {
                    break;
                }
                file = join(dir, `magpie-${stamp}-${i}${BACKUP_EXT}`);
            }
            await writeFile(file, data);
            const accounts = Object.keys(bundle.signIns?.plugins ?? {}).length;
            const logins = Array.isArray(bundle.signIns?.logins) ? bundle.signIns.logins.length : 0;
            // 形状照 `internal/gui/backup.go` 的返回给全：页面会读 path 与 signIns
            return {
                path: file,
                providers: 0,
                profiles: 0,
                agents: 0,
                library: false,
                signIns: accounts + logins,
                accounts,
                logins,
                plugins: Array.isArray(bundle.hubPlugins?.plugins) ? bundle.hubPlugins.plugins.length : 0,
                bytes: data.length,
            };
        },
        /**
         * 把一份刚封好的备份回给**对端**（手机端「从电脑导入」用）。
         *
         * 与 `backup/export` 的唯一区别是输出方向：那边写进下载文件夹给本机用户，
         * 这边把字节 base64 回给请求方。数据、口令、加密方式完全相同，所以对端
         * 拿到的就是一份能直接 `open()` 的信封。
         *
         * 为什么不让对端自己去读文件：手机那侧跑在容器里，够不到电脑的下载目录。
         * 口令由调用方给（对端要用它解开），本机不落盘、不记日志。
         */
        'backup/snapshot': async (_req, body) => {
            const pass = typeof body?.pass === 'string' ? body.pass : '';
            if (pass === '')
                throw new Error('请设置一个口令：备份文件用它加密');
            const bundle = await collectAccounts(deps.root, { app: 'dsh-magpie-hub' });
            const data = seal(bundle, pass);
            const accounts = Object.keys(bundle.signIns?.plugins ?? {}).length;
            const logins = Array.isArray(bundle.signIns?.logins) ? bundle.signIns.logins.length : 0;
            return {
                data: data.toString('base64'),
                bytes: data.length,
                accounts,
                logins,
                plugins: Array.isArray(bundle.hubPlugins?.plugins) ? bundle.hubPlugins.plugins.length : 0,
            };
        },
        /**
         * 导入账号（Settings › 同步与备份 → 导入）。
         *
         * `data` 是文件字节的 base64（桌面 UI 的 `importForm` 就是这么发的：
         * 注释里写着「as base64 in JSON: the app's web view drops a File sent
         * as the body」）。
         *
         * 返回的键名同时给大小写两套：Go 的 `Result` 没有 json tag，序列化出来
         * 是 `Added`/`SignIns`，而页面 `signInsSaid` 读的是 `r.added`（上游
         * 自己也因此恒显示 0）。两套都给，哪种读法都能拿到数。
         */
        'backup/import': async (_req, body) => {
            const encoded = typeof body?.data === 'string' ? body.data : '';
            if (encoded === '')
                throw new Error('先选一个备份文件');
            const pass = typeof body?.pass === 'string' ? body.pass : '';
            let bundle;
            try {
                bundle = openBackup(Buffer.from(encoded, 'base64'), pass);
            }
            catch (e) {
                // 口令错、不是备份、被改过 —— 对用户是三句不同的话，别混成一句
                throw new Error(importFailure(e));
            }
            const summary = await applyAccounts(deps.root, bundle, {
                install: typeof deps.installOne === 'function'
                    ? (spec) => deps.installOne(spec, undefined, false)
                    : undefined,
            });
            await deps.reload?.();
            await deps.refresh?.();
            const signIns = {
                Added: summary.accounts + summary.logins,
                Updated: 0,
                Kept: 0,
                added: summary.accounts + summary.logins,
                updated: 0,
                kept: 0,
            };
            return {
                Added: summary.accounts,
                Replaced: 0,
                Profiles: 0,
                Agents: 0,
                NeedKey: [],
                Skipped: [],
                Plugins: summary.missing,
                PluginErrors: {},
                Library: false,
                SignIns: signIns,
                accounts: summary.accounts,
                logins: summary.logins,
                plugins: summary.plugins,
                missing: summary.missing,
            };
        },
        /**
         * 自动备份列表（Settings › 同步与备份 → 自动备份）。
         *
         * 页面读 `{backups:[...], error?}` 并画列表；回空数组即「还没有备份」。
         */
        autobackup: async () => ({ backups: [] }),
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
    // ── 平台编辑相关（`provider/*`）──────────────────────────────────────
    //
    // 这几个端点都用 `handlers.providers()` 收尾：页面拿返回值**整体替换**
    // 自己的 `providers`，形状必须与 `providers` 端点一致。
    Object.assign(handlers, {
        /** 账号顺序（平台详情的拖拽）。 */
        'provider/arrange': async (_req, body) => {
            const id = typeof body?.id === 'string' ? body.id : '';
            const order = Array.isArray(body?.accountOrder)
                ? body.accountOrder.filter((k) => typeof k === 'string')
                : null;
            if (id !== '' && order !== null) {
                const prefs = await readMagpieSettings(deps.root);
                const table = typeof prefs.accountOrder === 'object' && prefs.accountOrder !== null
                    ? { ...prefs.accountOrder }
                    : {};
                table[id] = order;
                await writeAtomic(join(deps.root, 'settings.json'), { ...prefs, accountOrder: table });
            }
            return await handlers.providers();
        },
        /** 调换平台顺序 / 改它的模型清单。 */
        'provider/move': async (_req, body) => {
            const id = typeof body?.id === 'string' ? body.id : '';
            const prefs = await readMagpieSettings(deps.root);
            let dirty = false;
            if (id !== '' && typeof body?.order === 'string') {
                const cur = Array.isArray(prefs.providerOrder)
                    ? prefs.providerOrder.filter((x) => typeof x === 'string')
                    : [];
                const rest = cur.filter((x) => x !== id);
                // `order` 是「排到哪个 id 之后」，空串＝最前
                const at = body.order === '' ? 0 : rest.indexOf(body.order) + 1;
                rest.splice(at < 0 ? rest.length : at, 0, id);
                prefs.providerOrder = rest;
                dirty = true;
            }
            if (id !== '' && Array.isArray(body?.models)) {
                const table = typeof prefs.providerModels === 'object' && prefs.providerModels !== null
                    ? { ...prefs.providerModels }
                    : {};
                table[id] = body.models.filter((m) => typeof m === 'string');
                prefs.providerModels = table;
                dirty = true;
            }
            if (dirty)
                await writeAtomic(join(deps.root, 'settings.json'), prefs);
            return await handlers.providers();
        },
        /** 清掉「从厂商拉的模型清单」缓存（我们记在 `providerModels[id]`）。 */
        'provider/unfetch': async (_req, body) => {
            const id = typeof body?.id === 'string' ? body.id : '';
            if (id !== '') {
                const prefs = await readMagpieSettings(deps.root);
                if (prefs.providerModels && typeof prefs.providerModels === 'object' && id in prefs.providerModels) {
                    const table = { ...prefs.providerModels };
                    delete table[id];
                    await writeAtomic(join(deps.root, 'settings.json'), { ...prefs, providerModels: table });
                }
            }
            return await handlers.providers();
        },
        /**
         * 这个账号的 key 自己能列出的模型。
         *
         * 上游问厂商的 `/models`。插件没有通用的「列模型」钩子，所以如实回
         * `{known:false, models:[]}`；页面据此退回「把已显示的模型全选」
         * （`app.js:14533` 对 null 直接 return，不会挂红条）。
         */
        'provider/keylisted': async () => ({ known: false, models: [] }),
        /**
         * 在某个平台上真发一次请求（页面「测试」按钮）。
         *
         * 上游用 SSE 回进度条；页面同时接受一次性 JSON（`app.js:11062` 读
         * `r.results`）。这里做一次最小非流式调用：成功回 ok，失败带上原因。
         */
        'provider/test': async (_req, body) => {
            const id = typeof body?.id === 'string' ? body.id : '';
            const model = typeof body?.model === 'string' ? body.model : '';
            if (id === '')
                throw new Error('缺少平台 id');
            if (typeof deps.pingProvider !== 'function')
                return { ok: false, results: [{ ok: false, model, message: '这个版本不支持在线自检' }] };
            const r = await deps.pingProvider(id, model);
            return { ok: r?.ok === true, results: [{ ...r, model }] };
        },
        /** 中止自检（我们是一次性请求，没有可中止的流）。 */
        'provider/teststop': async () => ({ ok: true }),
        /**
         * 按四种 API 形状试 base URL。
         *
         * 上游逐个发最小请求看哪种通。我们对插件没有通用探测能力，如实回空
         * `results` —— 页面会显示「None answered: check the URL and the key」，
         * 比 501 挂红条好。
         */
        'provider/detect': async (_req, body) => ({
            results: [],
            base: typeof body?.base === 'string' ? body.base : '',
        }),
    });
    return handlers;
}
