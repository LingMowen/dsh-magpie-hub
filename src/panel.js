/**
 * dsh-magpie-hub —— 面板「视图 + 数据」（纯函数）。
 *
 * 形态对齐 magpie 桌面端托盘面板：顶部四个页签 `Agent` / `额度` / `用量` / `路由`。
 *
 * 契约来源（均已核对源码，非推测）：
 *   - `dsh-Go/sdk/plugin-kit/types/schema.d.ts`（由 view.schema.json 生成）：
 *     组件字段与取值的唯一权威形状。注意 `actions` 用 `style: 'primary'|'plain'`，
 *     `collapsible` 的标题字段是 `label`（不是 `title`），`metric` 没有 `icon`。
 *   - `dsh-Go/app/lib/ui/chat/dsh_ui/dsh_ui_model.dart:1010-1072`：
 *     `options` 每项的 `value` 只接受**非空字符串**，其它类型被解析成 null
 *     （点按只能回传 label），所以这里的 value 一律写字符串。
 *   - `dsh-Go/app/lib/ui/chat/dsh_ui/dsh_ui_plugin_model.dart:394-450`：
 *     `keyValue` 的 label 为 null 或 trim 后为空时整条 `continue` 丢弃。
 *   - `progress.value` 缺省**不等于 0**，因此没有 `used` 的额度窗口一律不画环。
 *
 * 节点预算：panel profile 为 120 节点 / 32768 字节 / 深度 8 / 每层 32 个子节点。
 * 本文件按更严的 ≤100 节点收敛（见下方各 MAX_* 上限与文件末尾的用量估算）。
 */
// ── 预算上限（决定四页签的节点数上界，见文件末尾估算） ───────────────────
/** 顶层视图协议版本：v2 才启用 tabs / collapsible / progress.shape:'ring'。 */
const VIEW_VERSION = 2;
/** 视图 accent（magpie 品牌紫）。App 用它给 v2 按钮描边/图标上色。 */
/** Agent 页最多渲染几个 provider（每个 2 节点：collapsible + list）。 */
// 平台卡片是 list 行，一屏滚到底没问题；旧上限 5 让装了 21 个平台的用户
// 只看到 5 个 + 一句「另有 16 个插件未显示」——那句话在手机上没法点，等于死路。
const MAX_AGENT_PROVIDERS = 40;
/** 单个 provider 最多列几个账号（list item 不占节点，但避免列表过长）。 */
const MAX_AGENT_ACCOUNTS = 8;
/** 单个 provider 最多画几个登录方式（真实插件大多 3 个，留余量到 4）。 */
const MAX_LOGIN_METHODS = 4;
/** 手机上同时铺开的密钥表单上限：`form` 不能进 `collapsible`，只能平铺在页签里。 */
const MAX_KEY_FORMS = 2;
/** 额度页最多几个 provider 分组标题。 */
const MAX_QUOTA_PROVIDERS = 5;
/** 额度页最多几个账号（每个「1 行文字 + ≤3 个窗口节点」）。 */
const MAX_QUOTA_ACCOUNTS = 6;
/** 每个账号最多 3 个环形（截图里的三个环）。 */
const MAX_QUOTA_RINGS = 3;
/** chart categories 上限为 60（App 侧硬限）。 */
const MAX_CHART_CATEGORIES = 60;
/** 用量排行表最多 8 行。 */
const MAX_USAGE_ROWS = 8;
/** 路由表最多 12 行。 */
const MAX_ROUTING_ROWS = 12;
/** 已装包只列前几个：这一节是「我装了哪些平台」，不是包管理器。 */
const STORE_PAGE = 8;
const MAX_STORE_ROWS = 4;
/** 插件页最多列多少个（11 个插件一屏能滚完，多了 list 也滚得动）。 */
const MAX_PLUGIN_ROWS = 30;
const PERIOD_TODAY = 'today';
const PERIOD_7D = '7d';
const PERIOD_30D = '30d';
const PERIOD_ALL = 'all';
// 自绘导航的页面 id（与 index.js 的 currentPage 一致；`data.ui.page` 的取值）
const PAGE_AGENTS = 'agents';
const PAGE_QUOTAS = 'quotas';
const PAGE_USAGE = 'usage';
const PAGE_PLUGINS = 'plugins';
const PAGE_STORE = 'store';
const PAGE_SETTINGS = 'settings';
const PAGES = [PAGE_AGENTS, PAGE_QUOTAS, PAGE_USAGE, PAGE_PLUGINS, PAGE_STORE, PAGE_SETTINGS];
export const WORDS_ZH = {
    panelTitle: 'Magpie 面板',
    tabAgents: '平台',
    tabQuotas: '额度',
    tabUsage: '用量',
    tabRouting: '路由',
    tabStore: '商店',
    tabMore: '更多',
    sectionRouting: '请求记录',
    sectionStore: '已装的包',
    storeEmptyTitle: '商店里还没有已装的包',
    storeEmptyMessage: '在桌面端的「商店」页签安装插件后，这里会列出它们。',
    storeHint: '安装新插件请用桌面端的商店页签。',
    accounts: n => `${n} 个账号`,
    accountsInline: n => `${n} 账号`,
    modelsInline: n => `${n} 模型`,
    back: '返回',
    backToProviders: '返回平台列表',
    refreshQuota: '刷新额度',
    sectionQuota: '额度',
    noQuotaRows: '这个账号还没有额度数据',
    noAccounts: '还没有登录账号',
    needLogin: '需登录',
    providerOff: '已停用',
    signedInN: (ok, n) => `已登录 ${ok}/${n}`,
    summaryLine: (p, a, m) => `${p} 个平台 · ${a} 个账号 · ${m} 个模型`,
    summarySingle: (a, m) => `${a} 个账号 · ${m} 个模型`,
    keyFormsMore: n => `另有 ${n} 个平台需要密钥，请到桌面端登录`,
    login: '登录',
    loginWith: label => label,
    loginOpened: '已打开授权页，完成后点「我已完成」',
    loginDone: '我已完成',
    loginKeyLabel: 'API Key',
    loginSubmit: '保存密钥',
    loginPending: '登录中…',
    moreProviders: n => `另有 ${n} 个插件未显示`,
    moreAccounts: n => `另有 ${n} 个账号未显示`,
    copySummary: '复制摘要',
    signInExpired: '登录已过期',
    signInKept: '登录有效',
    signInRenewed: '已续期',
    signInUnknown: '登录态未知',
    errDpapi: '这个账号的登录是在 Windows 电脑上保存的，手机上打不开。请在手机上重新登录一次。',
    errNetwork: '连不上服务器，检查网络后重试。',
    errGeneric: '这个账号读不出来，可能需要在手机上重新登录。',
    balance: b => `余额 ${b}`,
    statusOk: '成功',
    statusError: '失败',
    noProvidersTitle: '还没有安装 magpie 插件',
    noProvidersMessage: '装上 Magpie 插件后，这里会显示账号、额度、用量与路由。',
    diagTitle: '这次扫描的结果',
    diagRoot: '数据目录',
    diagDeclared: '登记的插件',
    diagLoaded: '装载成功',
    diagFailed: '装载失败',
    diagFirstError: '第一个错误',
    diagHint: '如果「登记的插件」是 0，说明数据目录里还没有 plugins.json；如果「装载失败」大于 0，那条错误就是原因。',
    diagNoRegistry: '这个数据目录里没有 plugins.json。也就是说这台机器上还没跑过 magpie、也没把插件数据拷过来 —— 面板本身是好的，只是没有数据可读。',
    goToPlugins: '去插件页安装',
    goToPluginsHint: '内置商店可以搜索、也可以直接填 npm 包名或 GitHub 链接',
    diagAllFailed: '插件登记了但一个都没装载成功，看上面的第一个错误。',
    diagLoadedButEmpty: '插件装载成功了，但它们没有声明任何平台。可能这些插件只提供工具、不提供模型。',
    noQuotaTitle: '还没有额度数据',
    noQuotaMessage: '插件声明 usage 钩子后，这里会显示各账号的额度窗口。',
    noRoutingTitle: '还没有请求记录',
    noRoutingMessage: '产生一次模型调用后，这里会显示路由轨迹。',
    refresh: '刷新',
    metricTokens: 'Token',
    metricCalls: '请求',
    metricErrors: '失败',
    metricCache: '缓存命中率',
    metricCost: '费用',
    metricUnpriced: (n) => `${n} 个没有价格`,
    metricPriced: '按模型单价估算',
    metricOfPrompt: '占提示词',
    metricNone: '暂无',
    noUsageRows: '这个时段还没有按平台的用量',
    storeRest: n => `等 ${n} 个`,
    storeMore: n => `显示更多（还有 ${n} 个）`,
    metricFailed: (n) => `${n} 次失败`,
    kvInput: '输入',
    kvOutput: '输出',
    kvCacheRead: '缓存读',
    kvCacheWrite: '缓存写',
    kvRetried: '重试',
    colProvider: '供应商',
    colTokens: 'Token',
    colCalls: '请求',
    colTtft: '平均首字',
    colTime: '时间',
    colModel: '模型',
    colStatus: '状态',
    colLatency: '耗时',
    periodToday: '今天',
    period7d: '7天',
    period30d: '30天',
    periodAll: '全部',
    justNow: '刚刚',
    minutesAgo: n => `${n} 分钟前`,
    hoursAgo: n => `${n} 小时前`,
    updatedAt: t => `更新于 ${t}`,
    // ── 自绘导航（chips）与商店/设置页 ──────────────────────────────────
    navLabel: '页面',
    navAgents: '平台',
    navQuotas: '额度',
    navUsage: '用量',
    navPlugins: '插件',
    navStore: '商店',
    navSettings: '设置',
    searchLabel: '搜索',
    searchPlaceholder: '平台名',
    searchSubmit: '搜索',
    searchClear: '清除搜索',
    searchResult: (n, q) => `「${q}」匹配 ${n} 个平台`,
    searchEmptyTitle: '没有匹配的平台',
    searchEmptyMessage: '换个关键词，或清除搜索看全部。',
    searchClose: '收起搜索',
    storeInstalledSection: '已安装',
    storeAvailableSection: '可安装',
    installLabel: '安装新插件',
    installPlaceholder: 'npm 包名，或 GitHub 链接 / owner/repo',
    installSubmit: '安装',
    installHint: 'npm 名 / owner/repo / GitHub 链接',
    installRunning: spec => `正在安装 ${spec}…`,
    installDone: name => `已安装 ${name}，插件已重扫`,
    installFailed: msg => `安装失败：${msg}`,
    storeEmptyAvailable: '市场清单暂时拉不到，稍后重试',
    settingsSection: '面板',
    pluginInstalledSection: n => `已安装的插件（${n}）`,
    pluginCheckUpdates: '检查更新',
    pluginUpdating: '正在检查更新…',
    pluginUpdated: '已经是最新版本',
    pluginUpdateFound: n => `${n} 个插件有新版本`,
    pluginUpdateFailed: msg => `检查更新失败：${msg}`,
    pluginUpdateAll: n => `更新全部（${n} 个）`,
    pluginUpdateAllNone: '更新全部',
    pluginUpdateTo: v => `可更新到 v${v}`,
    pluginAndMore: n => `等 ${n} 个平台`,
    pluginNoProvider: '未声明平台',
    pluginOff: '已停用',
    pluginOn: '已启用',
    pluginOpenPlatform: '账号与额度在这个平台里',
    pluginOptionsSection: '运行选项',
    pluginOptionsHint: '插件自己的配置，JSON 对象；改完保存会重扫插件',
    pluginOptionsLabel: '选项（JSON）',
    pluginSaveOptions: '保存选项',
    pluginClearOptions: '清空选项',
    pluginEnable: '启用插件',
    pluginDisable: '停用插件',
    pluginRemove: '移除插件',
    pluginNone: '还没有装载任何插件',
    pluginFailedSection: '装载失败',
    settingsPluginCount: n => `${n} 个插件已装载`,
    settingsModelCount: n => `${n} 个模型`,
    settingsEntry: '面板入口',
    settingsReload: '重扫插件',
    settingsRefresh: '刷新数据',
    settingsVersion: v => `版本 ${v}`,
    tokenSection: '仓库密钥',
    tokenHint: '只有私密仓库才需要',
    tokenGithub: 'GitHub Token',
    tokenNpm: 'npm Token',
    tokenSave: '保存密钥',
    tokenSavedHint: '只存本机，仅用于拉包',
    tokenSaved: '已保存密钥',
    displaySection: '显示',
    displayStrip: '输入框上方的额度条',
    displayNote: '每回合的消耗脚注',
    displayOn: '显示',
    displayOff: '隐藏',
    displayNoteKind: '脚注写什么',
    displayNoteTokens: 'token 数',
    displayNoteQuota: '额度',
    displayModels: '模型列表',
    displayModelsGrouped: '按供应商分类',
    displayModelsFlat: '平铺',
    displayShowModels: '浏览模型',
    modelsEmpty: '还没有可展示的模型',
    modelsHint: '点平台名展开它的模型；模型名就是对话里选的那个。',

};
export const WORDS_EN = {
    panelTitle: 'Magpie Panel',
    tabAgents: 'Providers',
    tabQuotas: 'Quotas',
    tabUsage: 'Usage',
    tabRouting: 'Routing',
    tabStore: 'Store',
    tabMore: 'More',
    sectionRouting: 'Request log',
    sectionStore: 'Installed',
    storeEmptyTitle: 'Nothing installed from the store',
    storeEmptyMessage: 'Install plugins from the Store tab on desktop; they will be listed here.',
    storeHint: 'Use the Store tab on desktop to install new plugins.',
    accounts: n => `${n} account${n === 1 ? '' : 's'}`,
    accountsInline: n => `${n} acct${n === 1 ? '' : 's'}`,
    modelsInline: n => `${n} model${n === 1 ? '' : 's'}`,
    back: 'Back',
    backToProviders: 'Back to providers',
    refreshQuota: 'Refresh quota',
    sectionQuota: 'Quota',
    noQuotaRows: 'No quota data for this account yet',
    noAccounts: 'No signed-in account yet',
    needLogin: 'needs sign-in',
    providerOff: 'disabled',
    signedInN: (ok, n) => `${ok}/${n} signed in`,
    summaryLine: (p, a, m) => `${p} providers · ${a} accounts · ${m} models`,
    summarySingle: (a, m) => `${a} account${a === 1 ? '' : 's'} · ${m} models`,
    keyFormsMore: n => `${n} more provider${n === 1 ? '' : 's'} need a key — sign in on desktop`,
    login: 'Sign in',
    loginWith: label => label,
    loginOpened: 'Authorisation page opened — tap "Done" when finished',
    loginDone: 'Done',
    loginKeyLabel: 'API key',
    loginSubmit: 'Save key',
    loginPending: 'Signing in…',
    moreProviders: n => `${n} more plugin${n === 1 ? '' : 's'} hidden`,
    moreAccounts: n => `${n} more account${n === 1 ? '' : 's'} hidden`,
    copySummary: 'Copy summary',
    signInExpired: 'Sign-in expired',
    signInKept: 'Signed in',
    signInRenewed: 'Renewed',
    signInUnknown: 'Sign-in unknown',
    errDpapi: 'This account was signed in on a Windows PC, so the phone cannot open it. Please sign in again on the phone.',
    errNetwork: 'Cannot reach the server. Check your network and retry.',
    errGeneric: 'This account cannot be read; you may need to sign in again on the phone.',
    balance: b => `Balance ${b}`,
    statusOk: 'OK',
    statusError: 'Failed',
    noProvidersTitle: 'No Magpie plugin installed',
    noProvidersMessage: 'Install a Magpie plugin to see accounts, quotas, usage and routing here.',
    diagTitle: 'What this scan found',
    diagRoot: 'Data directory',
    diagDeclared: 'Registered plugins',
    diagLoaded: 'Loaded',
    diagFailed: 'Failed',
    diagFirstError: 'First error',
    diagHint: 'If "Registered plugins" is 0 the data directory has no plugins.json yet; if "Failed" is above 0, that error is the reason.',
    diagNoRegistry: 'This data directory has no plugins.json: magpie has never run on this machine and no plugin data was copied over. The panel is fine, it just has nothing to read.',
    goToPlugins: 'Open the plugin page',
    goToPluginsHint: 'Search the built-in store, or paste an npm name / GitHub link',
    diagAllFailed: 'Plugins are registered but none loaded — see the first error above.',
    diagLoadedButEmpty: 'Plugins loaded but none declares a provider. They may only contribute tools, not models.',
    noQuotaTitle: 'No quota data yet',
    noQuotaMessage: 'Once a plugin declares the usage hook, its quota windows show up here.',
    noRoutingTitle: 'No requests yet',
    noRoutingMessage: 'Routing entries appear after the first model call.',
    refresh: 'Refresh',
    metricTokens: 'Tokens',
    metricCalls: 'Requests',
    metricErrors: 'Failures',
    metricCache: 'Cache hit rate',
    metricCost: 'Cost',
    metricUnpriced: (n) => `${n} unpriced`,
    metricPriced: 'at model rates',
    metricOfPrompt: 'of the prompt',
    metricNone: 'n/a',
    noUsageRows: 'No per-provider usage in this period',
    storeRest: n => `and ${n} more`,
    storeMore: n => `Show more (${n} left)`,
    metricFailed: (n) => `${n} failed`,
    kvInput: 'Input',
    kvOutput: 'Output',
    kvCacheRead: 'Cache read',
    kvCacheWrite: 'Cache write',
    kvRetried: 'Retried',
    colProvider: 'Provider',
    colTokens: 'Tokens',
    colCalls: 'Requests',
    colTtft: 'Avg TTFT',
    colTime: 'Time',
    colModel: 'Model',
    colStatus: 'Status',
    colLatency: 'Latency',
    periodToday: 'Today',
    period7d: '7 days',
    period30d: '30 days',
    periodAll: 'All',
    justNow: 'just now',
    minutesAgo: n => `${n} min ago`,
    hoursAgo: n => `${n} h ago`,
    updatedAt: t => `Updated ${t}`,
    navLabel: 'Pages',
    navAgents: 'Providers',
    navQuotas: 'Quotas',
    navUsage: 'Usage',
    navPlugins: 'Plugins',
    navStore: 'Store',
    navSettings: 'Settings',
    searchLabel: 'Search',
    searchPlaceholder: 'Provider name',
    searchSubmit: 'Search',
    searchClear: 'Clear search',
    searchResult: (n, q) => `${n} provider${n === 1 ? '' : 's'} matching “${q}”`,
    searchEmptyTitle: 'No matching provider',
    searchEmptyMessage: 'Try another keyword, or clear the search.',
    searchClose: 'Hide search',
    storeInstalledSection: 'Installed',
    storeAvailableSection: 'Available',
    installLabel: 'Install a plugin',
    installPlaceholder: 'npm package, or a GitHub link / owner/repo',
    installSubmit: 'Install',
    installHint: 'npm name / owner/repo / GitHub link',
    installRunning: spec => `Installing ${spec}…`,
    installDone: name => `Installed ${name}; plugins rescanned`,
    installFailed: msg => `Install failed: ${msg}`,
    storeEmptyAvailable: 'The market list is unavailable right now',
    settingsSection: 'Panel',
    pluginInstalledSection: n => `Installed plugins (${n})`,
    pluginCheckUpdates: 'Check for updates',
    pluginUpdating: 'Checking for updates...',
    pluginUpdated: 'Already up to date',
    pluginUpdateFound: n => `${n} plugin(s) have a newer version`,
    pluginUpdateFailed: msg => `Update check failed: ${msg}`,
    pluginUpdateAll: n => `Update all (${n})`,
    pluginUpdateAllNone: 'Update all',
    pluginUpdateTo: v => `update to v${v}`,
    pluginAndMore: n => `+${n} more`,
    pluginNoProvider: 'no providers',
    pluginOff: 'disabled',
    pluginOn: 'enabled',
    pluginOpenPlatform: 'accounts and quotas live here',
    pluginOptionsSection: 'Options',
    pluginOptionsHint: 'Plugin settings as a JSON object; saving rescans plugins',
    pluginOptionsLabel: 'Options (JSON)',
    pluginSaveOptions: 'Save options',
    pluginClearOptions: 'Clear options',
    pluginEnable: 'Enable plugin',
    pluginDisable: 'Disable plugin',
    pluginRemove: 'Remove plugin',
    pluginNone: 'No plugin loaded yet',
    pluginFailedSection: 'Failed to load',
    settingsPluginCount: n => `${n} plugin${n === 1 ? '' : 's'} loaded`,
    settingsModelCount: n => `${n} models`,
    settingsEntry: 'Panel entry',
    settingsReload: 'Rescan plugins',
    settingsRefresh: 'Refresh data',
    settingsVersion: v => `Version ${v}`,
    tokenSection: 'Repository tokens',
    tokenHint: 'Private repos only',
    tokenGithub: 'GitHub token',
    tokenNpm: 'npm token',
    tokenSave: 'Save tokens',
    tokenSavedHint: 'Stored locally, fetch only',
    tokenSaved: 'Tokens saved',
    displaySection: 'Display',
    displayStrip: 'Quota strip above the input',
    displayNote: 'Per-turn usage footnote',
    displayOn: 'Show',
    displayOff: 'Hide',
    displayNoteKind: 'Footnote shows',
    displayNoteTokens: 'tokens',
    displayNoteQuota: 'quota',
    displayModels: 'Model list',
    displayModelsGrouped: 'Grouped by provider',
    displayModelsFlat: 'Flat',
    displayShowModels: 'Browse models',
    modelsEmpty: 'No models to show yet',
    modelsHint: 'Tap a provider to expand its models; the names are what you pick in a chat.',

};
/** 只有以 `en` 开头才走英文；其余（含未给 locale）用中文。 */
function isEnglish(locale) {
    return typeof locale === 'string' && locale.trim().toLowerCase().startsWith('en');
}
/** 面向用户的文案集中入口。 */
function words(locale) {
    return isEnglish(locale) ? WORDS_EN : WORDS_ZH;
}
// ── 小工具（全部无副作用） ────────────────────────────────────────────────
/**
 * 主操作按钮（实心）。
 *
 * App 的 `actions` 节点在 v2 下**丢掉 `primary`**（`dsh_ui_blocks.dart:624`
 * `return DshUiV2ActionButton(...)` 不传 primary），所以 actions 里的按钮永远
 * 是「透明底 + 描边 + 文字」。唯一能画实心的是 form 的提交按钮
 * （`DshUiControlButton` + `tone: primary`）：满宽 tint 底 + 白字。
 *
 * form 的 `children` 允许为空数组（`_pluginControlContainer` 对 `[]` 只产生
 * 空 sections），所以这里拿「空表单 + submit」当纯按钮用，不引入输入框。
 * 一个视图里放多个 form 也是允许的（form 之间不嵌套即可）。
 */
function solidButton(label, action) {
    return {
        type: 'form',
        submit: action,
        submitLabel: label,
        children: [],
    };
}
function isFilled(value) {
    return typeof value === 'string' && value.trim() !== '';
}

/** 非空普通对象（`{}` 与数组都不算）——判断「有没有运行选项」。 */
function isFilledObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

/**
 * 把插件抛出来的底层错误翻译成用户能动手的一句话。
 *
 * 常见原文（都见过）：`这是 Windows DPAPI 密封的凭据，但当前环境没有 DPAPI，
 * 无法解开`、`sign_in_required`、`fetch failed`、`HTTP 401`。原文对排查有用，
 * 但摆在手机上只会让人以为插件坏了 —— 所以只保留能指导动作的那一类，
 * 其余归到 errGeneric（并在括号里留一小段原文，方便反馈）。
 */
function friendlyError(raw, w) {
    if (!isFilled(raw))
        return '';
    const text = String(raw);
    const lower = text.toLowerCase();
    if (lower.includes('dpapi') || lower.includes('windows 加密') || lower.includes('windows credential'))
        return w.errDpapi;
    if (lower.includes('sign_in_required') || lower.includes('401') || lower.includes('unauthorized')
        || lower.includes('invalid_credential') || lower.includes('expired'))
        return w.signInExpired;
    if (lower.includes('fetch failed') || lower.includes('econn') || lower.includes('etimedout')
        || lower.includes('timeout') || lower.includes('network'))
        return w.errNetwork;
    // 其余：截断后括在提示里，别让一长串堆栈把整页顶下去。
    const brief = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return `${w.errGeneric}（${brief}）`;
}

/**
 * 条目级错误行：额度、平台、账号三处共用同一种形状。
 */
function errorCallout(raw, w, label) {
    const text = friendlyError(raw, w);
    if (text === '')
        return undefined;
    return { type: 'callout', text: isFilled(label) ? `${label}：${text}` : text, tone: 'warn' };
}

/**
 * 包名的短形态：去掉 scope 与 `magpie-` 前缀，手机上一行放得下。
 * `@magpie-community/opencode-catpaw-auth` → `opencode-catpaw-auth`
 */
function shortPackage(name) {
    if (typeof name !== 'string')
        return '';
    const tail = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    return tail.replace(/^magpie-/, '');
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/** `a · b · c`，跳过空串与 undefined。 */
function joinDot(parts) {
    return parts.filter((part) => isFilled(part)).join(' · ');
}
/** 千分位分组（不用 toLocaleString，保证跨环境确定）。 */
/**
 * 紧凑数字：`9,982,511` → `998万`。
 *
 * 卡片右侧只有 ~90dp，七位数会把左侧的平台名与副标题挤成省略号
 * （真机截图里「腾讯 Marvis TENC…」和「已登…」都被切掉了）。
 */
function compactNumber(value) {
    const n = Math.abs(value);
    if (n >= 100_000_000)
        return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
    if (n >= 10_000)
        return `${Math.round(value / 10_000)}万`;
    return groupDigits(value);
}
function groupDigits(value) {
    if (!Number.isFinite(value))
        return '—';
    const rounded = Math.trunc(value);
    const negative = rounded < 0;
    const digits = String(Math.abs(rounded));
    let out = '';
    for (let i = 0; i < digits.length; i += 1) {
        if (i > 0 && (digits.length - i) % 3 === 0)
            out += ',';
        out += digits.charAt(i);
    }
    return negative ? `-${out}` : out;
}
function pad2(value) {
    return value < 10 ? `0${value}` : String(value);
}
/**
 * 费用文本。magpie 用 `≈¥…` 的形式（它按平台记账币种换算）；这里宿主只能用
 * 模型条目的美元单价，所以显示 `$`，并且**大额前加 `≈`**（是估算，不是账单）。
 */
function formatCost(usd) {
    if (!Number.isFinite(usd))
        return '—';
    if (usd >= 1000)
        return `≈$${groupDigits(Math.round(usd))}`;
    if (usd >= 1)
        return `≈$${usd.toFixed(2)}`;
    if (usd > 0)
        return `≈$${usd.toFixed(4)}`;
    return '$0';
}
/**
 * 缓存命中率。
 *
 * 口径照 magpie：`cache_read / (input + cache_read + cache_write)`。
 * 分母为 0 时返回 `—`（**不返回 0%** —— 那会被读成「一次都没命中」）。
 */
function cacheHitText(stats) {
    const prompt = (stats.inputTokens ?? 0) + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
    if (!(prompt > 0))
        return '—';
    return `${Math.round(((stats.cacheReadTokens ?? 0) / prompt) * 100)}%`;
}
/** 本地时间的绝对格式（panelData 里用，允许读时钟）。 */
function formatDateTime(at) {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function formatWhen(at, now, w) {
    if (!Number.isFinite(at))
        return '—';
    const diff = now - at;
    if (diff < 0)
        return formatDateTime(at);
    if (diff < 60_000)
        return w.justNow;
    if (diff < 3_600_000)
        return w.minutesAgo(Math.floor(diff / 60_000));
    if (diff < 86_400_000)
        return w.hoursAgo(Math.floor(diff / 3_600_000));
    return formatDateTime(at);
}
/**
 * 一个指标卡。
 *
 * `caption` 是 magpie 指标卡下面那行小字（「2.47亿 in · 2186.9万 out」、
 * 「245 个没有价格」、`占提示词`）—— 数值本身已经算好，这里只摆位置。
 *
 * ⚠️ App 的 `metric` 只有 `label / value / tone / caption / trend` 五个字段
 * （`dsh_ui_model.dart:101-119`），**没有** `captionTone`。不要自己加字段：
 * 解析器会静默忽略，代码看着像支持，实际什么都没发生。
 */
function metric(label, value, tone, caption) {
    const node = { type: 'metric', label, value };
    if (tone !== undefined)
        node.tone = tone;
    if (isFilled(caption))
        node.caption = caption;
    return node;
}
/**
 * 额度进度条：只有拿到有限数 `used` 才调用，绝不用 0 顶替。
 *
 * 用 `bar` 而不是 `ring`：手机上条状比环形省一半高度，而且「用了 99%」
 * 与「用了 60%」在 6px 的细条上一眼可辨 —— 环形恰恰是接近满额时最看不出
 * 来的形态，而那正是最该提醒的时刻（实测 2299/2300 的环只剩一个绿点）。
 *
 * `caption` 放在条尾（App 的 `shown` 优先取 caption），所以传人能读的余量
 * 文字，而不是让它回落成「99.96%」。
 */
function bar(label, value, caption, tone) {
    const node = { type: 'progress', shape: 'bar', value, max: 100, label, tone };
    if (isFilled(caption))
        node.caption = caption;
    return node;
}
function signInText(signIn, w) {
    if (signIn === 'expired')
        return w.signInExpired;
    if (signIn === 'kept')
        return w.signInKept;
    if (signIn === 'renewed')
        return w.signInRenewed;
    return w.signInUnknown;
}
/** 登录态 -> tone：`kept`/`renewed` 才是 good，缺失时不下结论。 */
function signInTone(signIn) {
    if (signIn === 'expired')
        return 'bad';
    if (signIn === 'kept' || signIn === 'renewed')
        return 'good';
    return 'muted';
}
/** 窗口的一行文字描述（用于不画环的场合，绝不编造占比）。 */
function windowText(win) {
    if (isFilled(win.display))
        return `${win.name}: ${win.display}`;
    if (isFiniteNumber(win.used))
        return `${win.name}: ${Math.round(win.used)}%`;
    return win.name;
}
// ── 视图（纯函数） ────────────────────────────────────────────────────────
/**
 * 面板视图。
 *
 * 结构：`{ v:2, type:'stack', children:[ tabs ] }`；没有任何 provider 时
 * 退化成单个 `emptyState`，绝不返回空 stack。
 *
 * 时钟相关的值（路由行、刷新时间）以 `{$:'data.routing.rows'}` /
 * `{$:'data.updatedAt'}` 绑定出去，由 `panelData` 用 `now` 解析；
 * 其余值都在这里就地算好，视图不依赖宿主是否回调数据。
 */
/**
 * 空态自证：把这次扫描的事实摊开。
 *
 * 面板空着时只有两种可能——数据根找错了，或者登记了但全部装载失败。
 * 这两种在界面上原本长得一样，用户只能来问我们；把根目录与计数写出来，
 * 用户截个图就能定位。
 */
function diagnosticsNodes(snapshot, w, { heading = true } = {}) {
    const d = snapshot?.diagnostics;
    if (d === undefined || d === null)
        return [];
    const rows = [
        [w.diagRoot, String(d.root ?? '')],
        [w.diagDeclared, String(d.declared ?? 0)],
        [w.diagLoaded, String(d.loaded ?? 0)],
        [w.diagFailed, String(d.failed ?? 0)],
    ];
    const nodes = [];
    if (heading === true)
        nodes.push({ type: 'text', text: `**${w.diagTitle}**` });
    nodes.push({ type: 'keyValue', items: rows.map(([k, v]) => ({ key: k, value: v })) });
    if (typeof d.firstError === 'string' && d.firstError !== '')
        nodes.push({ type: 'text', text: `${w.diagFirstError}：${d.firstError.slice(0, 120)}`, tone: 'warn' });
    // 直接给结论：用户看到空面板时最想知道的是「那我该做什么」。
    if ((d.declared ?? 0) === 0)
        nodes.push({ type: 'text', text: w.diagNoRegistry, tone: 'warn' });
    else if ((d.loaded ?? 0) === 0)
        nodes.push({ type: 'text', text: w.diagAllFailed, tone: 'warn' });
    else if ((d.loaded ?? 0) > 0)
        nodes.push({ type: 'text', text: w.diagLoadedButEmpty, tone: 'warn' });
    nodes.push({ type: 'text', text: w.diagHint, tone: 'muted' });
    return nodes;
}

export function panelView(snapshot, caps, ui) {
    const w = words(caps?.locale);
    const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
    // ⚠ 没有 provider 时**不能**退化成整页空态。
    // 面板是用户唯一的入口：整页占掉之后插件页与商店都进不去，新用户就永远
    // 没办法自己装一个 magpie 插件，也没法登录任何平台。所以页签照常渲染，
    // 平台页里给一段引导 + 这次扫描的事实。
    // 详情视图（用户点开某一平台的卡片后）：整页换成这一家的账号与额度，
    // 顶部给「‹ 返回」。App 没有弹窗/抽屉节点，`refresh` 换视图是唯一能做到
    // 「点卡片弹出详情」的路径（规范 §3.5 效果白名单含 `refresh`）。
    const focus = typeof ui?.focus === 'string'
        ? providers.find(p => p.id === ui.focus)
        : undefined;
    if (focus !== undefined && focus !== null) {
        return {
            v: VIEW_VERSION,
            // 品牌紫作视图 accent：App 的 v2 按钮描边与图标用 accent 着色，
            // 不设就落到默认灰，看起来像「白按钮」。
            type: 'stack',
            title: w.panelTitle,
            children: providerDetail(snapshot, focus, w),
        };
    }
    // 插件配置页（点插件列表里的某一行进来）：整页换成它的配置，
    // 与平台详情同一套「refresh 换视图」的做法。
    const editing = pluginOf(snapshot, ui);
    if (editing !== undefined) {
        return {
            v: VIEW_VERSION,
            // 品牌紫作视图 accent：App 的 v2 按钮描边与图标用 accent 着色，
            // 不设就落到默认灰，看起来像「白按钮」。
            type: 'stack',
            title: w.panelTitle,
            children: pluginDetailPage(snapshot, editing, w),
        };
    }
    // 模型页（从设置页的「浏览模型」进来）。
    if (ui?.models === true) {
        return {
            v: VIEW_VERSION,
            type: 'stack',
            title: w.panelTitle,
            children: modelsPage(snapshot, w, ui?.display ?? null),
        };
    }
    const page = PAGES.includes(ui?.page) ? ui.page : PAGE_AGENTS;
    const query = typeof ui?.query === 'string' ? ui.query : '';
    return {
        v: VIEW_VERSION,
        // 品牌紫作视图 accent：App 的 v2 按钮描边与图标都用它着色，
        // 不设会落到 `DshUiPluginPalette.defaultAccent`（0x3D6FD6，主题蓝）。
        type: 'stack',
        title: w.panelTitle,
        children: [navChips(page, w), ...pageBody(snapshot, page, query, w, normalizeInstallStatus(ui?.install, w), ui?.update, ui?.storeLimit ?? STORE_PAGE, ui?.display ?? null)],
    };
}
/**
 * 顶部自绘导航（`chips` 横向换行）。
 *
 * 为什么不用 App 的 `tabs`：那个按面板宽度最多摆 3 列、4 个页签就折成 3+1
 * （`dsh_ui_plugin_choice.dart:292`），而且样式由 App 决定、跟 magpie 的观感
 * 不一致。`chips` 是 `Wrap`（`dsh_ui_plugin_choice.dart:222`），能横排换行，
 * 加多少个页面都不会塌成两行控件。
 *
 * `bind: 'data.ui.page'` 是**必填**：控件只有带 bind 才可写（`_pluginInput`
 * 里 `readOnly = bind == null || …`），点击后 App 会把 `{bind, value}` 发回
 * `onChange` 指定的 action，插件存下当前页再 `refresh`。
 */
function navChips(page, w) {
    return {
        type: 'chips',
        label: w.navLabel,
        bind: 'data.ui.page',
        value: page,
        // 只放 5 个：App 的 `DshUiChips` 是 `Wrap` 自动换行（`dsh_ui_plugin_choice.dart:222`），
        // 6 个中文标签在手机宽度下折成 5+1，「设置」单独掉到第二行，
        // 看起来像另一组不相干的控件。所以页签固定 5 个，把「商店」并进「插件」页。
        options: [
            { label: w.navAgents, value: PAGE_AGENTS },
            { label: w.navQuotas, value: PAGE_QUOTAS },
            { label: w.navUsage, value: PAGE_USAGE },
            { label: w.navPlugins, value: PAGE_PLUGINS },
            { label: w.navSettings, value: PAGE_SETTINGS },
        ],
        onChange: { id: 'switchPage' },
    };
}
/** 当前页的正文。 */
/**
 * 后台安装的状态行。
 *
 * 安装是一次点击触发的长任务（下载 + 解包 + 重扫），App 的点击窗口只有 3 秒，
 * 所以结果只能落到快照里回推。这里把它翻成一行文字 + 一个色调：
 * `running` 灰、`ok` 绿、`failed` 红。
 */
function normalizeInstallStatus(raw, w) {
    if (raw === null || typeof raw !== 'object')
        return null;
    const spec = typeof raw.spec === 'string' ? raw.spec : '';
    if (spec === '')
        return null;
    if (raw.state === 'running') {
        return { text: w.installRunning(spec), tone: 'muted' };
    }
    if (raw.state === 'ok') {
        const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : spec;
        return { text: w.installDone(name), tone: 'good' };
    }
    if (raw.state === 'failed') {
        const reason = typeof raw.error === 'string' && raw.error !== '' ? raw.error : w.metricNone;
        return { text: w.installFailed(reason), tone: 'bad' };
    }
    return null;
}
/**
 * 检查更新 / 批量更新的状态行。
 *
 * 和安装一样是后台任务（要问 npm registry，11 个包串行十几秒），App 的点击
 * 窗口只有 3 秒，所以结果只能回推到快照里。
 */
function normalizeUpdateStatus(raw, w) {
    if (raw === null || typeof raw !== 'object')
        return null;
    if (raw.state === 'running')
        return { text: w.pluginUpdating, tone: 'muted' };
    if (raw.state === 'ok') {
        const n = Array.isArray(raw.updatable) ? raw.updatable.length : 0;
        return n === 0
            ? { text: w.pluginUpdated, tone: 'good' }
            : { text: w.pluginUpdateFound(n), tone: 'warn' };
    }
    if (raw.state === 'failed')
        return { text: w.pluginUpdateFailed(String(raw.error ?? w.metricNone)), tone: 'bad' };
    return null;
}
function pageBody(snapshot, page, query, w, installStatus, updateStatus = null, storeLimit = STORE_PAGE, display = null) {
    switch (page) {
        case PAGE_QUOTAS:
            return quotaTab(snapshot, w);
        case PAGE_USAGE:
            return usageTab(snapshot, w);
        case PAGE_PLUGINS:
        case PAGE_STORE:
            // 商店已并入插件页；旧状态里残留的 page=store 也渲染插件页，避免空白。
            return pluginsPage(snapshot, w, updateStatus, storeLimit);
        case PAGE_SETTINGS:
            return settingsPage(snapshot, w, display);
        default:
            return agentTab(snapshot, w, query);
    }
}
/**
 * 插件页：已装的插件、它带来的平台、更新。
 *
 * 用户原话：「新增插件页：查看已安装插件并配置，只有登录需求时跳转到平台界面」
 * 「查询页面一键检查哪些插件有更新并一键更新」。
 *
 * 插件本身没有「配置」概念，配置都在它声明的平台上，所以每行点进去就是
 * **跳到平台页并聚焦它的第一个平台**——登录也只在那里做，不另开入口。
 */
function pluginsPage(snapshot, w, updateStatus = null, storeLimit = STORE_PAGE) {
    const plugins = Array.isArray(snapshot.plugins) ? snapshot.plugins : [];
    const failures = Array.isArray(snapshot.pluginFailures) ? snapshot.pluginFailures : [];
    const children = [];
    // 更新状态同样走数据绑定：检查更新是后台任务，完成时没有 action 能 refresh。
    children.push({ type: 'text', text: { $: 'data.updateStatusLine' }, tone: 'muted' });
    // 两个动作放同一个 list 里**常显**：检查更新是后台任务，完成时没有任何
    // action 能返回 `refresh`，视图不会被重建 —— 靠 `updateStatus` 决定这一行
    // 显示与否永远不会生效。没有可更新时点击会 toast 说明。
    const updateCount = Array.isArray(updateStatus?.updatable) ? updateStatus.updatable.length : 0;
    children.push(solidButton(w.pluginCheckUpdates, 'checkUpdates'));
    children.push({
        type: 'actions',
        items: [
            {
                label: updateCount > 0 ? w.pluginUpdateAll(updateCount) : w.pluginUpdateAllNone,
                icon: 'retry',
                action: 'updateAllPlugins',
            },
        ],
    });
    children.push({ type: 'text', text: `**${w.pluginInstalledSection(plugins.length)}**` });
    if (plugins.length === 0) {
        children.push({ type: 'text', text: w.pluginNone, tone: 'muted' });
    }
    else {
        children.push({
            type: 'list',
            items: plugins.slice(0, MAX_PLUGIN_ROWS).map(plugin => {
                const providerNames = (plugin.providers ?? []).map(id => providerName(snapshot, id));
                // 标题给平台名（用户认的是 WPS 灵犀，不是 @scope/wps-lingxi）；
                // 包名放副标题第一段，装的是哪个包仍然一眼能看到。
                const title = providerNames.length === 0
                    ? shortPackage(plugin.packageName ?? plugin.spec)
                    : providerNames[0] + (providerNames.length > 1 ? ` ${w.pluginAndMore(providerNames.length - 1)}` : '');
                const bits = [shortPackage(plugin.packageName ?? plugin.spec)];
                if (isFilled(plugin.version))
                    bits.push(`v${plugin.version}`);
                // 停用的插件仍在列表里（`runtime.js` 不装载它，但用户要能点回来启用）
                if (plugin.off === true)
                    bits.push(w.pluginOff);
                if (plugin.updateTo !== undefined)
                    bits.push(w.pluginUpdateTo(plugin.updateTo));
                return {
                    title,
                    subtitle: joinDot(bits.map(String)),
                    icon: 'plugin',
                    ...(plugin.updateTo === undefined ? {} : { tone: 'warn' }),
                    // 点整行进这个插件的配置页（运行选项、开关、移除都在那里）；
                    // 平台入口在配置页里再列出来 —— 与桌面端的 Options/Switch/Remove
                    // 同一套操作，只是手机上一屏放不下、拆成独立一页。
                    action: { id: 'openPlugin', args: { spec: plugin.spec } },
                };
            }),
        });
    }
    // 商店并入本页：页签只有 5 个，装新插件在「已安装」列表下面。
    children.push({ type: 'text', text: `**${w.storeAvailableSection}**` });
    children.push(...storeSection(snapshot, w, storeLimit));
    if (failures.length > 0) {
        children.push({ type: 'text', text: `**${w.pluginFailedSection}**` });
        children.push({
            type: 'list',
            items: failures.slice(0, 5).map(f => ({
                title: f.spec,
                subtitle: String(f.error ?? '').slice(0, 120),
                icon: 'warning',
                tone: 'bad',
            })),
        });
    }
    return children;
}
/**
 * 找到当前要配置的那个插件（插件页详情用）。
 *
 * `ui.plugin` 存的是 spec；`snapshot.plugins` 是 `pluginPageEntries()` 的结果，
 * 每条的 `spec` 已经回填成 `plugins.json` 里的原始写法（可能带 `@latest`、
 * 可能是 `github:owner/repo`），所以两边要对得上。
 */
function pluginOf(snapshot, ui) {
    const spec = typeof ui?.plugin === 'string' ? ui.plugin : '';
    if (spec === '')
        return undefined;
    const list = Array.isArray(snapshot?.plugins) ? snapshot.plugins : [];
    return list.find(p => p.spec === spec || p.packageName === spec);
}
/**
 * 配置框的初值文本：已保存的 `options` 优先，否则用包里的示例。
 *
 * 与桌面端 `ui/plugins.js:1366` 的 `e.options || e.optionsExample` 同一套
 * 顺序，只是这里渲染成带缩进的 JSON 文本（App 没有 JSON 编辑器，只有多行
 * 文本框）。
 */
/** 插件配置页顶部那行：版本 · 启用状态 · 可更新到。 */
function pluginStateText(plugin, w) {
    if (plugin === undefined)
        return '';
    const bits = [];
    if (isFilled(plugin.version))
        bits.push(`v${plugin.version}`);
    bits.push(plugin.off === true ? w.pluginOff : w.pluginOn);
    if (plugin.updateTo !== undefined)
        bits.push(w.pluginUpdateTo(plugin.updateTo));
    return bits.join(' · ');
}
function pluginOptionsText(snapshot, ui) {
    const plugin = pluginOf(snapshot, ui);
    const value = isFilledObject(plugin?.options) ? plugin.options
        : isFilledObject(plugin?.optionsExample) ? plugin.optionsExample
            : undefined;
    if (value === undefined)
        return '';
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return '';
    }
}
/**
 * 插件配置页（对齐桌面端的 `Options` / `Switch off` / `Remove`）。
 *
 * 桌面端在插件列表里就地展开一个 JSON 编辑器；手机面板一屏放不下，做成
 * 独立一页：返回 → 名称与版本 → 平台入口 → 运行选项 → 开关 / 移除。
 */
function pluginDetailPage(snapshot, plugin, w) {
    const children = [];
    children.push({
        type: 'list',
        items: [{ title: `‹ ${w.navPlugins}`, icon: 'collapse', action: 'closePlugin' }],
    });
    const pkg = plugin.packageName ?? plugin.spec;
    children.push({ type: 'text', text: `**${shortPackage(pkg)}**` });
    // 这一行用**数据绑定**：启用/停用是后台动作，完成后没有 action 能返回
    // `refresh`，视图不会重建 —— 写死的「已启用」会一直停在旧值。
    children.push({ type: 'text', text: { $: 'data.pluginStateLine' }, tone: 'muted' });
    // 它带来的平台：点一个就进那个平台的详情（账号、额度、登录都在那边）。
    const providerNames = (plugin.providers ?? []).map(id => providerName(snapshot, id));
    if (plugin.providers?.length > 0) {
        children.push({ type: 'list', items: plugin.providers.map((id, index) => ({
                title: providerNames[index] ?? id,
                subtitle: w.pluginOpenPlatform,
                icon: 'plugin',
                action: { id: 'openProvider', args: { provider: id } },
            })) });
    }
    else {
        children.push({ type: 'text', text: w.pluginNoProvider, tone: 'muted' });
    }
    children.push({ type: 'text', text: `**${w.pluginOptionsSection}**` });
    children.push({ type: 'text', text: w.pluginOptionsHint, tone: 'muted' });
    // ⚠ 保存必须走 `form` 的 submit，不能用一个 actions 按钮：
    // `actions` 的 `PluginAction` 不带任何控件值，插件端拿不到输入框内容。
    // form 提交时 App 会把**所有** input 的当前值打包进 `args.values`
    // （设置页的仓库密钥就是这么存进 hub-settings.json 的）。
    children.push({
        type: 'form',
        submit: 'savePluginOptions',
        submitLabel: w.pluginSaveOptions,
        children: [{
                type: 'textField',
                label: w.pluginOptionsLabel,
                bind: 'data.plugin.options',
                value: pluginOptionsText(snapshot, { plugin: plugin.spec }),
                placeholder: '{"key": "value"}',
                multiline: true,
                maxLines: 8,
                maxLength: 2000,
            }],
    });
    children.push({
        type: 'actions',
        items: [{ label: w.pluginClearOptions, icon: 'clear', action: 'clearPluginOptions' }],
    });
    // 开关拆成两个**固定文案**的按钮：后台动作完成后没有 action 能返回
    // `refresh`，视图不会重建，共用一个「停用/启用」按钮的文案会停在旧值。
    children.push({
        type: 'actions',
        items: [
            { label: w.pluginEnable, icon: 'toggle', action: 'enablePlugin' },
            { label: w.pluginDisable, icon: 'toggle', action: 'disablePlugin' },
        ],
    });
    children.push({
        type: 'actions',
        items: [{ label: w.pluginRemove, icon: 'trash', action: 'removePlugin' }],
    });
    return children;
}
/**
 * 商店页：已装 / 可装 / 手输安装。
 *
 * 用户原话：「商店就是安装插件的，安卓插件也允许用户自己输入 npm 包或者
 * github 链接」「自行输入包名和链接，放到商店页的最底部」。
 */
function storeSection(snapshot, w, limit = STORE_PAGE) {
    const items = Array.isArray(snapshot.store) ? snapshot.store : [];
    // 「已安装」由上面的插件列表负责（以 `snapshot.plugins` 真实装载为准），
    // 这里只列市场里**还没装**的包，避免同一个包在页面上出现两次。
    const loaded = Array.isArray(snapshot.plugins) ? snapshot.plugins : [];
    const loadedPkgs = new Set(loaded.map(p => p.packageName).filter(Boolean));
    const available = items.filter(item => item.installed !== true && !loadedPkgs.has(item.package));
    const children = [];
    // 安装结果放最上面：装完会有新包出现，用户在顶部就能看到「成了/为什么失败」。
    //
    // ⚠ 用 `{$:'data.…'}` 绑定而不是写死文字：安装是后台跑的，完成时没有 action
    // 可以返回 `refresh`，视图函数不会被重新调用——只有 `data` 的推送会重绘。
    children.push({ type: 'text', text: { $: 'data.installStatusLine' }, tone: 'muted' });
    if (available.length === 0) {
        children.push({ type: 'text', text: w.storeEmptyAvailable, tone: 'muted' });
    }
    else {
        const shown = available.slice(0, Math.max(STORE_PAGE, limit));
        children.push({
            type: 'list',
            items: shown.map(item => ({
                title: item.name || item.package,
                subtitle: item.package,
                icon: 'download',
                action: { id: 'installPlugin', args: { spec: item.package } },
            })),
        });
        // 市场里有上百个包，一次全铺出来要滑十几次才到底（用户抱怨过）。
        if (available.length > shown.length) {
            children.push({
                type: 'list',
                items: [{
                        title: w.storeMore(available.length - shown.length),
                        icon: 'expand',
                        action: 'moreStore',
                    }],
            });
        }
    }
    // 手输安装：放在本页**最底部**（用户明确要求的位置），不与上面的列表抢注意力。
    children.push({ type: 'text', text: `**${w.installLabel}**` });
    children.push({
        type: 'form',
        columns: 1,
        children: [{
                type: 'textField',
                label: w.installLabel,
                bind: 'data.install.spec',
                placeholder: w.installPlaceholder,
                maxLength: 300,
            }],
        submit: 'installSpec',
        submitLabel: w.installSubmit,
    });
    children.push({ type: 'text', text: w.installHint, tone: 'muted' });
    return children;
}
/** 设置页：面板自身的动作（都在 list 行里，v2 的 actions 会变成满宽大按钮）。 */
/**
 * 模型页：列出所有平台声明的模型。
 *
 * 用户原话：「模型是按供应商分类，还是不用分类」→ 选了「按供应商分类」，
 * 并要求在设置里能改。所以两种排法都做：`group` 用 `collapsible` 每个
 * 平台一个（默认收起，76 个模型不至于一屏铺不完），`flat` 用一个 list 平铺。
 *
 * ⚠ 不新增第 6 个页签：App 的 `DshUiChips` 是 `Wrap`，6 个中文标签会折成
 * 5+1（「设置」掉第二行）—— 所以模型页挂在设置页里，用 `refresh` 换视图。
 */
function modelsPage(snapshot, w, display = null) {
    const providers = (Array.isArray(snapshot.providers) ? snapshot.providers : [])
        .filter((p) => Array.isArray(p.modelIds) && p.modelIds.length > 0);
    const total = providers.reduce((sum, p) => sum + p.modelIds.length, 0);
    const children = [
        // 整页替换时 App 的标题栏会盖住内容最顶上那一条，返回行会被压到
        // `[88,0][992,88]` 这种点不到的位置。留一行空白把它顶下去。
        { type: 'text', text: ' ' },
        {
            type: 'list',
            items: [{ title: `‹ ${w.navSettings}`, icon: 'collapse', action: 'closeModels' }],
        },
        { type: 'text', text: `**${w.displayShowModels}**` },
        { type: 'text', text: w.settingsModelCount(total), tone: 'muted' },
    ];
    if (total === 0) {
        children.push({ type: 'text', text: w.modelsEmpty, tone: 'muted' });
        return children;
    }
    if (display?.models === 'flat') {
        // 平铺时平台名只能进副标题，否则看不出是哪个平台声明的。
        children.push({
            type: 'list',
            items: providers.flatMap((p) => p.modelIds.map((id) => ({
                title: typeof id === 'string' ? id : String(id),
                subtitle: p.name,
                icon: 'model',
            }))),
        });
    }
    else {
        for (const p of providers) {
            children.push({
                type: 'collapsible',
                label: `${p.name}（${p.modelIds.length}）`,
                children: [{
                        type: 'list',
                        items: p.modelIds.map((id) => ({
                            title: typeof id === 'string' ? id : String(id),
                            icon: 'model',
                        })),
                    }],
            });
        }
    }
    children.push({ type: 'text', text: w.modelsHint, tone: 'muted' });
    return children;
}
function settingsPage(snapshot, w, display = null) {
    const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
    const accounts = providers.reduce((sum, p) => sum + (Array.isArray(p.accounts) ? p.accounts.length : 0), 0);
    const models = providers.reduce((sum, p) => sum + (isFiniteNumber(p.models) ? p.models : 0), 0);
    return [
        { type: 'text', text: `**${w.settingsSection}**` },
        {
            type: 'keyValue',
            items: [
                [w.navAgents, `${providers.length}`],
                [w.accounts(accounts), `${accounts}`],
                [w.modelsInline(models), `${models}`],
            ],
        },
        solidButton(w.settingsReload, 'reloadPlugins'),
        {
            type: 'actions',
            items: [{ label: w.settingsRefresh, icon: 'retry', action: 'refreshStats' }],
        },
        // 显示偏好。三项都是 `chips`（带 bind 才能写），点一下立刻生效 ——
        // 状态条与脚注是 App 常驻的位置，用户随口就能关掉比翻开关重要。
        { type: 'text', text: `**${w.displaySection}**` },
        {
            type: 'chips',
            label: w.displayStrip,
            bind: 'data.display.strip',
            value: display?.strip === false ? 'off' : 'on',
            options: [
                { label: w.displayOn, value: 'on' },
                { label: w.displayOff, value: 'off' },
            ],
            onChange: { id: 'setDisplay' },
        },
        {
            type: 'chips',
            label: w.displayNote,
            bind: 'data.display.note',
            value: display?.note === false ? 'off' : 'on',
            options: [
                { label: w.displayOn, value: 'on' },
                { label: w.displayOff, value: 'off' },
            ],
            onChange: { id: 'setDisplay' },
        },
        // 脚注写什么只在脚注打开时有意义，关掉就不显示这一行，少一项干扰。
        ...(display?.note === false
            ? []
            : [{
                    type: 'chips',
                    label: w.displayNoteKind,
                    bind: 'data.display.noteKind',
                    value: display?.noteKind === 'quota' ? 'quota' : 'tokens',
                    options: [
                        { label: w.displayNoteTokens, value: 'tokens' },
                        { label: w.displayNoteQuota, value: 'quota' },
                    ],
                    onChange: { id: 'setDisplay' },
                }]),
        { type: 'text', text: `**${w.displayModels}**` },
        {
            type: 'chips',
            label: w.displayModels,
            bind: 'data.display.models',
            value: display?.models === 'flat' ? 'flat' : 'group',
            options: [
                { label: w.displayModelsGrouped, value: 'group' },
                { label: w.displayModelsFlat, value: 'flat' },
            ],
            onChange: { id: 'setDisplay' },
        },
        {
            // 模型只是「看得见的名字」，没有可点的动作，所以做成一行入口而不是
            // 在设置页里铺 76 行。
            type: 'list',
            items: [{
                    title: w.displayShowModels,
                    icon: 'model',
                    action: 'showModels',
                }],
        },
        // 私密仓库的凭据。**放设置页而不是商店页**：认证明明是一次性配置，
        // 混在「装什么包」旁边会让人以为每装一个都要重填。
        // 诊断：数据目录、登记数、装载数 —— 排障时才有用。
        // 放设置页最下面，不进平台页（那里要留给「下一步该做什么」）。
        // 快照没带 `diagnostics` 时整段都不要，否则只剩一个空标题。
        ...(snapshot?.diagnostics === undefined || snapshot?.diagnostics === null
            ? []
            : [
                { type: 'text', text: `**${w.diagTitle}**` },
                ...diagnosticsNodes(snapshot, w, { heading: false }),
            ]),
        { type: 'text', text: `**${w.tokenSection}**` },
        { type: 'text', text: w.tokenHint },
        {
            // 两个 token 是同一件事的两项，横排一行即可；竖排白白吃掉两屏高
            // （用户「有些元素可以横着排列」）。
            //
            // ⚠ `form.columns` 只对 `grid` 生效，form 自己永远是 Column ——
            // 所以并排必须套一层 `grid`。grid 的单元格最小宽 136dp
            // （`dshUiPluginContentMinWidth`），面板内容约 300dp，两列刚好放下。
            // `grid` 是 DshUiControlContainer，form 的 `inputs` 会递归收进去，
            // 提交时照样拿得到值。
            type: 'form',
            submit: 'saveTokens',
            submitLabel: w.tokenSave,
            children: [{
                type: 'grid',
                columns: 2,
                children: [
                    {
                        type: 'textField',
                        label: w.tokenGithub,
                        bind: 'data.tokens.github',
                        placeholder: 'ghp_…',
                        lines: 1,
                    },
                    {
                        type: 'textField',
                        label: w.tokenNpm,
                        bind: 'data.tokens.npm',
                        placeholder: 'npm_…',
                        lines: 1,
                    },
                ],
            }],
        },
    ];
}
/**
 * 页签五：商店（**只列已装的包**）。
 *
 * 完整的市场浏览/搜索/安装是桌面端的事：手机快照只带 `store`（已装包的
 * 元信息，见 PanelSnapshot），85 条市场全量会拖慢面板与超出节点预算。
 * 这里每条一行 list + 它声明的 provider id——用户能看出「这个包装了、
 * 提供 codearts」，要装新的去桌面端。
 */
/**
 * 已装的包：**一个 list，不是一堆 collapsible**。
 *
 * 旧版每个包一个折叠块，12 个包把平台页撑成几百 dp 的灰色条带（真机截图
 * 里整页只剩包名），而它们几乎从不展开。改成行式列表后同样信息只占 4 行，
 * 而且 `subtitle` 能直接写出包名，比「先展开才能看到包名」少一次点击。
 */
function storeTab(snapshot, w) {
    const items = Array.isArray(snapshot.store) ? snapshot.store : [];
    if (items.length === 0) {
        return [{ type: 'emptyState', title: w.storeEmptyTitle, message: w.storeEmptyMessage, icon: 'plugin' }];
    }
    // 一行文字，不是一列菜单。
    // 这一节的回答是「我装了哪些包」，扫一眼就够；用 list 画出来要 4 行 200 多 dp，
    // 却把真正要操作的账号与登录入口挤了下去（真机首屏实测）。
    const names = items.slice(0, MAX_STORE_ROWS).map(item => item.name || item.package);
    const rest = items.length - names.length;
    const text = rest > 0
        ? `${names.join(' · ')} ${w.storeRest(rest)}`
        : names.join(' · ');
    return [{ type: 'text', text, tone: 'muted' }];
}
/**
 * 页签一：**一个平台一张卡片**，点开看详情。
 *
 * 用户原话：「把折叠列表那里弄成卡片样式。点击后弹出弹窗，卡片显示当前平台的
 * 名称、账号、额度等等」。手机上先给「有哪些平台、各是什么状态」，
 * 而不是把 12 个平台的账号与登录入口一次性铺开——那要滑很久才看得完。
 *
 * 卡片信息三行以内：平台名 / 账号数与模型数 / 额度剩余。
 * 平台名只出现这一次（旧版在折叠标题、账号 subtitle、额度标题各写一遍）。
 */
function agentTab(snapshot, w, query = '') {
    const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
    if (providers.length === 0) {
        // 一个平台都没有：普通用户看到的应该是「下一步去哪」，
        // 不是数据目录、装载计数这些排障信息（那些放在设置页的「诊断」里）。
        // 商店在插件页底部，所以这里直接给一个跳过去的路由。
        return [
            { type: 'text', text: `**${w.noProvidersTitle}**` },
            { type: 'text', text: w.noProvidersMessage, tone: 'muted' },
            {
                type: 'list',
                items: [{
                    title: w.goToPlugins,
                    subtitle: w.goToPluginsHint,
                    icon: 'plugin',
                    action: { id: 'switchPage', args: { page: PAGE_PLUGINS } },
                }],
            },
        ];
    }
    const keyword = typeof query === 'string' ? query.trim().toLowerCase() : '';
    // 搜索：匹配平台名或 provider id（用户可能记得 `wps-lingxi` 而不记得中文名）
    const matched = keyword === ''
        ? providers
        : providers.filter(p => p.name.toLowerCase().includes(keyword) || p.id.toLowerCase().includes(keyword));
    const shown = matched.slice(0, MAX_AGENT_PROVIDERS);
    const children = [];
    // 搜索：**一个常显输入框**，不折叠、不配提交按钮。
    //
    // 之前做成「一行 52dp 的列表项，点了才展开表单」，用户直接否掉了：
    // 「搜索按钮还是很大，图标也不对」。App 的输入框自带 label（16dp）+ 8dp
    // 间距 + 48dp 输入区 + 右下角字数计数，这些是 App 硬编码的，插件去不掉；
    // 能省的是折叠那一行与满宽提交按钮，所以这里直接放裸 textField，
    // 用 `onChange` 边打边过滤（App 会 debounce 后发 `searchProviders`）。
    children.push({
        type: 'textField',
        label: w.searchLabel,
        bind: 'data.search.query',
        value: typeof query === 'string' ? query : '',
        placeholder: w.searchPlaceholder,
        maxLength: 40,
        onChange: { id: 'searchProviders' },
    });
    if (keyword !== '') {
        if (matched.length === 0) {
            children.push({ type: 'emptyState', title: w.searchEmptyTitle, message: w.searchEmptyMessage, icon: 'web-search' });
            return children;
        }
    }
    // 页顶不再报「N 个平台 · N 个账号 · N 个模型」：每张卡片的副标题已经写了
    // 账号与模型数，页顶再报一遍只是把卡片往下推（用户「删掉没必要的文字」）。
    const cards = [];
    for (const provider of shown) {
        const cardError = errorCallout(provider.error, w, provider.name);
        if (cardError !== undefined)
            children.push(cardError);
        cards.push(providerCard(snapshot, provider, w));
    }
    children.push({ type: 'list', items: cards });
    const hidden = matched.length - shown.length;
    if (hidden > 0)
        children.push({ type: 'text', text: w.moreProviders(hidden), tone: 'muted' });
    // 「已装的包」不再挂这里：它已经搬去「商店」页（用户问「已安装的包是什么意思」
    // ——混在平台页里既占地方又语义不清）。平台页只回答「我有哪些平台」。
    return children;
}
/**
 * 一张平台卡片（list 行）。
 *
 * `trailing` 放额度摘要，`subtitle` 放「N 个账号 · N 个模型 · 登录态」——
 * list 行只有一行的高度，这两处是唯一能塞信息的位置。
 */
function providerCard(snapshot, provider, w) {
    const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
    const row = {
        title: provider.name,
        icon: 'plugin',
        action: { id: 'openProvider', args: { provider: provider.id } },
    };
    const parts = [];
    if (provider.off === true)
        parts.push(w.providerOff);
    parts.push(w.accountsInline(accounts.length));
    if (isFiniteNumber(provider.models))
        parts.push(w.modelsInline(provider.models));
    const ok = accounts.filter(a => a.signIn === 'kept' || a.signIn === 'renewed').length;
    if (accounts.length > 0)
        parts.push(ok === 0 ? w.needLogin : w.signedInN(ok, accounts.length));
    row.subtitle = joinDot(parts);
    const left = providerLeftText(snapshot, provider.id);
    if (left !== undefined)
        row.trailing = left;
    return row;
}
/**
 * 平台卡片右侧的额度摘要：`剩 2,299`。
 *
 * 只给「还剩多少」这一个数——总量在详情页的进度条上有；
 * 卡片上写 `剩 2,299 / 2,300` 会挤掉平台名。
 */
function providerLeftText(snapshot, providerId) {
    const usage = Array.isArray(snapshot.usage) ? snapshot.usage : [];
    for (const item of usage) {
        if (item.provider !== providerId)
            continue;
        for (const win of item.windows ?? []) {
            if (!isFiniteNumber(win.limit) || !isFiniteNumber(win.amount))
                continue;
            const left = win.limit - win.amount;
            if (left <= 0)
                return undefined;
            return `剩 ${compactNumber(left)}`;
        }
    }
    return undefined;
}
/**
 * 详情视图：一个平台的账号 + 额度 + 登录入口。
 *
 * `progress` 画「剩余」（`remainingPercent`），条尾给「剩 2,299 / 2,300」，
 * 这样条的长度和右边那句数字永远说的是同一件事。
 */
function providerDetail(snapshot, provider, w) {
    const children = [];
    // 返回用 list 行，不用 `actions`：v2 视图下 actions 是满宽描边大按钮
    // （100dp 一个），而返回只是导航，视觉上不该和「登录」抢注意力。
    // 返回：`‹` 文字 + `collapse` 图标。App 的 43 个合法图标里**没有箭头**
    // （`native_icons.dart`），之前写的 `chevron-left` 会退化成默认图标
    // （真机上看起来像一道闪电）。用 `<` 符号 + 收起图标，视觉上就是「左上角返回」。
    children.push({
        type: 'list',
        items: [{ title: `‹ ${w.backToProviders}`, icon: 'collapse', action: 'closeProvider' }],
    });
    children.push({ type: 'text', text: `**${provider.name}**` });
    const accounts = Array.isArray(provider.accounts) ? provider.accounts.slice(0, MAX_AGENT_ACCOUNTS) : [];
    const detailError = errorCallout(provider.error, w, '');
    if (detailError !== undefined)
        children.push(detailError);
    children.push(accounts.length === 0
        ? { type: 'text', text: w.noAccounts, tone: 'muted' }
        : { type: 'list', items: accounts.map(account => accountRow(account, w)) });
    // 额度：这一家的所有账号，每个账号一条进度条（有窗口才画）。
    const usage = Array.isArray(snapshot.usage) ? snapshot.usage : [];
    const mine = usage.filter(item => item.provider === provider.id);
    if (mine.length > 0) {
        children.push({ type: 'text', text: `**${w.sectionQuota}**` });
        for (const item of mine) {
            // 不再重复账号名：它已经在上面那行 list 里出现过一次。
            // 一屏内同一个身份出现两次是这张详情页上一版最大的问题。
            const bars = quotaWindowNodes(item);
            if (bars.length === 0)
                children.push({ type: 'text', text: w.noQuotaRows, tone: 'muted' });
            children.push(...bars);
        }
    }
    for (const node of loginNodes(provider, w))
        children.push(node);
    // 刷新这一家的额度（`auth.usage` 是网络请求，用户主动要才发）。
    children.push(solidButton(w.refreshQuota, 'refreshStats'));
    return children;
}
/**
 * 折叠标题上的一句话状态：`已停用 · 2 账号 · 已登录 1/2`，或 `需要登录`。
 *
 * 折叠标题是手机上唯一一眼可见的信息，原先只有「名字 (N 个账号)」，
 * 得点开才知道有没有登录 —— 这是本题最值得改的一处。
 */
function providerBadge(provider, accounts, w) {
    const parts = [];
    if (provider.off === true)
        parts.push(w.providerOff);
    if (accounts.length === 0) {
        parts.push(w.needLogin);
    }
    else {
        parts.push(w.accountsInline(accounts.length));
        const ok = accounts.filter(a => a.signIn === 'kept' || a.signIn === 'renewed').length;
        // 全都没登录态时写「需要登录」比「已登录 0/1」更直白。
        parts.push(ok === 0 ? w.needLogin : w.signedInN(ok, accounts.length));
    }
    return joinDot(parts);
}
/**
 * 一个 provider 的登录入口。
 *
 * 手机端之所以要这段：旧面板只显示「登录态未知」这类文字，**没有任何可点的东西**，
 * 于是手机上根本没法登录（用户原话：「你不登录有什么用」）。
 *
 * 两种方式分开画：
 * - `oauth`：**一列可点的 list 行**，不是一排按钮。App 的 v2 视图里
 *   `DshUiActionButton` 会转成 `DshUiV2ActionButton` 并且**丢掉 `primary`**
 *   （`dsh_ui_blocks.dart:625-627`），三个按钮只能长得一模一样、看不出主次；
 *   而 `DshUiListItem` 自带 `action`，行式入口既省高度也更像「选一种登录方式」。
 * - `api`：表单在 `keyForms()` 里（`form` 不能嵌套进 `collapsible`），这里只提示。
 */
function loginNodes(provider, w) {
    const methods = Array.isArray(provider.methods) ? provider.methods.slice(0, MAX_LOGIN_METHODS) : [];
    if (methods.length === 0)
        return [];
    const nodes = [];
    const oauth = methods.filter(m => m.type !== 'api');
    if (oauth.length > 0) {
        nodes.push({
            type: 'actions',
            items: oauth.map(method => ({
                label: w.loginWith(shortLabel(method.label)),
                icon: 'external',
                action: { id: 'signIn', args: { provider: provider.id, index: method.index } },
            })),
        });
    }
    // 已在等授权的那个方式，给「我已完成」；用 pending.index 精确对应，不猜。
    const pending = provider.pending;
    if (pending !== undefined) {
        nodes.push({ type: 'text', text: w.loginOpened, tone: 'muted' });
        nodes.push({
            type: 'actions',
            items: [{
                    label: w.loginDone,
                    icon: 'success',
                    style: 'primary',
                    action: 'signInFinish',
                    args: { provider: provider.id, index: pending.index },
                }],
        });
    }
    return nodes;
}
/**
 * 登录方式的短文案。
 *
 * 插件给的是完整说明（`浏览器登录（打开 WPS 登录页完成授权）`），手机上
 * list 行只有一行高度，长文案会被省略号截成「浏览器登录（打开 WPS 登录…」。
 * 括号里本来就是补充说明，直接砍掉读起来更完整。
 */
function shortLabel(label) {
    const text = String(label);
    const cut = text.search(/[（(]/);
    const head = cut > 0 ? text.slice(0, cut).trim() : text;
    return head === '' ? text : head;
}
/** `api` 类型（粘贴密钥）：每个 provider 一个表单，提交动作按绑定路径找回 provider。 */
function keyForms(providers, w) {
    const forms = [];
    for (const provider of providers) {
        const methods = Array.isArray(provider.methods) ? provider.methods : [];
        const method = methods.find(m => m.type === 'api');
        if (method === undefined)
            continue;
        forms.push({
            v: VIEW_VERSION,
            type: 'form',
            submit: 'saveKey',
            submitLabel: w.loginSubmit,
            children: [
                { type: 'text', text: `**${provider.name} · ${w.loginKeyLabel}**` },
                {
                    type: 'textField',
                    label: method.label,
                    bind: `data.login.${provider.id}.key`,
                    ...(isFilled(method.placeholder) ? { placeholder: method.placeholder } : {}),
                },
            ],
        });
    }
    return forms;
}
/**
 * 账号显示：**默认原样显示，不打码**。
 *
 * 这里是本机面板，账号只有自己看；打码反而让「哪个账号」认不出来。
 * 保留这个函数而不是删掉，是为了给以后想加开关的地方一个落点。
 */
function maskAccountId(id) {
    return String(id);
}
/**
 * 一个账号一行：标题是账号、副标题是套餐与到期、行尾是登录态。
 *
 * 旧版把「账号 · 套餐 · 余额 · 到期」全拼成一段文字，手机上换行三次且
 * 看不出哪一段是账号；改成 list 行的三段式（title / subtitle / trailing）
 * 是 App 原生的信息密度，同屏能读的账号数翻倍。
 */
function accountRow(account, w) {
    const title = maskAccountId(isFilled(account.accountId) ? account.accountId : account.key);
    const row = {
        title,
        tone: signInTone(account.signIn),
        icon: 'account',
    };
    // 行尾只放状态：套餐与到期属于副标题，行尾再放会让 52dp 的行挤成两行。
    row.trailing = signInText(account.signIn, w);
    // ⚠ 不再拼 `account.key`：它是 **provider 名**，而这行已经在某个 provider
    // 的折叠区里，再写一次就是同一个名字一屏出现三次。
    const subtitle = joinDot([
        account.plan,
        typeof account.until === 'string' ? account.until : undefined,
    ]);
    if (subtitle !== '')
        row.subtitle = subtitle;
    return row;
}
/** 页签二：按 provider 分组；每个账号一行文字 + 最多 3 个环形。 */
function quotaTab(snapshot, w) {
    const usage = Array.isArray(snapshot.usage) ? snapshot.usage : [];
    if (usage.length === 0) {
        return [{ type: 'emptyState', title: w.noQuotaTitle, message: w.noQuotaMessage, icon: 'coin' }];
    }
    const children = [];
    let accounts = 0;
    let providers = 0;
    for (const group of groupUsage(usage)) {
        if (providers >= MAX_QUOTA_PROVIDERS || accounts >= MAX_QUOTA_ACCOUNTS)
            break;
        providers += 1;
        // 小节标题用 Markdown 粗体：`text` 节点只认 Markdown，`style` 字段会被忽略
        // （规范 `native-plugins-views.md` §7「`text` 只认段落、换行、**粗体**、行内代码」）。
        children.push({ type: 'text', text: `**${providerName(snapshot, group.provider)}**` });
        // 账号走 list（和平台页一致的行式密度），额度条跟在 list 后面：
        // list 的行里塞不下 progress，这是 App 的硬限制，所以先「谁」后「多少」。
        const rows = [];
        const quotaBlocks = [];
        for (const item of group.items) {
            if (accounts >= MAX_QUOTA_ACCOUNTS)
                break;
            accounts += 1;
            const quotaError = errorCallout(item.error, w, item.label);
            if (quotaError !== undefined)
                quotaBlocks.push(quotaError);
            rows.push(quotaAccountRow(item, w, providerName(snapshot, group.provider)));
            quotaBlocks.push(...quotaWindowNodes(item));
        }
        if (rows.length > 0)
            children.push({ type: 'list', items: rows });
        children.push(...quotaBlocks);
    }
    const hidden = usage.length - accounts;
    if (hidden > 0)
        children.push({ type: 'text', text: w.moreAccounts(hidden), tone: 'muted' });
    return children;
}
/** provider id -> 显示名；查不到就退回 id（不编造名字）。 */
function providerName(snapshot, id) {
    for (const provider of snapshot.providers) {
        if (provider.id === id)
            return provider.name;
    }
    return id;
}
/** 按 provider 分组但保持首次出现的顺序。 */
function groupUsage(usage) {
    const order = [];
    const buckets = new Map();
    for (const item of usage) {
        let bucket = buckets.get(item.provider);
        if (bucket === undefined) {
            bucket = [];
            buckets.set(item.provider, bucket);
            order.push(item.provider);
        }
        bucket.push(item);
    }
    return order.map(provider => ({ provider, items: buckets.get(provider) ?? [] }));
}
/**
 * 到期时间的人话：ISO 串 `2026-12-07T15:49:04+08:00` 不能直接吐给用户。
 *
 * 规则（实测最常看的是「还剩多久」）：
 * - ≤ 0 天：`已到期`
 * - ≤ 60 天：`还有 N 天` —— 手机上要的是紧迫感，不是日历
 * - 更远：`M月D日到期` —— 超过两个月再报天数没有意义
 * 解析失败就返回原串，绝不编造日期。
 */
function untilText(until, now) {
    if (!isFilled(until))
        return undefined;
    const at = Date.parse(until);
    if (!Number.isFinite(at))
        return until;
    const days = Math.ceil((at - (isFiniteNumber(now) ? now : Date.now())) / 86_400_000);
    if (days <= 0)
        return '已到期';
    if (days <= 60)
        return `还有 ${days} 天`;
    const d = new Date(at);
    return `${d.getMonth() + 1}月${d.getDate()}日到期`;
}
/**
 * 额度页的一个账号：一行身份文字 + 若干条额度。
 *
 * ⚠ 身份优先取 `item.user`（真实账号，如 `WPS_1000000001`）。`accountKey`
 * 在 magpie 里常常就等于 provider id，拿它当账号会让「wps-lingxi」在同一
 * 屏出现两次（小节标题一次、这里一次），这也是旧版最刺眼的一处重复。
 */
function quotaAccountRow(item, w, providerLabel) {
    const head = maskAccountId(isFilled(item.user) ? item.user : item.accountKey);
    const row = { title: head, icon: 'account' };
    // 套餐名常常就是平台名（`plan: 'WPS 灵犀'`），而平台名已经是这节的标题；
    // 再写一次就是同一个名字一屏出现两次。
    const plan = isFilled(item.plan) && item.plan !== head && !providerLabel.includes(item.plan)
        ? item.plan
        : undefined;
    // 有 `limit`/`amount` 的窗口时，余额与条尾的「剩 N / 总量」是同一件事，只留一处。
    const hasWindowAmounts = (item.windows ?? []).some(win => isFiniteNumber(win.limit) && isFiniteNumber(win.amount));
    const subtitle = joinDot([
        plan,
        !hasWindowAmounts && isFilled(item.balance) ? w.balance(item.balance) : undefined,
        untilText(item.until, Date.now()),
    ]);
    if (subtitle !== '')
        row.subtitle = subtitle;
    return row;
}
/**
 * 额度窗口 -> 节点。
 * - 全部 `aside`（不参与路由）：一行文字，不画条；
 * - 有有限数 `used`：进度条（最多 3 个）；
 * - `used` 缺失：一行文字，**不传 0**（0 会被读成「满额」，是谎报）。
 *
 * 条尾（`caption`）优先给「剩多少」而不是百分比：百分比在接近满额时
 * 反而比「剩 1 智点」抽象。
 */
function quotaWindowNodes(item) {
    const windows = Array.isArray(item.windows) ? item.windows : [];
    const routable = windows.filter(win => win.aside !== true);
    if (windows.length > 0 && routable.length === 0) {
        return [{ type: 'text', text: joinDot(windows.map(windowText)), tone: 'muted' }];
    }
    const bars = [];
    const texts = [];
    for (const win of routable) {
        if (bars.length >= MAX_QUOTA_RINGS)
            break;
        const percent = remainingPercent(win);
        if (percent !== undefined) {
            bars.push(bar(win.name, percent, windowCaption(win), remainingTone(percent)));
        }
        else {
            texts.push({ type: 'text', text: windowText(win), tone: 'muted' });
        }
    }
    // 一个账号常有两道窗口（日额度 + 月额度之类）。`progress` 的最小宽度是
    // 140dp，面板内容约 300dp 能排两列，所以并排放；竖排时第二条会被推到
    // 屏外，看着像「只报了一个额度」。
    const nodes = bars.length >= 2 ? [{ type: 'row', children: bars }] : bars;
    return [...nodes, ...texts];
}
/** 条尾文字：优先「剩 N」，其次原始 display，最后才回落百分比。 */
/**
 * 条尾文字：`剩 2,299 / 2,300`。
 *
 * 不重复单位 —— 左侧 `label` 已经写了「智点」，条尾再写一次就是同屏重复。
 * 把总量也带上，是因为只给「剩 2,299」看不出这是「快满了」还是「几乎用光」。
 */
function windowCaption(win) {
    if (isFiniteNumber(win.limit) && isFiniteNumber(win.amount)) {
        const left = win.limit - win.amount;
        return `剩 ${groupDigits(Math.max(0, left))} / ${groupDigits(win.limit)}`;
    }
    if (isFilled(win.display))
        return win.display;
    return undefined;
}
/**
 * 进度条画**剩余**比例（`(limit - amount) / limit`）。
 *
 * 旧版把 `used` 当百分比、`max` 固定 100 画：`used = 1` 时条几乎是空的，
 * 而同一行右侧写着「剩 2,299 智点」—— 一眼看去像「额度没了」。
 * 额度页的主角是「还剩多少」，所以条的满格 = 全额度，越短越危险。
 */
function remainingPercent(win) {
    if (!isFiniteNumber(win.limit) || !isFiniteNumber(win.amount))
        return undefined;
    if (win.limit <= 0)
        return 0;
    const left = win.limit - win.amount;
    return Math.max(0, Math.min(100, Math.round((left / win.limit) * 100)));
}
/** 剩余越少越危险：<10% 红、<30% 黄，其余绿。 */
function remainingTone(percent) {
    if (!isFiniteNumber(percent))
        return undefined;
    if (percent < 10)
        return 'bad';
    if (percent < 30)
        return 'warn';
    return 'good';
}
/**
 * 页签三：4 个 metric + 明细 + 柱状图 + 排行表 + 周期 + 刷新。
 *
 * **周期选择放在最下面**：App 的插件视图里 `options` 只能竖排（`_RowView`
 * 给每个子项 `_minWidth` 220，横排塞不下四个），四个单选若放顶部会吃掉
 * 约 350 px，把真正要看的数字推到第二屏。放到底部后首屏直接是数字。
 */
function usageTab(snapshot, w) {
    const stats = snapshot.stats;
    const series = Array.isArray(stats.series) ? stats.series.slice(-MAX_CHART_CATEGORIES) : [];
    const ranked = Array.isArray(stats.byProvider)
        ? stats.byProvider.slice().sort((a, b) => b.tokens - a.tokens).slice(0, MAX_USAGE_ROWS)
        : [];
    const cacheText = cacheHitText(stats);
    return [
        // 四个指标分两行两列。`row` 按「最宽子组件」算一行放几个，四个 metric
        // 挤一行时每个只剩约 60dp，数字会被截断成 `12.3…`。
        {
            type: 'row',
            children: [
                metric(w.metricTokens, groupDigits(stats.tokens)),
                metric(w.metricCalls, groupDigits(stats.calls), stats.errors > 0 ? 'warn' : undefined, stats.errors > 0 ? w.metricFailed(stats.errors) : undefined),
            ],
        },
        {
            // 费用与命中率不占大卡片：大卡片每张 100dp，四个就把首屏吃光
            // （用户「很多组件太大要缩小」）。小数字放进下面的明细行，
            // 数值本身才是要看的，卡片只是为了突出 Token 与请求量。
            type: 'keyValue',
            items: [
                [w.kvInput, groupDigits(stats.inputTokens)],
                [w.kvOutput, groupDigits(stats.outputTokens)],
                [w.kvCacheRead, groupDigits(stats.cacheReadTokens)],
                [w.kvCacheWrite, groupDigits(stats.cacheWriteTokens)],
                [w.metricCost, isFiniteNumber(stats.cost) && stats.cost > 0 ? formatCost(stats.cost) : w.metricNone],
                [w.metricCache, cacheText === '—' ? w.metricNone : cacheText],
            ],
        },
        // 没有数据就不画空图：App 的空图表会占掉半屏并写「暂无数据」，
        // 那是把「没数据」画成了「有一大块东西」。
        ...(series.length === 0
            ? []
            : [{
                    type: 'chart',
                    kind: 'bar',
                    categories: series.map(point => point.label),
                    series: [{ name: w.metricTokens, values: series.map(point => point.tokens) }],
                    unit: 'token',
                }]),
        // 按平台排行同理：空表不画，只留一行说明。
        ...(ranked.length === 0
            ? [{ type: 'text', text: w.noUsageRows, tone: 'muted' }]
            : [{
                    type: 'table',
                    columns: [w.colProvider, w.colTokens, w.colCalls, w.colTtft],
                    rows: ranked.map(row => [
                        row.name,
                        groupDigits(row.tokens),
                        groupDigits(row.calls),
                        isFiniteNumber(row.avgTtftMs) ? `${Math.round(row.avgTtftMs)} ms` : w.metricNone,
                    ]),
                }]),
        {
            type: 'options',
            id: 'statsPeriod',
            selected: stats.period,
            options: [
                { label: w.periodToday, value: PERIOD_TODAY },
                { label: w.period7d, value: PERIOD_7D },
                { label: w.period30d, value: PERIOD_30D },
                { label: w.periodAll, value: PERIOD_ALL },
            ],
        },
        solidButton(w.refresh, 'refreshStats'),
        // 请求记录属于「观测」，跟用量放一处；它是空表时只占一行标题。
        { type: 'text', text: `**${w.sectionRouting}**` },
        ...routingTab(snapshot, w),
    ];
}
/** 页签四：路由表（行由 panelData 按 now 格式化）+ 刷新。 */
function routingTab(snapshot, w) {
    const routing = Array.isArray(snapshot.routing) ? snapshot.routing : [];
    const children = [];
    if (routing.length === 0) {
        children.push({ type: 'emptyState', title: w.noRoutingTitle, message: w.noRoutingMessage, icon: 'trajectory' });
    }
    else {
        children.push({
            type: 'table',
            columns: [w.colTime, w.colProvider, w.colModel, w.colStatus, w.colLatency],
            rows: { $: 'data.routing.rows' },
        });
        children.push({ type: 'text', text: { $: 'data.updatedAt' }, tone: 'muted' });
    }
    children.push({ type: 'actions', items: [{ label: w.refresh, icon: 'retry', style: 'plain', action: 'refreshRouting' }] });
    return children;
}
// ── 数据（纯函数） ────────────────────────────────────────────────────────
/**
 * 面板数据：解析视图里的 `{$:...}` 绑定。
 *
 * 只负责「视图自己算不了」的部分 —— 也就是依赖时钟的时间文案：
 * `routing.rows`（表格行）与 `updatedAt`（刷新时间）。
 * `now` 省略时取 `Date.now()`；测试里传固定值即可复现。
 */
export function panelData(snapshot, locale, now, ui) {
    const w = words(locale);
    const stamp = isFiniteNumber(now) ? now : Date.now();
    const routing = Array.isArray(snapshot.routing) ? snapshot.routing : [];
    const rows = routing.slice(0, MAX_ROUTING_ROWS).map((entry) => {
        const status = entry.status === 'ok'
            ? w.statusOk
            : joinDot([w.statusError, isFilled(entry.error) ? entry.error : undefined]);
        return [
            formatWhen(entry.at, stamp, w),
            entry.provider,
            entry.model,
            status,
            isFiniteNumber(entry.ms) ? `${Math.round(entry.ms)} ms` : '—',
        ];
    });
    return {
        routing: {
            rows,
            total: routing.length,
        },
        // `api` 型密钥表单的绑定根：`data.login.<provider>.key`。
        // 必须给出空对象，否则 `bind` 的路径不存在、输入框拿不到本地草稿。
        login: {},
        // 控件绑定根：`data.ui.page`（chips 导航）、`data.search.query`（搜索框）、
        // `data.install.spec`（手输安装）。缺一个那段 `bind` 就解析不到，
        // 控件会失去初值（chips 高亮丢失、输入框空白）。
        ui: {
            page: PAGES.includes(ui?.page) ? ui.page : PAGE_AGENTS,
        },
        search: {
            query: typeof ui?.query === 'string' ? ui.query : '',
        },
        install: {
            spec: typeof ui?.spec === 'string' ? ui.spec : '',
        },
        // 后台安装的进度/结果（安装不在 action 里跑，见 index.js 的 startInstall）
        installStatus: normalizeInstallStatus(ui?.install, w),
        // 同一份结果的**展示文本**：视图用 `{$:'data.installStatusLine'}` 绑它
        installStatusLine: normalizeInstallStatus(ui?.install, w)?.text ?? '',
        // 检查更新/批量更新的状态行（同样是后台任务，只能靠数据回推）
        updateStatusLine: normalizeUpdateStatus(ui?.update, w)?.text ?? '',
        // 设置页的仓库密钥：控件靠这几段 `bind` 才能写入与回显
        tokens: {
            github: typeof ui?.tokens?.github === 'string' ? ui.tokens.github : '',
            npm: typeof ui?.tokens?.npm === 'string' ? ui.tokens.npm : '',
        },
        // 插件配置页的「运行选项」输入框。初值来自已保存的 options，
        // 没有就用包里的示例 —— 与桌面端 `e.options || e.optionsExample` 一致。
        plugin: {
            options: pluginOptionsText(snapshot, ui),
        },
        // 配置页的状态行（版本 · 已启用/已停用 · 可更新到）
        pluginStateLine: pluginStateText(pluginOf(snapshot, ui), w),
        // 设置页「显示」那几个 `chips` 的绑定根。有 `bind` 的控件 `value` 会被
        // App 改写成 `{$: bind}`（`dshUiInputBindings`），选中态完全靠这里下发，
        // 缺了它们点一下会「跳回原样」。
        display: {
            strip: ui?.display?.strip === false ? 'off' : 'on',
            note: ui?.display?.note === false ? 'off' : 'on',
            noteKind: ui?.display?.noteKind === 'quota' ? 'quota' : 'tokens',
            models: ui?.display?.models === 'flat' ? 'flat' : 'group',
        },
        updatedAt: w.updatedAt(formatDateTime(stamp)),
    };
}
/*
 * 节点估算（最坏情况，实测见 tests/panel.spec.ts 的 ≤100 断言）：
 *   根 stack + tabs                                       2
 *   Agent   5×(collapsible+list) + 5 callout + 1 提示 + 1  17
 *   额度    5 组标题 + 6 账号×(1 文字 + 3 窗口) + 6 + 1    36
 *   用量    options + row + 4 metric + keyValue + chart
 *           + table + actions                              10
 *   路由    table + 时间文字 + actions                      3
 *   合计                                                   68
 */
//# sourceMappingURL=panel.js.map