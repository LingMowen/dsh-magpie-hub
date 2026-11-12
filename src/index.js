/**
 * dsh-magpie-hub —— 把 magpie（opencode 形态）的供应商插件装进 DSH。
 *
 * ## 它做什么
 *
 * magpie 的插件是「一个 async 函数 → 一组钩子」：`config` / `auth`（methods、
 * refresh、loader、usage、checkin）/ `provider.models` / `chat.headers`。本插件
 * 在 DSH 侧实现这些钩子的**宿主**，于是**为 magpie 写的插件不用改就能在 DSH 里
 * 登录、列模型、发请求**（codearts / workbuddy / loomy 等社区包直接可用）。
 *
 * 数据流：
 * ```
 * DSH 请求 → MagpieAdapter.stream()
 *   → host.ensureFresh()      auth.refresh（临期先续，同账号串行）
 *   → host.loaderOf()         auth.loader（baseURL / apiKey / headers / fetch）
 *   → host.chatHeaders()      chat.headers（链式，后者覆盖）
 *   → protocols.buildRequest / parseResponse（四种 AI SDK 协议）
 * → 上游厂商
 * ```
 *
 * 宿主自身的状态（装了哪些插件、每个 provider 登录了什么）落在
 * `<DSH 配置目录>/magpie/`：`plugins.json`、`plugin-auth.json`、
 * `plugin-providers.json` —— 与 magpie 自己的**同名同形状**，两边的登录态可以
 * 直接对拷。
 *
 * ## 为什么面板用 `ctx.inject`
 *
 * `dshGo` 服务只在装了 dsh-go-bridge 的 profile 里存在。写进顶层静态 `inject`
 * 会让缺桥的 profile 整个插件不加载；用 `ctx.inject(['dshGo'], …)` 则只跳过
 * 面板那一段，聊天链路照常工作。
 */
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MagpieAdapter } from './adapter.js';
import { MagpieHost } from './host.js';
import { panelData, panelView } from './panel.js';
import { registerMagpieHubApi } from './rpc.js';
import { installHotReload } from './hotreload.js';
import { Market } from './market.js';
import { compactAmount, currentProviderId, noteLine, noteQuota, shortProviderName, stripLine } from './surfaces.js';
import { loadAll, moduleNameOf } from './runtime.js';
import { currentScope } from './scope.js';
import { AuthStore, PluginStore, SettingsStore, hostPaths } from './store.js';
import { PolicyStore } from './state.js';
import { registerUi } from './ui.js';
import { makeUiHandlers } from './ui-api.js';
import { whoOf } from './types.js';
export const name = 'magpie-hub';
/**
 * ⚠️ 只声明 `llm`：`dshGo` 与 `credentials` 都用 `ctx.inject` 局部拉取
 *（理由见模块头：缺桥的 profile 不能因此整个不加载）。
 */
export const inject = ['llm'];
/** 面板 id（dshGo manifest 里同名）。 */
const PANEL_ID = 'magpie';
/** 输入框上方的额度状态条（`composer.strip`），id 与 `package.json` 的清单一致。 */
const STRIP_ID = 'magpie-strip';
/** 每回合脚下的消耗脚注（`turn.note`），同样要与清单一致。 */
const NOTE_ID = 'magpie-note';
/** 面板当前的「平台详情」焦点（`null` = 列表页）。 */
let focusedProvider = null;
/**
 * 手机面板当前页（`agents` / `quotas` / `usage` / `store` / `settings`）。
 *
 * 存在插件侧而不是 App 侧：App 只保存控件的本地草稿，`refresh` 后要重新
 * 从插件拿视图，所以「我在看哪一页」必须由插件记着（与 `focusedProvider` 同理）。
 */
let currentPage = 'agents';
/** 商店「可安装」一次列多少条：市场里上百个包，一次全铺要滑十几次。 */
let storeLimit = 8;
/**
 * 当前打开的插件（插件页的配置视图）。存 spec，`null` = 停在列表。
 *
 * 与 `focusedProvider` 同一套「App 没有弹窗，refresh 就是弹/收」的做法。
 */
let focusedPlugin = null;

/** 平台页的搜索关键词（空串 = 不过滤）。 */
let searchQuery = '';
// 搜索框默认收起（用户：「太大了，挡住了很多东西。默认是隐藏的，点击后才显示」）。
// 展开状态放插件侧：App 的视图没有「就地展开」的节点，只能 refresh 换一版。
let searchOpen = false;
/**
 * 设置页当前显示的仓库凭据（**只用于给输入框初值**）。
 *
 * App 的输入控件要 `bind` 解析到 `panelData` 里真实存在的路径才可写，
 * 所以这里必须留一份镜像；真源仍是 `hub-settings.json` 的 `tokens`。
 */
let tokenDraft = { github: '', npm: '' };
/**
 * 「显示」偏好：状态条与回合脚注要不要出现、脚注写 token 还是额度、模型列表怎么排。
 *
 * 真源是 `hub-settings.json` 的 `display` 键（见 `SettingsStore`），这里是内存镜像：
 * 视图渲染与 surface 推送都读它，少了就会每次渲染都去等一次磁盘。
 */
const DISPLAY_DEFAULTS = { strip: true, note: true, noteKind: 'tokens', models: 'group' };
let display = { ...DISPLAY_DEFAULTS };
/** 模型页是否打开（从设置页「浏览模型」进来，不占页签）。 */
let modelsOpen = false;
/** 把 `hub-settings.json` 里可能残缺/非法的 `display` 收成一份能用的。 */
function readDisplay(raw) {
    const out = { ...DISPLAY_DEFAULTS };
    if (raw === null || typeof raw !== 'object')
        return out;
    if (typeof raw.strip === 'boolean')
        out.strip = raw.strip;
    if (typeof raw.note === 'boolean')
        out.note = raw.note;
    if (raw.noteKind === 'tokens' || raw.noteKind === 'quota')
        out.noteKind = raw.noteKind;
    if (raw.models === 'group' || raw.models === 'flat')
        out.models = raw.models;
    return out;
}
/**
 * 最近一次安装的结果，回推给商店页显示。
 *
 * 安装是后台跑的（App 的点击窗口只有 3 秒，见 `startInstall`），所以「装上了」
 * 这件事不能靠 action 的返回值告诉用户——只能落到这里，随下一次数据推送出现。
 *
 * `{ state: 'running' | 'ok' | 'failed', spec, name?, error?, at }`
 */
/**
 * `latest` 是否比 `current` 新（容错的 semver 比较）。
 *
 * 只比 `x.y.z` 的数字部分：`1.2.0-beta.1` 与 `1.2.0` 视为同级（beta 不该触发
 * 一次覆盖安装）。解析不出来时保守返回 false —— 宁可不更新，也不要用一个
 * 乱七八糟的版本号去覆盖一个能用的包。
 */
function isNewer(latest, current) {
    const parse = (v) => String(v).split('-')[0].split('.').map(n => Number.parseInt(n, 10));
    const a = parse(latest);
    const b = parse(current);
    if (a.length === 0 || b.length === 0 || a.some(Number.isNaN) || b.some(Number.isNaN))
        return false;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y)
            return x > y;
    }
    return false;
}
let installStatus = null;
/**
 * 最近一次「检查更新 / 批量更新」的结果，回推给插件页。
 *
 * 与安装同因：问 npm registry 要十几秒，超了 App 的 3 秒点击窗口，结果只能
 * 落到快照里随数据推送出现。`{ state:'running'|'ok'|'failed', updatable?, error?, at }`
 */
let updateStatus = null;
/**
 * 最近一次「检查更新 / 批量更新」的结果，回推给插件页。
 *
 * 同样不能在 action 里等：查 11 个包的 npm 版本 + 下载安装远超 App 的 3 秒
 * 点击窗口。`{ state: 'running' | 'ok' | 'failed', updatable?: [{package,from,to}], error?, at }`
 */

/** 用量流水窗口：面板的「用量」页只保留最近这么多条。 */
const LEDGER_LIMIT = 500;
/** 签到是慢操作（十几个账号逐个领），给足 60 秒。 */
const CHECKIN_TIMEOUT_MS = 60_000;
/**
 * 查额度时的并发上限。
 *
 * 48 个供应商、每个账号一次 `auth.usage`（网络）。串行要几十秒，首屏等于白屏；
 * 全并发又会把上游打成一串 429。6 路是实测下来的折中（本地跑通、不冒烟）。
 */
const USAGE_CONCURRENCY = 6;
/**
 * 限并发 map（保持顺序无所谓，这里只用在「收集结果」上）。
 *
 * 为什么不用 `Promise.all` 直接铺开：额度查询是网络请求，几百个并发会被上游限流。
 */
async function mapLimit(items, limit, fn) {
    const width = Math.max(1, Math.min(limit, items.length));
    let cursor = 0;
    const workers = Array.from({ length: width }, async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length)
                return;
            await fn(items[index], index);
        }
    });
    await Promise.all(workers);
}
export function apply(ctx) {
    // ── 宿主 ────────────────────────────────────────────────────────────────
    const paths = hostPaths(configRoot());
    const plugins = new PluginStore(paths);
    const auth = new AuthStore(paths);
    const settings = new SettingsStore(paths);
    // 用户策略（模型开关、供应商启停、隐藏账号、路由）——本插件自己的状态，
    // 与 magpie 的 settings.json 分开存，互不干扰。
    const policy = new PolicyStore(paths);
    const host = new MagpieHost(paths, auth);
    const records = [];
    const stats = { calls: 0, errors: 0, byProvider: new Map() };
    // ⚠️ 两个函数互相引用（record 要 notify、notify 用 feeds），故先声明再赋值：
    // 直接写 `const record = …；const notify = …` 会让 record 的闭包里拿到
    // notify 的 TDZ 绑定（运行时首次调用就炸）。feeds 集合先建，闭包只捕获它。
    const feeds = new Set();
    /**
     * 状态条与回合脚注的推送器。
     *
     * 面板的 `data` 由 `feeds` 推，这两处各有自己的订阅（App 只在用到时才订阅），
     * 所以另开一组。**每次调用记录后都要推一遍**：额度是跟着调用变的。
     */
    const surfaceFeeds = new Set();
    function notifySurfaces() {
        for (const fn of surfaceFeeds) {
            try {
                fn();
            }
            catch {
                // 一个订阅者出错不影响其它
            }
        }
    }
    function notify() {
        for (const fn of feeds) {
            try {
                fn();
            }
            catch {
                // 一个订阅者出错不影响其它
            }
        }
    }
    /**
     * 回合脚注的数据：`{ <回合号>: { text, tone? } }`。
     *
     * App 是拿**回合序号**来取的（`chat_list.dart:963`
     * `nativeTurnNoteProvider((sessionId, trace.turn))`，取 `data[turn]`），而插件
     * 拿不到 DSH 的 turnId（`adapter.stream(options)` 只有 `sessionID`）。
     * 所以这里按「这个会话里第几次调用」近似回合号 —— 一问一答时正好对齐，
     * 一轮里多次工具调用时会偏（偏了只影响脚注显示，不影响任何请求）。
     */
    // ⚠ 回合计数必须**跨引擎重启**保持连续，否则对不上：App 取脚注用的是
    // 「这个会话里的第几轮」（`chat_list.dart` 的 `trace.turn`），而它记的是
    // 会话自己的流水；插件这边如果每次重启都从 1 开始，历史会话就永远取不到
    // 当前这轮的键。存成 `turns.json`：`{ <sessionId>: <已用到的回合号> }`。
    const TURNS_FILE = join(paths.root, 'turns.json');
    const sessionTurns = new Map();
    const turnsReady = readFile(TURNS_FILE, 'utf8')
        .then((raw) => {
            const parsed = JSON.parse(raw);
            if (parsed === null || typeof parsed !== 'object')
                return;
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === 'number' && Number.isFinite(value) && value > 0)
                    sessionTurns.set(key, Math.floor(value));
            }
        })
        .catch(() => { });
    let turnsSaving = false;
    /** 把回合计数写回磁盘（合并写：同一时刻只排一次）。 */
    function saveTurns() {
        if (turnsSaving)
            return;
        turnsSaving = true;
        void turnsReady.then(() => {
            turnsSaving = false;
            const out = {};
            for (const [key, value] of sessionTurns)
                out[key] = value;
            return writeFile(TURNS_FILE, JSON.stringify(out), 'utf8');
        }).catch(() => { turnsSaving = false; });
    }
    /** 每个会话已写过的脚注（key 是近似回合号）。 */
    const sessionNotes = new Map();
    const NOTE_KEEP = 64;
    /** 回合号对不准时往后铺几格（见 `noteRecord`）。 */
    const NOTE_SPREAD = 7;
    function noteRecord(row) {
        // ⚠ DSH **不向 `adapter.stream(options)` 传 sessionID**（真机实测
        // `row.sessionID` 恒为 undefined），所以按会话分桶做不到。退成单桶 `''`：
        // 手机上只有一个对话时回合序号正好对齐；多对话并行时脚注会串。
        const bucket = typeof row.sessionID === 'string' && row.sessionID !== '' ? row.sessionID : '';
        const turn = (sessionTurns.get(bucket) ?? 0) + 1;
        sessionTurns.set(bucket, turn);
        saveTurns();
        let notes = sessionNotes.get(bucket);
        if (notes === undefined) {
            notes = {};
            sessionNotes.set(bucket, notes);
        }
        // App 取脚注用的是「这个会话里的第几轮」（`data[trace.turn]`），而桥接
        // 给插件的 `scope` 只有 `sessionId`，没有回合号（真机实测
        // `{"sessionId":"session-…"}`）。插件自己的计数从引擎启动开始算，
        // 通常**小于** App 的轮次（会话可能早于引擎就存在）。所以同一个消耗
        // 往后多铺几格：App 无论偏几轮都能取到。代价是未来几轮在还没轮到它们
        // 时先显示本次消耗，下一次调用会覆盖 —— 只影响脚注文字，不碰请求。
        const note = {
            text: display.noteKind === 'quota' ? noteQuota(row, latest) : noteLine(row, latest),
            ...(row.status === 'error' ? { tone: 'warn' } : {}),
        };
        for (let ahead = 0; ahead <= NOTE_SPREAD; ahead += 1)
            notes[String(turn + ahead)] = note;
        const keys = Object.keys(notes);
        if (keys.length > NOTE_KEEP) {
            for (const key of keys.slice(0, keys.length - NOTE_KEEP))
                delete notes[key];
        }
    }
    const record = (entry) => {
        const row = { ...entry, at: Date.now() };
        records.push(row);
        if (records.length > LEDGER_LIMIT)
            records.splice(0, records.length - LEDGER_LIMIT);
        stats.calls += 1;
        if (row.status === 'error')
            stats.errors += 1;
        const tally = stats.byProvider.get(row.provider)
            ?? { provider: row.provider, calls: 0, errors: 0, tokens: 0 };
        tally.calls += 1;
        if (row.status === 'error')
            tally.errors += 1;
        tally.tokens += row.tokens ?? 0;
        stats.byProvider.set(row.provider, tally);
        noteRecord(row);
        notify();
        notifySurfaces();
    };
    /**
     * 每个账号的「已用百分比」缓存（`<provider>#<key>` → 0..100）。
     *
     * 只由 `buildSnapshot` 填（那里本来就会问每个账号的 `auth.usage`），
     * 供路由策略 `fastest` 排序用。**没有数据就不写**——让策略层把「不知道」
     * 和「用了 0%」区分开，否则一个没查过额度的账号会被当成满额顶到队首。
     */
    const quotaUsed = new Map();
    /**
     * 适配器的依赖对象。**`providers` 必须在每次 `reload()` 后更新**：DSH 传来的
     * 模型 id 可能是裸模型名（不带 `<provider>/` 前缀），这时适配器要靠这份列表
     * 反查平台。以前它一直是构造时的空数组，于是裸名一律落到 `providers[0]`
     * （或空串），取不到 loader、请求直连上游、全部 401。
     */
    const adapterDeps = {
        host,
        providers: [],
        record,
        policy,
        quotaOf: (provider, key) => quotaUsed.get(`${provider}#${key}`),
    };
    const adapter = new MagpieAdapter(adapterDeps);
    /**
     * 「用量」页当前的时间窗（由 `statsPeriod` 动作改）。
     *
     * 面板的 `stats.period` 是**读侧**的值：`buildSnapshot()` 按它过滤记录并回填，
     * 所以切窗不需要重新采集，只是重算一次。
     */
    let period = 'today';
    /**
     * 正在等授权的登录：`provider -> { index, label }`。
     *
     * 为什么要在插件侧记：手机端拿到 `{link}` 后由 App 打开浏览器，回调**不会**
     * 自动回来（Android PRoot 里的本机监听端口，App 浏览器连不上），所以必须由
     * 用户回来点「我已完成」，插件得知道「刚才在等哪个 provider、第几个方式」。
     */
    const pendingSignIn = new Map();
    // ── 装载 magpie 插件 ────────────────────────────────────────────────────
    let registration;
    /**
     * 给插件用的 OpenCode 形态上下文。
     *
     * 契约：插件拿到的是 `{ client, directory, worktree, project, $, magpie }`。
     * 其中只有 `client.auth.set` 是**必需**的（插件用它保存续期后的凭据），
     * 其余按能力给：拿不到就给一个不改变语义的退化实现（日志进 DSH logger、
     * toast 也进日志——契约说 magpie 里 toast 本身就是写日志）。
     */
    const pluginContext = {
        client: {
            auth: {
                async set(input) {
                    // 契约：`client.auth.set` 是**整体替换**当前作用域账号（不是合并）。
                    const key = currentScope()?.key;
                    if (key === undefined)
                        return undefined;
                    await auth.set(key, input.body);
                    notify();
                    return undefined;
                },
                async remove(input) {
                    const key = currentScope()?.key ?? input.path.id;
                    await auth.remove(key);
                    notify();
                    return undefined;
                },
            },
            app: {
                log(input) {
                    const line = `plugin [${input.level ?? 'info'}]: ${input.service === undefined ? '' : `${input.service} `}${input.message}`;
                    ctx.logger?.info?.(`[magpie-hub] ${line}`);
                },
            },
            tui: {
                showToast(input) {
                    ctx.logger?.info?.(`[magpie-hub] toast: ${input.message}`);
                },
            },
            config: {
                async get() {
                    return host.currentConfig();
                },
            },
        },
        directory: paths.root,
        worktree: paths.root,
        project: { id: 'dsh-magpie-hub', worktree: paths.root },
        magpie: {
            // 插件选项由 plugins.json 的 options 给（magpie 的 `input.magpie.option`）
            option: (key) => undefined,
        },
    };
    /** 重新扫描插件目录，并把当时的 provider 集合注册/更新到 `ctx.llm`。 */
    const reload = async () => {
        const installedList = await plugins.list();
        const result = await loadAll(installedList, paths, pluginContext);
        // ⚠️ `assemble` 是 async（内部 await 每个插件的 `config` 钩子）——漏掉
        // await 的话 owners 映射还没建，providerIds() 返回空、面板拿不到登录方式，
        // 而且不会报错（未处理的 Promise 只在有人 catch 时才可见）。
        await host.assemble(result.loaded, result.failed);
        // 被用户「停用」的供应商不注册：它连模型选择器都不该出现。
        // ⚠ 这里必须过滤后再注册，而不是在 adapter 里过滤——DSH 的 provider 列表
        // 是注册时给的，注册完再想「隐藏」只能靠空模型列表，那会让选择器里
        // 留一个点进去什么都没有的空供应商。
        const off = (await policy.get()).offProviders;
        const providers = host.providerIds().filter((id) => !off.has(id));
        // ⚠ 每次扫完都要回写适配器的 provider 列表：`stream()` 靠它把裸模型名
        // 反查回平台，空列表会导致 loader 取不到、请求直连、一律 401。
        // ⚠ 先更新适配器依赖里的 provider 列表：DSH 传来的模型名经常是裸模型名，
        // 适配器要凭这份列表反查它属于哪个平台（见 `stream()`）。
        adapterDeps.providers = providers;
        // 注册方式与 jet Hub 一致：**一次把全部 provider 交给一个适配器实例**
        // （`ctx.llm.registerAdapter(providers, adapter)`），每个 provider 各自成为
        // 模型选择器里的一条路由，名字来自插件的 `config().name`。
        //
        // ⚠ 重复注册是**正常竞态**（插件 fiber 重启时上一次注册还在），jet-hub 的
        // `registerAdapterIdempotent` 正是为此：**只吞「已注册」这一种错误**，其余
        // 照常抛。以前笼统 catch `LlmError` 会把真正的注册失败（provider 名非法之类）
        // 也咽掉，表现成「一个 provider 都没有」而且日志里什么也看不到。
        try {
            if (registration === undefined) {
                // ⚠ `registerAdapter` 是**整批**语义：列表里只要有一个 provider 已被
                // 别的插件（例如 dsh-providers-hub 的 raccoon）注册，整批都会抛
                // 「an adapter for provider "x" is already registered」，结果我们
                // 一个 provider 都注册不上——模型选择器里只剩别家的。
                // 所以先整批试，失败就逐个注册、跳过被占用的，其余照常接上。
                try {
                    registration = ctx.llm.registerAdapter(providers, adapter);
                }
                catch (batchError) {
                    if (!isDuplicateRegistration(batchError))
                        throw batchError;
                    const accepted = [];
                    const skipped = [];
                    for (const id of providers) {
                        try {
                            const single = ctx.llm.registerAdapter([id], adapter);
                            if (registration === undefined)
                                registration = single;
                            accepted.push(id);
                        }
                        catch (oneError) {
                            if (!isDuplicateRegistration(oneError))
                                throw oneError;
                            skipped.push(id);
                        }
                    }
                    ctx.logger?.warn?.(`[magpie-hub] 逐个注册：接上 ${accepted.length} 个，跳过已被其它插件占用的 ${skipped.length} 个（${skipped.join(', ')}）`);
                }
            }
            else {
                registration.replace?.(providers);
            }
        }
        catch (e) {
            if (!isDuplicateRegistration(e))
                throw e;
            ctx.logger?.warn?.(`[magpie-hub] adapter 已注册（fiber 重启竞态），保留现有路由：${e instanceof Error ? e.message : String(e)}`);
        }
        adapter.invalidateCatalog();
        notify();
        // 一行说清这次扫到了什么：数据根、插件数、失败数、provider 数。
        // 面板显示「还没有安装 magpie 插件」时，用户和我们都能立刻分辨是
        // 「数据根找错了」还是「插件装失败了」，不必再去猜。
        const scanLine = `[magpie-hub] 数据根 ${paths.root}：插件 ${host.loaded.length} 个、失败 ${host.loadFailures.length} 个、provider ${providers.length} 个${host.loadFailures.length === 0 ? '' : `（首个失败：${host.loadFailures[0]?.error ?? ''}）`}`;
        ctx.logger?.info?.(scanLine);
        // `logger.info` 在手机上不会出现在 dsh.log 里（只有 console.error 会），
        // 而「面板说没装插件」正是医生要看的第一行——所以两条通道都发。
        console.error(scanLine);
    };
    // ⚠ 装载完**必须再刷一次快照**：`reload()` 只负责注册路由，
    // 而面板读的是 `latest`——它由 `refresh()` 生成。早先这里只 `reload()`，
    // 结果「首次打开面板 provider 数一直是 0，手动点一次刷新才出来 48 个」
    // （因为那一刻 warm-up 的 refresh 早已跑过，读的是空宿主）。
    // ⚠ 预热**延后 5 秒**：`refresh()` 会逐账号问 `auth.usage`（网络）。
    // 48 个供应商时它在启动瞬间发起一大片请求，把实例拖到连静态页面都超时
    // （实测 `/magpie-hub/` 直接 404）。先让页面加载，再慢慢补数据。
    // ⚠ **不自动预热**。`refresh()` 会逐账号问 `auth.usage`（网络）；
    // 48 个插件时它在后台发起一大片请求，与页面加载 265 个静态资源抢带宽，
    // 实测能把实例压到 `ECONNREFUSED`（进程直接没了）。
    // 改成**完全按需**：DSH 面板调用 `panel.snapshot` 时再算，UI 用自己的轻量接口。
    const warmUp = async () => {
        // `reload()` 之后就绪：此时 owner/provider 表才建好。
        //
        // ⚠ 必须在这里补一次快照。手机端的 `dshGo.panel({data})` 回调**可能在
        // 装配完成前**就触发了 `refresh()`（实测日志：`buildSnapshot ids=[]` 在
        // `reload ... loaded=1` 之前 2 秒），那次快照的 providers 是空的，而
        // `latest` 之后没有任何人再更新它 —— 面板于是永远显示「还没有安装 magpie
        // 插件」。桌面端没这个问题，因为打开面板时会经 RPC 重新取一次。
        await refresh(true).catch(() => { });
    };
    void reload()
        .then(() => warmUp())
        .catch((e) => {
        console.error('[reload-fail] ' + (e instanceof Error ? e.stack : String(e)));
        ctx.logger?.warn?.(`[magpie-hub] 装载 magpie 插件失败：${e instanceof Error ? e.message : String(e)}`);
    });
    // ── 热重载 ──────────────────────────────────────────────────────────────
    //
    // 装/改/删 magpie 插件后不必重启 DSH：目录一变就重扫（配合 runtime 的
    // `hotUrl()` 绕开模块缓存，改代码存盘即生效）。
    //
    // ⚠️ 用 `ctx.effect` 挂，插件卸载时 watcher 必须关掉；否则热替换会留下
    // 一串监听同一目录的 watcher（每个都会触发一次重载）。
    ctx.effect(() => {
        const handle = installHotReload({
            dir: paths.modules,
            file: paths.plugins,
            reload: async () => {
                await reload();
                await refresh();
                ctx.logger?.info?.('[magpie-hub] 检测到插件目录变化，已重新加载');
            },
            log: (message) => ctx.logger?.debug?.(`[magpie-hub] ${message}`),
            onError: (message) => ctx.logger?.warn?.(`[magpie-hub] ${message}`),
        });
        return () => { handle.stop(); };
    });
    // ── 面板 ────────────────────────────────────────────────────────────────
    //
    // view 与 data 是两次独立调用（App 先取 view 树、再订阅 data 流）：
    // - `view` 需要**完整快照**（它在视图期就把指标/环形/列表都算好），
    // - `data` 只回**依赖时钟的那几个绑定键**（`panelData` 的 routing.rows /
    //   updatedAt）。
    // 于是这里维护一个模块级 `latest`：读数据是异步的（要问每个插件的
    // auth.usage），拿不到时先给一个空快照，读到后重推 data 并让 view 跟着变。
    let latest = emptySnapshot();
    // ⚠ 在途合并 + 最小间隔：一次快照要给**每个账号**发一次 `auth.usage`（网络）。
    // 手机端每次重开面板都会重订阅 `data` 并调一次 `refresh()`，短时间连开几次
    // 或桥反复重建订阅时，会变成几十上百次并发上游请求（实测 25 秒 2 万次快照）。
    // 规则：同一时刻只有一个 `buildSnapshot` 在跑，完成后的 2 秒内复用结果。
    //
    // ⚠ **`force` 绝不能复用「装配前那次」的结果**：那次快照的 providers 是空的
    // （实测 `bs:ids=[]` 比 `reload:loaded=1` 早 200ms）。早先 `force` 只写了
    // `if (inflight) return inflight`，于是 warmUp 拿到的正是那个空快照，
    // `latest.providers` 永远是 0 —— 面板一直显示「还没有安装 magpie 插件」。
    // 现在 force 会**等在途完成后重跑一次**，保证结果来自装配之后的宿主。
    let inflightRefresh;
    let lastRefreshAt = 0;
    const REFRESH_MIN_MS = 2_000;
    const refresh = async (force = false) => {
        if (inflightRefresh !== undefined) {
            if (!force)
                return inflightRefresh;
            // 丢掉装配前的结果：先等它收尾，再自己跑一遍
            await inflightRefresh.catch(() => { });
        }
        // 快照里一个 provider 都没有（装配前的空快照）时，也不能被节流挡住。
        const empty = !Array.isArray(latest?.providers) || latest.providers.length === 0;
        if (!force && !empty && Date.now() - lastRefreshAt < REFRESH_MIN_MS)
            return;
        inflightRefresh = (async () => {
            try {
                latest = await buildSnapshot();
                notify();
                // 状态条与脚注也读这份快照（平台名、剩余额度），所以要一起推。
                // 少了这一句：引擎刚起来时状态条停在注册那一刻的空快照上，
                // 界面上只剩一个「额度」标签。
                notifySurfaces();
            }
            finally {
                lastRefreshAt = Date.now();
                inflightRefresh = undefined;
            }
        })();
        return inflightRefresh;
    };
    // ── 桌面端（DSH Web 界面）的 RPC 端点 ──────────────────────────────────
    //
    // 手机 App 走 `dshGo` 原生面板（上面那段）；**电脑端没有 dshGo**，界面是
    // DSH 自己的 Web GUI，于是状态要经 `/api/magpie-hub` 取（见 rpc.ts 头部
    // 的通道说明）。两条通道读的是**同一份 `latest` 快照**，不会两边不一致。
    //
    // ⚠️ 注册失败（没有 connection）只影响桌面界面，不影响聊天与手机面板。
    // ── 自动签到（每天一次） ────────────────────────────────────────────────
    //
    // magpie 的签到是「每北京日每账号一次」，由它自己的 beat 调度。这里用最简单
    // 且不会重复领的做法：每 10 分钟看一次，距上次成功满 24 小时就跑一轮。
    //
    // ⚠ 不用「每天 9:00 定时」：进程可能那时没开，漏了就再没机会；
    // 用「距上次满 24h」的话，开机晚了也只是晚一点领，不会漏。
    const CHECKIN_TICK_MS = 10 * 60_000;
    const CHECKIN_EVERY_MS = 24 * 60 * 60_000;
    let checkinRunning = false;
    /** 读/写自动签到状态：`{enabled, lastAt, nextAt}`；传 `enabled` 就是改开关。 */
    const checkinSchedule = async (enabled) => {
        if (enabled !== undefined)
            await settings.set('checkinAuto', enabled === true);
        const on = (await settings.get('checkinAuto')) === true;
        const lastAt = await settings.get('checkinLastAt');
        const last = typeof lastAt === 'number' && Number.isFinite(lastAt) ? lastAt : undefined;
        return {
            enabled: on,
            ...(last === undefined ? {} : { lastAt: last }),
            nextAt: last === undefined ? Date.now() : last + CHECKIN_EVERY_MS,
        };
    };
    /** 到期就跑一轮（逐账号；单个失败不影响其它）。 */
    const runCheckinIfDue = async () => {
        if (checkinRunning)
            return;
        const state = await checkinSchedule();
        if (!state.enabled || Date.now() < state.nextAt)
            return;
        checkinRunning = true;
        try {
            let claimed = 0;
            for (const provider of await host.signedInProviders()) {
                for (const accountKey of await host.accountKeys(provider)) {
                    const result = await host.checkinOf(provider, accountKey);
                    if (result?.outcome === 'claimed')
                        claimed += 1;
                }
            }
            await settings.set('checkinLastAt', Date.now());
            ctx.logger?.info?.(`[magpie-hub] 自动签到完成：新领 ${claimed}`);
            await refresh();
        }
        catch (e) {
            // 失败不推进 lastAt：下个 tick 重试（签到幂等，重复领只会回 done）
            ctx.logger?.warn?.(`[magpie-hub] 自动签到失败：${e instanceof Error ? e.message : String(e)}`);
        }
        finally {
            checkinRunning = false;
        }
    };
    // 用 ctx.effect 挂：插件卸载时关掉定时器（否则热替换会留下多个 tick）
    ctx.effect(() => {
        const timer = setInterval(() => { void runCheckinIfDue(); }, CHECKIN_TICK_MS);
        void runCheckinIfDue();
        return () => { clearInterval(timer); };
    });
    const market = new Market(paths);
    // 设置页存的私密仓库凭据要尽早生效：`installSpec` 第一次就可能用到它。
    // `settings.all()` 有内存缓存，这里读一次不会给启动加负担。
    void settings.all().then((all) => {
        tokenDraft = { github: typeof all?.tokens?.github === 'string' ? all.tokens.github : '', npm: typeof all?.tokens?.npm === 'string' ? all.tokens.npm : '' };
        display = readDisplay(all?.display);
        market.setTokens(all?.tokens);
    }).catch(() => { });
    // ── magpie 自己的 UI（原样托管在 /magpie-hub/） ─────────────────────────
    //
    // 用户要的是「UI 直接搬」：不重画界面，把 magpie 的静态资源挂到前缀路由，
    // 页面里的 `/api/` 在搬运时已改成 `/magpie-hub/api/`。接口按页面逐步补齐，
    // 未实现的回 501 并说明缺哪个（浏览器控制台一眼能看到）。
    const uiHandlers = makeUiHandlers({
        root: paths.root,
        host,
        policy,
        adapter,
        auth,
        plugins,
        snapshot: async () => latest,
        reload: async () => { await reload(); await refresh(); },
        refresh: async () => { await refresh(); },
        market,
        log: (m) => ctx.logger?.warn?.(m),
    });
    registerUi(ctx, {
        handlers: uiHandlers,
        // `boot.js` 要读 magpie 自己的 settings.json（语言/主题/字号）
        magpieSettings: async () => {
            try {
                const raw = JSON.parse(await readFile(join(paths.root, 'settings.json'), 'utf8'));
                return typeof raw === 'object' && raw !== null ? raw : {};
            }
            catch {
                return {};
            }
        },
        log: (message) => ctx.logger?.info?.(message),
    });
    registerMagpieHubApi(ctx, {
        host,
        auth,
        // 模型开关 / 供应商启停 / 账号别名 / 路由策略都在这份状态里；
        // 适配器暴露目录（含被禁用的项），供「失效清理」对账。
        policy,
        adapter,
        // 「重置额度」清掉策略层用的百分比缓存：上游额度刚重置时，
        // 旧缓存会把账号错误地排在队尾。
        clearQuota: (provider, key) => quotaUsed.delete(`${provider}#${key}`),
        // 插件升级要用到：已装清单、spec→目录名、模块目录
        plugins,
        moduleNameOf,
        modulesDir: paths.modules,
        // 自动签到：读/写开关与上次执行时间
        checkinSchedule,
        snapshot: async () => latest,
        reload: async () => {
            await reload();
            await refresh();
            return { loaded: host.loaded.length, failed: host.loadFailures.length };
        },
        setPeriod: async (next) => {
            period = next;
            await refresh();
        },
        period: () => period,
        summary: (locale) => summaryText(latest, locale),
        marketListings: (force) => market.listings(force),
        marketInstall: (pkg, signal) => market.install(pkg, signal),
        marketUninstall: async (pkg) => {
            await market.uninstall(pkg);
            // plugins.json 里还登记着的话删掉：否则重扫时 dirOfSpec 找不到目录，
            // 面板上出现一条「没有找到插件目录」的失败记录（幽灵条目）。
            await plugins.remove(pkg);
            await reload();
            await refresh();
        },
        checkin: async (provider, signal) => {
            const keys = provider === '' ? await host.signedInProviders() : await host.accountKeys(provider);
            let claimed = 0;
            let done = 0;
            let failed = 0;
            for (const key of keys) {
                if (signal?.aborted === true)
                    break;
                const id = provider === '' ? providerOfKey(key) : provider;
                const result = await host.checkinOf(id, key);
                if (result?.outcome === 'claimed')
                    claimed += 1;
                else if (result?.outcome === 'done')
                    done += 1;
                else
                    failed += 1;
            }
            await refresh();
            return { claimed, done, failed };
        },
        log: (message) => ctx.logger?.info?.(`[magpie-hub] ${message}`),
        entry: async () => {
            const raw = await settings.get('panelEntry');
            return raw === 'settings' ? 'settings' : 'sidebar';
        },
        setEntry: async (entry) => { await settings.set('panelEntry', entry); },
    });
    ctx.inject(['dshGo'], (scope) => {
        const dshGo = scope.dshGo;
        dshGo.panel(PANEL_ID, {
            // 详情视图的开关：`openProvider` 记住点开的平台，`closeProvider` 清掉。
            // App 没有弹窗节点，`refresh` 后重取视图就是「弹出/收起详情」的实现方式。
            view: (_scope, caps) => panelView(latest, caps, {
                focus: focusedProvider,
                page: currentPage,
                storeLimit,
                query: searchQuery,
                searchOpen,
                // 首屏就带上最近一次安装结果：data 只能覆盖已有节点，
                // 视图重建时（切页、重开面板）还得从参数里拿
                install: installStatus,
                update: updateStatus,
                plugin: focusedPlugin,
                display,
                models: modelsOpen,
            }),
            data: (_scope, emit, caps) => {
                let last;
                const push = () => {
                    const data = panelData(latest, caps?.locale, Date.now(), {
                        page: currentPage,
                        query: searchQuery,
                        spec: '',
                        tokens: tokenDraft,
                        install: installStatus,
                        update: updateStatus,
                        plugin: focusedPlugin,
                        display,
                    });
                    const json = JSON.stringify(data);
                    if (json === last)
                        return;
                    last = json;
                    emit(data);
                };
                feeds.add(push);
                push();
                // 面板打开时读一次真实数据（这个回调只在打开时跑一次）
                void refresh().catch(() => { });
                return () => {
                    feeds.delete(push);
                };
            },
            actions: {
                /**
                 * 点开某个平台的卡片 → 切到详情视图。
                 *
                 * 返回 `refresh` 让 App 重拉视图；焦点存在插件侧，所以视图是
                 * 纯函数也能表达「当前在看谁」（App 不保存插件的临时界面状态）。
                 */
                /**
                 * 插件页点一个插件 → 跳到它的平台（配置与登录都在平台页里）。
                 *
                 * 用户原话：「只有登录需求时跳转到平台界面」。插件本身没有
                 * 独立的配置面，所以这里就是「切到平台页 + 聚焦它声明的第一个平台」。
                 */
                openPlugin: (_scope, event) => {
                    const spec = event?.value?.spec;
                    if (typeof spec !== 'string' || spec === '') {
                        return [];
                    }
                    focusedPlugin = spec;
                    // ⚠ 必须同时推一次 data：带 `bind` 的输入控件会被 App 把
                    // `value` 改写成 `{$: bind}`，初值完全由 data 里的
                    // `data.plugin.options` 决定。只发 refresh 的话视图重建了、
                    // 输入框却是空的（真机验证过）。
                    notify();
                    return [{
                            type: 'refresh',
                            id: PANEL_ID,
                        }];
                },
                /** 插件配置页的「返回」：回到插件列表。 */
                closePlugin: () => {
                    focusedPlugin = null;
                    notify();
                    return [{
                            type: 'refresh',
                            id: PANEL_ID,
                        }];
                },
                /**
                 * 保存插件的运行选项（App 的 v2 视图里 `textField` 是控件，
                 * 提交时值走 `event.value.values['data.plugin.options']`）。
                 *
                 * 与桌面端同一份判据：内容必须是一个 JSON 对象，写进 `plugins.json`
                 * 的 `options`，下一次 `reload()` 时作为第二参交给插件工厂
                 * （`runtime.js` 的 `factory(ctx, installed.options)`）。
                 */
                savePluginOptions: (_scope, event) => {
                    if (typeof focusedPlugin !== 'string' || focusedPlugin === '')
                        return [];
                    const raw = event?.value?.values?.['data.plugin.options'] ?? event?.value?.value;
                    return startSaveOptions(focusedPlugin, raw, event?.locale);
                },
                /** 清空运行选项：删掉 `options` 键，插件按自己的缺省跑。 */
                clearPluginOptions: (_scope, event) => startClearOptions(focusedPlugin, event?.locale),
                /**
                 * 插件开关。**拆成幂等的两个动作**而不是一个 toggle：
                 * 后台动作完成后没有 action 能返回 `refresh`，视图不会重建，
                 * 一个「停用/启用」共用按钮的文案就会一直停在旧值。
                 * 两个按钮各自做自己的事，点哪个都不会错乱。
                 */
                enablePlugin: () => startSetPluginEnabled(focusedPlugin, true),
                disablePlugin: () => startSetPluginEnabled(focusedPlugin, false),
                /** 移除插件：从清单里删掉并重扫（不删磁盘目录，可再装回来）。 */
                removePlugin: (_scope, event) => startRemovePlugin(focusedPlugin, event?.locale),
                /** 插件页「检查更新」：后台问 npm registry，结果回推到快照。 */
                /** 商店「显示更多」：多放一屏，避免一次铺出全部。 */
                moreStore: () => {
                    storeLimit += 24;
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                checkUpdates: (_scope, event) => startUpdateCheck(event?.locale),
                /** 插件页「更新全部」：逐个覆盖安装有新版的插件。 */
                updateAllPlugins: (_scope, event) => startUpdateAll(event?.locale),
                openProvider: (_scope, event) => {
                    const id = event?.value?.provider;
                    if (typeof id !== 'string' || id === '')
                        return [];
                    focusedProvider = id;
                    return [{
                            type: 'refresh',
                            id: PANEL_ID,
                        }];
                },
                /** 详情视图的「返回」：清掉焦点，回到平台卡片列表。 */
                closeProvider: () => {
                    focusedProvider = null;
                    return [{
                            type: 'refresh',
                            id: PANEL_ID,
                        }];
                },
                /**
                 * 切页（顶部 `chips` 导航）。
                 *
                 * App 把 `{ bind: 'data.ui.page', value: '<页 id>' }` 发过来；
                 * 存进 `currentPage` 再 `refresh`，视图就换成那一页。
                 */
                switchPage: (_scope, event) => {
                    const next = event?.value?.value;
                    // 'store' 已并入插件页（页签只有 5 个），不再接受它作为目标页。
                    if (typeof next === 'string' && ['agents', 'quotas', 'usage', 'plugins', 'settings'].includes(next)) {
                        currentPage = next;
                        modelsOpen = false;
                        focusedPlugin = null;
                        storeLimit = 8;
                        focusedProvider = null;
                    }
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                /**
                 * 设置页的「显示」控件（`chips`，带 bind）。
                 *
                 * 三种控件共用一个 action，靠 `bind` 分辨改哪一项 —— App 的 change
                 * 通道会把 `{bind, value}` 一起发回来（`dsh_ui_plugin_controls_state.dart:141`）。
                 */
                setDisplay: (_scope, event) => {
                    const bind = typeof event?.value?.bind === 'string' ? event.value.bind : '';
                    const value = event?.value?.value;
                    const next = { ...display };
                    if (bind === 'data.display.strip')
                        next.strip = value === 'on';
                    else if (bind === 'data.display.note')
                        next.note = value === 'on';
                    else if (bind === 'data.display.noteKind')
                        next.noteKind = value === 'quota' ? 'quota' : 'tokens';
                    else if (bind === 'data.display.models')
                        next.models = value === 'flat' ? 'flat' : 'group';
                    display = readDisplay(next);
                    void settings.set('display', display).catch(() => { });
                    // 状态条与脚注立刻跟着变，不用等下一次模型调用。
                    notifySurfaces();
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                /** 设置页「浏览模型」：整页换成模型列表。 */
                showModels: () => {
                    modelsOpen = true;
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                /** 模型页返回设置。 */
                closeModels: () => {
                    modelsOpen = false;
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                /** 点放大镜图标：把搜索框展开。 */
                openSearch: () => {
                    searchOpen = true;
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                /** 收起搜索：同时清掉关键词，否则列表还停在过滤后的结果。 */
                closeSearch: () => {
                    searchOpen = false;
                    searchQuery = '';
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                /** 平台页搜索（`form` 提交，值在 `values['data.search.query']`）。 */
                /**
                 * 平台页搜索：两种来源都要认。
                 *
                 * - `textField.onChange`：App 发 `{ bind, value }`（`change` 通道）；
                 * - `form.submit`：App 发 `{ values: { 'data.search.query': … } }`。
                 *
                 * 现在面板用的是前者（一打就过滤，没有提交按钮）。
                 */
                searchProviders: (_scope, event) => {
                    const fromChange = event?.value?.value;
                    const fromForm = event?.value?.values?.['data.search.query'];
                    const raw = typeof fromChange === 'string' ? fromChange : fromForm;
                    searchQuery = typeof raw === 'string' ? raw.trim() : '';
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                /** 清空搜索。 */
                clearSearch: () => {
                    searchQuery = '';
                    searchOpen = false;
                    return [{ type: 'refresh', id: PANEL_ID }];
                },
                /**
                 * 商店页：装一个市场里的包（`list` 行点击，`spec` = package 名）。
                 *
                 * ⚠ 必须**立刻**返回，装完再回推：App 的点击窗口只有 3 秒
                 * （`dsh-Go/app/lib/plugins/native/native_model.dart:104`
                 * `tapWindow = Duration(seconds: 3)`），而下载 + 解包 + 重扫 12 个
                 * 插件动辄好几秒。等它跑完再返回，App 已经判超时并把输入框标成
                 * 「未保存，请重试」—— 包其实装好了，但用户看到的是失败。
                 */
                installPlugin: (_scope, event) => {
                    const spec = event?.value?.spec;
                    return startInstall(typeof spec === 'string' ? spec : '', event?.locale);
                },
                /**
                 * 商店页最底部的手输安装（`form` 提交）。
                 *
                 * 支持 npm 包名 / `owner/repo` / GitHub 链接（可带 `#子目录`），
                 * 解析见 `market.js` 的 `parseSpec`。
                 */
                installSpec: (_scope, event) => {
                    const raw = event?.value?.values?.['data.install.spec'];
                    return startInstall(typeof raw === 'string' ? raw.trim() : '', event?.locale);
                },
                /**
                 * 设置页的「仓库密钥」（`form` 提交）。
                 *
                 * 私密仓库的包公开源拉不到，必须带 token。存 `hub-settings.json`
                 * 的 `tokens` 键（与 `panelEntry` 同一份文件），同时热更新到
                 * 内存里的 `market`——否则要等下次重载才生效。
                 */
                saveTokens: async (_scope, event) => {
                    const values = event?.value?.values ?? {};
                    const next = {
                        github: typeof values['data.tokens.github'] === 'string' ? values['data.tokens.github'].trim() : '',
                        npm: typeof values['data.tokens.npm'] === 'string' ? values['data.tokens.npm'].trim() : '',
                    };
                    await settings.set('tokens', next);
                    market.setTokens(next);
                    tokenDraft = { ...next };
                    return [{
                            type: 'toast',
                            text: text(event?.locale, '已保存密钥', 'Tokens saved'),
                        }];
                },
                /**
                 * 复制一份概览（面板 Agent 页的按钮）。
                 *
                 * 走 `copy` 效果而不是 toast：内容是多行文本，toast 装不下。
                 */
                copySummary: (_scope, event) => [{
                        type: 'copy',
                        text: summaryText(latest, event?.locale),
                    }],
                /** 刷新「用量」页的数据（重扫记录并重算统计）。 */
                refreshStats: async (_scope, event) => {
                    await refresh();
                    return [{
                            type: 'toast',
                            text: text(event?.locale, '用量已刷新', 'Usage refreshed'),
                        }];
                },
                /** 刷新「路由」页的数据。 */
                refreshRouting: async (_scope, event) => {
                    await refresh();
                    return [{
                            type: 'toast',
                            text: text(event?.locale, '路由已刷新', 'Routing refreshed'),
                        }];
                },
                /**
                 * 切时间窗（`statsPeriod` options）。
                 *
                 * `value` 形如 `{ value: '7d' }`；非法值保持原窗口不变（不重算、不报错）。
                 * 切完立刻重算统计并重推，面板跟着变。
                 */
                statsPeriod: async (_scope, event) => {
                    const raw = event?.value?.value;
                    const next = raw === 'today' || raw === '7d' || raw === '30d' || raw === 'all' ? raw : undefined;
                    if (next === undefined)
                        return [];
                    period = next;
                    await refresh();
                    return [];
                },
                /** 重新扫描插件目录（装了新 magpie 插件、或改了登录态后用）。 */
                reloadPlugins: async (_scope, event) => {
                    await reload();
                    await refresh();
                    return [{ type: 'toast', text: text(event?.locale, '已重新扫描插件', 'Plugins rescanned') }];
                },
                /** 刷新模型目录（`provider.models` 缓存 60 秒，这是手动失效）。 */
                refreshCatalog: async (_scope, event) => {
                    adapter.invalidateCatalog();
                    await refresh();
                    return [{ type: 'toast', text: text(event?.locale, '模型目录已刷新', 'Model catalog refreshed') }];
                },
                /**
                 * 签到（`auth.checkin`）—— 慢操作，用 Deferred。
                 *
                 * 契约：签到是**每北京日每账号一次**，由宿主调度；这里只是「立刻签一次」
                 * 的入口。`done`（今天已领过）与 `failed` 必须分开计数 —— 重复领取时
                 * 厂商通常回 2xx 但内容为空，那是 done 不是 failed。
                 */
                checkin: (_scope, event) => ({
                    pending: {
                        label: text(event?.locale, '签到中…', 'Checking in…'),
                        timeoutMs: CHECKIN_TIMEOUT_MS,
                    },
                    result: async (signal) => {
                        const provider = providerArg(event);
                        const keys = provider === '' ? await host.signedInProviders() : await host.accountKeys(provider);
                        let claimed = 0;
                        let done = 0;
                        let failed = 0;
                        for (const key of keys) {
                            if (signal.aborted)
                                break;
                            const result = await host.checkinOf(provider === '' ? providerOfKey(key) : provider, key);
                            if (result?.outcome === 'claimed')
                                claimed += 1;
                            else if (result?.outcome === 'done')
                                done += 1;
                            else
                                failed += 1;
                        }
                        await refresh();
                        return [{
                                type: 'toast',
                                text: text(event?.locale, `签到：新领 ${claimed} · 已领 ${done} · 失败 ${failed}`, `Check-in: ${claimed} claimed · ${done} already · ${failed} failed`),
                            }];
                    },
                }),
                /** 刷新额度（重跑每个 provider 的 `auth.usage`）。 */
                refreshUsage: async (_scope, event) => {
                    await refresh();
                    return [{ type: 'toast', text: text(event?.locale, '额度已刷新', 'Allowances refreshed') }];
                },
                /**
                 * 开始登录（手机端点了「登录：<方式>」）。
                 *
                 * 契约要求 `authorize()` **立刻返回 flow**（在里面等用户会和宿主死锁），
                 * 所以这里只取 flow 就返回：
                 * - 拿到 `url` → 记进 `pendingSignIn`，回 `{link}` 让 App 打开浏览器；
                 * - 没有 `url`（`api` 型、或插件自己导入了本机登录态）→ 已经落盘，直接刷新。
                 */
                signIn: async (_scope, event) => {
                    const provider = providerArg(event);
                    if (provider === '')
                        return [{ type: 'toast', text: text(event?.locale, '缺少平台', 'Missing provider') }];
                    const raw = event?.value?.index;
                    const index = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
                    let out;
                    try {
                        out = await host.startSignIn(provider, index, event?.value?.inputs);
                    }
                    catch (e) {
                        return [{
                                type: 'toast',
                                text: text(event?.locale, `登录失败：${messageOf(e)}`, `Sign-in failed: ${messageOf(e)}`),
                            }];
                    }
                    await refresh();
                    // `api` 型会直接成功（startSignIn 已经存盘），没有 url。
                    if (out.url === undefined || out.url === '') {
                        pendingSignIn.delete(provider);
                        await refresh();
                        return [{
                                type: 'toast',
                                text: text(event?.locale, `已登录：${provider}`, `Signed in to ${provider}`),
                            }];
                    }
                    const label = methodLabel(host, provider, index);
                    pendingSignIn.set(provider, { index, label });
                    await refresh();
                    return [
                        // ⚠ `link` 是 App 打开外部浏览器用的，只收 https；非 https 就不发这个效果。
                        ...(out.url.startsWith('https://') ? [{ type: 'link', url: out.url }] : []),
                        {
                            type: 'toast',
                            text: out.url.startsWith('https://')
                                ? text(event?.locale, '已打开授权页，完成后点「我已完成」', 'Authorisation page opened — tap "Done" when finished')
                                : text(event?.locale, `请手动打开：${out.url}`, `Open this address: ${out.url}`),
                        },
                    ];
                },
                /** 登录收尾（用户从浏览器回来点「我已完成」）。 */
                signInFinish: async (_scope, event) => {
                    const provider = providerArg(event);
                    if (provider === '')
                        return [{ type: 'toast', text: text(event?.locale, '缺少平台', 'Missing provider') }];
                    const pending = pendingSignIn.get(provider);
                    const raw = event?.value?.index;
                    const index = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
                        ? raw
                        : pending?.index ?? 0;
                    const code = typeof event?.value?.code === 'string' ? event.value.code : undefined;
                    try {
                        const out = await host.finishSignIn(provider, index, code);
                        pendingSignIn.delete(provider);
                        await refresh();
                        return [{
                                type: 'toast',
                                text: text(event?.locale, `已登录：${out.accountId ?? provider}`, `Signed in: ${out.accountId ?? provider}`),
                            }];
                    }
                    catch (e) {
                        return [{
                                type: 'toast',
                                text: text(event?.locale, `登录未完成：${messageOf(e)}`, `Sign-in incomplete: ${messageOf(e)}`),
                            }];
                    }
                },
                /**
                 * 保存 API Key（`api` 型的表单提交）。
                 *
                 * 表单的 `submit` 不带参数，所以按绑定路径 `data.login.<provider>.key`
                 * 反查是哪个 provider 交上来的 —— 路径里带 `.` 的 provider id 不可能
                 * 是合法 slug，直接用第一个非空的那条即可。
                 */
                saveKey: async (_scope, event) => {
                    const values = event?.value?.values;
                    const filled = values !== null && typeof values === 'object'
                        ? Object.entries(values).filter(([path, v]) => path.startsWith(LOGIN_PATH) && typeof v === 'string' && v.trim() !== '')
                        : [];
                    if (filled.length === 0) {
                        return [{ type: 'toast', text: text(event?.locale, '请填写密钥', 'Enter a key first') }];
                    }
                    let saved = 0;
                    for (const [path, value] of filled) {
                        const provider = path.slice(LOGIN_PATH.length).split('.')[0];
                        if (provider === '')
                            continue;
                        try {
                            await host.startSignIn(provider, 0, { key: value.trim() });
                            pendingSignIn.delete(provider);
                            saved += 1;
                        }
                        catch {
                            // 单个失败不影响别的 provider（表单可能一次带多个）。
                        }
                    }
                    await refresh();
                    return [{
                            type: 'toast',
                            text: saved === 0
                                ? text(event?.locale, '保存失败', 'Save failed')
                                : text(event?.locale, `已保存 ${saved} 个密钥`, `Saved ${saved} key${saved === 1 ? '' : 's'}`),
                        }];
                },
            },
        });
        /**
         * 输入框上方的额度状态条。
         *
         * 显示「当前平台 · 剩余额度」，点按直接打开面板（清单里写了 `panel`）。
         * 文字上限 24 字（`kit-lib-bridge-limits.js` 的 `stripText`），超了桥接
         * 会截断，所以平台名先压缩成短名。
         */
        dshGo.strip(STRIP_ID, (_scope, emit, caps) => {
            const push = () => {
                // 设置页可以关掉它（`display.strip`）。关掉时发空文字，App 就不画这一条。
                if (display.strip !== true) {
                    emit({ text: '' });
                    return;
                }
                emit({ text: stripLine(latest, currentProviderId(latest, records), caps?.locale), icon: 'coin' });
            };
            surfaceFeeds.add(push);
            push();
            return () => {
                surfaceFeeds.delete(push);
            };
        });
        /**
         * 每回合脚下的消耗脚注。
         *
         * `scope.sessionId` 用来分桶（同一插件在多个对话里各算各的）；回合号是
         * 近似值，见上面 `noteRecord` 的说明。每段 16 字，超了桥接会截。
         */
        dshGo.turnNote(NOTE_ID, (scope, emit) => {
            const sessionId = typeof scope?.sessionId === 'string' ? scope.sessionId : '';
            const push = () => {
                // 设置页可以关掉脚注（`display.note`）；关掉时发空对象，App 就不画。
                if (display.note !== true) {
                    emit({});
                    return;
                }
                // 优先本会话的桶；没有就退回单桶（见 `noteRecord` 的说明）。
                //
                // ⚠ 脚注整段必须放得下，否则 App 会**整条丢掉 note**（`turn_footnote.dart`
                // 的 `variants` 降级链里，含 note 的版本排第一，放不下就换不含它的），
                // 所以 `noteLine` 里不要把平台名和数字都写长。
                // App 的会话 id 与我们 `record` 收到的不一定一致（「重新回答」会在
                // 新会话里重发，而脚注仍挂在原消息所在的会话上），所以本会话的桶
                // 取不到时，把所有桶合并发出去 —— 脚注只显示消耗数字，串一点无妨，
                // 拿不到就完全不显示才是真问题。
                const own = sessionNotes.get(sessionId);
                if (own !== undefined)
                    emit(own);
                else {
                    const merged = {};
                    for (const bucketNotes of sessionNotes.values())
                        Object.assign(merged, bucketNotes);
                    emit(merged);
                }
            };
            surfaceFeeds.add(push);
            push();
            return () => {
                surfaceFeeds.delete(push);
            };
        });
    });
    /**
     * 组装面板要的那个快照。
     *
     * ⚠️ 这是**唯一**会去问插件（`auth.usage`）的地方：逐个 provider、逐个账号
     * 都要发一次请求，所以放在 `refresh()` 里按需跑，不在 `view` 里同步做。
     */
    const buildSnapshot = async () => {
        // plugins.json 里登记了几条 —— 空态要拿它跟「实际装载了几个」对照，
        // 一眼分辨是「登记为空」还是「登记了但全部装载失败」。
        const storedCount = (await plugins.list().catch(() => [])).length;
        const providers = [];
        const usage = [];
        /** 待查额度的账号（收集完再统一限并发问，不在这里逐个 await）。 */
        const usageTargets = [];
        // 用户策略：别名改显示名、隐藏的账号不进面板、停用的供应商标出来
        const state = await policy.get();
        const bsIds = host.providerIds();
        for (const id of bsIds) {
            const cfg = host.providerConfig(id);
            const keys = await host.accountKeys(id);
            const accounts = [];
            for (const key of keys) {
                if (state.hiddenAccounts.has(key))
                    continue;
                const stored = await host.ensureFresh(id, key);
                const alias = state.accountAliases[key];
                accounts.push({
                    key,
                    accountId: stored === undefined ? key : whoOf(stored) || key,
                    ...(typeof alias === 'string' && alias !== '' ? { alias } : {}),
                    signIn: signInOf(stored),
                });
            }
            providers.push({
                id,
                name: providerName(id),
                accounts,
                models: cfg?.models === undefined ? 0 : Object.keys(cfg.models).length,
                // 模型名要一起带上：设置页有「模型列表」入口，按供应商分组展示要用它。
                // 只给 id 数组（`cfg.models` 的值是模型配置对象，不适合塞进快照）。
                modelIds: cfg?.models === undefined ? [] : Object.keys(cfg.models),
                off: state.offProviders.has(id),
                hasUsage: host.declares(id, 'usage'),
                hasCheckin: host.declares(id, 'checkin'),
                // 登录方式：**手机端要靠它画出登录入口**（旧版只给状态文字，
                // 于是手机上根本没法登录 —— 这是用户指出的真实缺口）。
                // 只投影可序列化的字段，`authorize`/`callback` 这类函数绝不外传。
                methods: host.methodsOf(id).map((m, index) => ({
                    index,
                    type: m.type === 'api' ? 'api' : 'oauth',
                    label: typeof m.label === 'string' && m.label !== '' ? m.label : `${id} ${index + 1}`,
                    ...(typeof m.placeholder === 'string' ? { placeholder: m.placeholder } : {}),
                })),
                // 正在等授权的那个登录方式：面板据此画「我已完成」。
                ...(pendingSignIn.has(id) ? { pending: pendingSignIn.get(id) } : {}),
                ...(keys.length === 0 && host.ownerOf(id) === undefined
                    ? { error: text(undefined, '没有插件提供这个平台', 'No plugin provides this provider') }
                    : {}),
            });
            if (!host.declares(id, 'usage'))
                continue;
            for (const key of keys)
                usageTargets.push({ id, key });
        }
        // ── 额度：**限并发**地逐个账号问 ────────────────────────────────────
        //
        // 早先这里是串行 `await`：48 个供应商、每个账号一次 `auth.usage`（网络），
        // 首屏要几十秒，表现为「第一次打开面板 provider 数是 0，等一会儿才有」。
        // 改成 6 路并发：不把上游打爆，也不让首屏卡住。
        await mapLimit(usageTargets, USAGE_CONCURRENCY, async ({ id, key }) => {
            const result = await host.usageOf(id, key);
            if (result === undefined)
                return;
            usage.push({
                provider: id,
                accountKey: key,
                // 只放账号本身：provider 名已经是这组的小节标题，再拼一次会让
                // 同一个名字在一屏里出现三次（实测「WPS 灵犀 Lingxi」重复三遍）。
                label: key,
                ...(typeof result.plan === 'string' ? { plan: result.plan } : {}),
                ...(typeof result.user === 'string' ? { user: result.user } : {}),
                ...(result.until === undefined ? {} : { until: result.until }),
                ...(typeof result.balance === 'number' ? { balance: String(result.balance) }
                    : typeof result.balance === 'string' ? { balance: result.balance } : {}),
                ...(result.error === undefined ? {} : { error: result.error }),
                windows: (result.windows ?? []).map((w) => ({
                    name: w.name,
                    ...(typeof w.used === 'number' ? { used: w.used } : {}),
                    ...(typeof w.display === 'string' ? { display: w.display } : {}),
                    ...(typeof w.amount === 'number' ? { amount: w.amount } : {}),
                    ...(typeof w.limit === 'number' ? { limit: w.limit } : {}),
                    ...(typeof w.unit === 'string' ? { unit: w.unit } : {}),
                    ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }),
                    ...(w.aside === true ? { aside: true } : {}),
                })),
            });
            // 给 `fastest` 路由策略留一份「这个账号用掉多少」：
            // 取各窗口里**最紧**的那个百分比（最可能先撞墙的那道额度），
            // 没有数值型 used 就不写，让策略层把「未知」和「0%」分开。
            const used = (result.windows ?? [])
                .map((w) => w.used)
                .filter((u) => typeof u === 'number' && Number.isFinite(u));
            if (used.length > 0)
                quotaUsed.set(`${id}#${key}`, Math.max(...used));
            else
                quotaUsed.delete(`${id}#${key}`);
        });
        // ── 统计：按当前时间窗过滤记录后重算 ────────────────────────────────
        //
        // ⚠️ 不读 `stats` 那个滚动累计值：它是**全时段**的，而面板要的是「今天 /
        // 7 天 / 30 天 / 全部」。这里从 `records` 重算（最多 500 条，成本可忽略），
        // 于是切窗只是重算，不会漏也不会重复。
        const windowed = recordsSince(records, period, Date.now());
        let tokens = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let calls = 0;
        let errors = 0;
        // 费用与「算不出价的请求数」：magpie 的费用卡是两个数一起说
        // （「≈¥2447+ · 245 个没有价格」），所以两个都累计。
        let cost = 0;
        let unpriced = 0;
        const byProvider = new Map();
        // 时间桶：今天按小时（24 点），其余按天
        const hourly = period === 'today';
        const buckets = new Map();
        for (const row of windowed) {
            calls += 1;
            if (row.status === 'error')
                errors += 1;
            const rowTokens = row.tokens ?? 0;
            const rowCost = typeof row.cost === 'number' ? row.cost : undefined;
            tokens += rowTokens;
            if (rowCost === undefined)
                unpriced += 1;
            else
                cost += rowCost;
            const tally = byProvider.get(row.provider)
                ?? { calls: 0, errors: 0, tokens: 0, cost: 0, unpriced: 0 };
            tally.calls += 1;
            if (row.status === 'error')
                tally.errors += 1;
            tally.tokens += rowTokens;
            if (rowCost === undefined)
                tally.unpriced += 1;
            else
                tally.cost += rowCost;
            byProvider.set(row.provider, tally);
            const label = bucketLabel(row.at, hourly);
            const bucket = buckets.get(label) ?? { tokens: 0, calls: 0, cost: 0, byProvider: {} };
            bucket.tokens += rowTokens;
            bucket.calls += 1;
            bucket.cost += rowCost ?? 0;
            bucket.byProvider[row.provider] = (bucket.byProvider[row.provider] ?? 0) + rowTokens;
            buckets.set(label, bucket);
        }
        const series = [...buckets.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([label, b]) => ({ label, tokens: b.tokens, calls: b.calls, cost: b.cost, byProvider: b.byProvider }));
        return {
            providers,
            usage,
            stats: {
                period,
                tokens,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                calls,
                errors,
                retried: 0,
                cost,
                unpriced,
                series,
                byProvider: [...byProvider.entries()].map(([id, r]) => ({
                    id,
                    name: providerName(id),
                    tokens: r.tokens,
                    calls: r.calls,
                    errors: r.errors,
                    cost: r.cost,
                    unpriced: r.unpriced,
                })),
            },
            routing: records.slice(-40).reverse().map((r) => ({
                at: r.at,
                provider: r.provider,
                model: r.model,
                status: r.status,
                ms: r.ms,
                ...(r.error === undefined ? {} : { error: r.error }),
            })),
            // 商店（手机端只看已装包）：把市场清单与已装目录求交集。
            // ⚠️ 清单可能拉不到（离线）⇒ 空数组，手机面板就没有商店页签（条件渲染）。
            store: await installedStoreEntries(host, market),
            // 插件页：已装载的插件 + 它声明的平台（点它跳到那个平台的详情页做登录/配置）。
            // 版本从 `plugins/node_modules/<pkg>/package.json` 读——磁盘上的真实版本，
            // 「有没有新版」只能拿它跟 registry 比，不能从 spec 字符串猜。
            plugins: await pluginPageEntries(),
            pluginFailures: host.loadFailures.map(f => ({ spec: f.spec, error: String(f.error ?? '') })),
            // 空态自证：面板一句「还没有安装 magpie 插件」在用户设备上等于没说，
            // 得把「查的是哪个数据根、登记几个、装载几个、失败几个」一起吐出来。
            diagnostics: {
                root: paths.root,
                declared: storedCount,
                loaded: host.loaded.length,
                failed: host.loadFailures.length,
                firstError: host.loadFailures.length === 0 ? '' : String(host.loadFailures[0]?.error ?? ''),
            },
        };
    };
    /**
     * 装一个插件（商店页的两处入口共用）。
     *
     * 两条路径：
     * - 市场清单里的包 → `market.install`（拉 plugins monorepo 的整仓 tarball 解子树）；
     * - 任意 spec（npm 名 / owner/repo / GitHub 链接）→ `market.installSpec`。
     *
     * 装完**必须登记** `plugins.json`：`plugins/node_modules/<pkg>` 存在只代表
     * 文件在磁盘上，`PluginStore.list()` 读的是 `plugins.json`，不登记就永远
     * 不会被装载（`dirOfSpec` 也会因为「没有 catalog 条目」跳过它）。
     * 登记用**裸包名**——手机上的包全部在 `plugins/node_modules` 下，裸名即可解析。
     */
    async function installOne(spec, locale) {
        const raw = typeof spec === 'string' ? spec.trim() : '';
        if (raw === '') {
            return { ok: false, error: text(locale, '请先填写包名或链接', 'Enter a package or link first') };
        }
        // 已装的用绝对路径或 URL 登记过时，同一个包再按裸名 add 会变成两条
        // ——先按「目录名」判重，已登记就不重复写。
        let result;
        try {
            const listings = await market.listings().catch(() => []);
            const inMarket = listings.find(l => l.package === raw);
            result = inMarket === undefined
                ? await market.installSpec(raw)
                : await market.install(inMarket.package);
        }
        catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (result.ok !== true) {
            return { ok: false, error: result.error ?? text(locale, '未知错误', 'unknown') };
        }
        // 登记（用实际落盘的目录名；installSpec 会回 package）。
        // 市场里的包走 `install` 不回 package，用 moduleNameOf 从 spec 推
        // （它会剥掉 `@version` 与 `github:`，与磁盘目录名一致）。
        const name = typeof result.package === 'string' && result.package !== ''
            ? result.package
            : moduleNameOf(raw);
        try {
            const known = (await plugins.list()).some(x => moduleNameOf(x.spec) === name);
            if (!known)
                await plugins.add(name);
        }
        catch { /* 登记失败不掩盖「装上了」这件事，下面的重扫会显示真实状态 */ }
        // 装完重扫 + 重推：用户不需要知道「要重启才生效」
        await reload();
        await refresh();
        return { ok: true, name };
    }
    /**
     * 立刻回一句、把安装丢后台。
     *
     * 为什么不能 `await installOne()` 再返回：App 的点击窗口只有 3 秒
     * （`dsh-Go/app/lib/plugins/native/native_model.dart:104` `tapWindow`），
     * 而「下载 tarball → 解包 → 重扫 12 个插件 → 拉一次数据」轻松超过它。
     * 超时后 App 会把这个 form 标成 `plugInputFailed`（「未保存，请重试」），
     * 于是出现最糟的组合：**包装好了，界面说失败**。
     *
     * 所以 action 只负责「受理」；结果写进 `installStatus`，随下一次数据推送
     * 出现在商店页顶部（`storePage` 的安装状态行）。
     */
    function startInstall(spec, locale) {
        const raw = typeof spec === 'string' ? spec.trim() : '';
        if (raw === '') {
            return [{ type: 'toast', text: text(locale, '请先填写包名或链接', 'Enter a package or link first') }];
        }
        installStatus = { state: 'running', spec: raw, at: Date.now() };
        // 立刻把「正在安装」推给商店页（用户能看到受理了，不会以为没反应）
        notify();
        void installOne(raw, locale)
            .then((result) => {
            installStatus = result.ok === true
                ? { state: 'ok', spec: raw, name: result.name ?? raw, at: Date.now() }
                : { state: 'failed', spec: raw, error: result.error ?? '', at: Date.now() };
        })
            .catch((e) => {
            installStatus = {
                state: 'failed',
                spec: raw,
                error: e instanceof Error ? e.message : String(e),
                at: Date.now(),
            };
        })
            .finally(() => { notify(); });
        return [{
                type: 'toast',
                text: text(locale, `正在安装 ${raw}…`, `Installing ${raw}…`),
            }];
    }
    /**
     * 插件页「检查更新」：逐个问 registry 的 latest，跟磁盘上的版本比。
     *
     * 后台跑（App 的点击窗口只有 3 秒），结果写进 `updateStatus` 由快照回推。
     * 只比 npm 包：GitHub 源没有版本号，读不到 package.json 的也跳过——
     * 宁可少报，不要凭空说「有新版本」。
     */
    function startUpdateCheck(locale) {
        if (updateStatus?.state === 'running') {
            return [{ type: 'toast', text: text(locale, '正在检查更新…', 'Checking for updates…') }];
        }
        updateStatus = { state: 'running', updatable: [], to: {}, at: Date.now() };
        notify();
        void (async () => {
            const updatable = [];
            const to = {};
            // 按**包名**去重：`host.loaded` 是插件函数粒度，一个包可导出多个，
            // 直接遍历会把同一个包查多次、计数也翻倍（实测 13 > 10 个包）。
            const seen = new Set();
            for (const p of host.loaded) {
                const pkg = p.packageName ?? p.spec;
                if (typeof pkg !== 'string' || pkg === '' || seen.has(pkg))
                    continue;
                seen.add(pkg);
                const current = await pluginVersion(paths, pkg);
                if (current === undefined)
                    continue;
                const latest = await market.latestVersion(pkg);
                if (latest === undefined || latest === current || !isNewer(latest, current))
                    continue;
                updatable.push(pkg);
                to[pkg] = latest;
            }
            updateStatus = { state: 'ok', updatable, to, at: Date.now() };
        })()
            .catch((e) => {
            updateStatus = {
                state: 'failed',
                updatable: [],
                to: {},
                error: e instanceof Error ? e.message : String(e),
                at: Date.now(),
            };
        })
            .finally(() => { notify(); });
        return [{ type: 'toast', text: text(locale, '正在检查更新…', 'Checking for updates…') }];
    }
    /**
     * 保存一个插件的运行选项。
     *
     * 与桌面端同一个判据（`ui/plugins.js` 的 Options 编辑器）：内容必须是一个
     * JSON **对象**，写进 `plugins.json` 的 `options`；下一次 `reload()` 时
     * `runtime.js:300` 会把它当第二参交给插件工厂。
     */
    function startSaveOptions(spec, raw, locale) {
        if (typeof spec !== 'string' || spec === '')
            return [];
        const draft = typeof raw === 'string' ? raw.trim() : '';
        if (draft === '')
            return [{ type: 'toast', text: text(locale, '选项是空的；要移除请用「清空」', 'Options are empty; use Clear to remove them') }];
        let parsed;
        try {
            parsed = JSON.parse(draft);
        }
        catch (e) {
            return [{ type: 'toast', text: text(locale, `不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`, `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }];
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return [{ type: 'toast', text: text(locale, '选项必须是一个 JSON 对象', 'Options are a JSON object') }];
        notify();
        void (async () => {
            await plugins.setOptions(spec, parsed);
            await reload();
            await refresh(true).catch(() => { });
        })()
            .catch((e) => {
            console.error('[magpie-hub] 保存选项失败：' + (e instanceof Error ? e.message : String(e)));
        })
            .finally(() => { notify(); });
        return [{ type: 'toast', text: text(locale, '已保存，正在重扫插件…', 'Saved; rescanning plugins…') }];
    }
    /** 清空运行选项：删掉 `options` 键（桌面端的 Clear）。 */
    function startClearOptions(spec, locale) {
        if (typeof spec !== 'string' || spec === '')
            return [];
        void (async () => {
            await plugins.setOptions(spec, null);
            await reload();
            await refresh(true).catch(() => { });
        })()
            .catch((e) => {
            console.error('[magpie-hub] 清空选项失败：' + (e instanceof Error ? e.message : String(e)));
        })
            .finally(() => { notify(); });
        return [{ type: 'toast', text: text(locale, '已清空选项，正在重扫插件…', 'Cleared; rescanning plugins…') }];
    }
    /** 插件开关（桌面端的 Switch off / Switch on），幂等。 */
    function startSetPluginEnabled(spec, enabled) {
        if (typeof spec !== 'string' || spec === '')
            return [];
        void (async () => {
            await plugins.setEnabled(spec, enabled);
            await reload();
            await refresh(true).catch(() => { });
        })()
            .catch((e) => {
            console.error('[magpie-hub] 切换插件失败：' + (e instanceof Error ? e.message : String(e)));
        })
            .finally(() => { notify(); });
        return [{
                type: 'toast',
                text: enabled ? '已启用，正在重扫插件…' : '已停用，正在重扫插件…',
            }];
    }
    /** 从清单里移除插件（不删磁盘目录，装回来即可）。 */
    function startRemovePlugin(spec, locale) {
        if (typeof spec !== 'string' || spec === '')
            return [];
        void (async () => {
            await plugins.remove(spec);
            await reload();
            await refresh(true).catch(() => { });
        })()
            .catch((e) => {
            console.error('[magpie-hub] 移除插件失败：' + (e instanceof Error ? e.message : String(e)));
        })
            .finally(() => {
            focusedPlugin = null;
            notify();
        });
        return [{ type: 'toast', text: text(locale, '已移除，正在重扫插件…', 'Removed; rescanning plugins…') }];
    }
    /** 插件页「更新全部」：把检查出来的包逐个覆盖安装，装完重扫。 */
    function startUpdateAll(locale) {
        const list = Array.isArray(updateStatus?.updatable) ? [...updateStatus.updatable] : [];
        if (list.length === 0) {
            return [{ type: 'toast', text: text(locale, '没有需要更新的插件', 'Everything is up to date') }];
        }
        installStatus = { state: 'running', spec: `${list.length}`, at: Date.now() };
        notify();
        void (async () => {
            let done = 0;
            const errors = [];
            for (const pkg of list) {
                const result = await installOne(pkg, locale);
                if (result.ok === true)
                    done += 1;
                else
                    errors.push(`${pkg}: ${result.error ?? ''}`);
            }
            await reload();
            await refresh(true).catch(() => { });
            installStatus = {
                state: errors.length === 0 ? 'ok' : 'failed',
                spec: `${list.length}`,
                name: text(locale, `${done} 个插件`, `${done} plugin(s)`),
                ...(errors.length === 0 ? {} : { error: errors[0] }),
                at: Date.now(),
            };
            updateStatus = errors.length === 0
                ? { state: 'ok', updatable: [], to: {}, at: Date.now() }
                : { state: 'failed', updatable: [], to: {}, error: errors[0], at: Date.now() };
        })()
            .catch((e) => {
            installStatus = {
                state: 'failed',
                spec: `${list.length}`,
                error: e instanceof Error ? e.message : String(e),
                at: Date.now(),
            };
        })
            .finally(() => { notify(); });
        return [{
                type: 'toast',
                text: text(locale, `正在更新 ${list.length} 个插件…`, `Updating ${list.length} plugin(s)…`),
            }];
    }
    const providerName = (id) => {
        const cfg = host.providerConfig(id);
        return typeof cfg?.name === 'string' && cfg.name !== '' ? cfg.name : id;
    };
    /**
     * 商店条目（手机端「订阅」区块）：市场里的**全部 provider 类插件**。
     *
     * magpie 商店的「订阅」区块 = provider 类插件（`kind` 缺省就是 provider，
     * `middleware`/`agent`/`tools`/`page` 是别的类别——见 `market.go:58` 的
     * `Kind` 字段注释与 magpie 商店实测截图）。所以这里不再只列「已装 ∩ 清单」，
     * 而是把 provider 类**全列**，装了的标 `installed`，没装的给安装按钮。
     *
     * 判据「已装」用**目录存在**而不是 plugins.json：手动拖进 plugins/node_modules
     * 的包也算装了。清单拉不到（离线）时退回已装列表——订阅区块至少还能看到
     * 自己装过的。
     */
    /**
     * 读磁盘上这个包的真实版本（`plugins/node_modules/<pkg>/package.json`）。
     *
     * 「有没有新版」只能拿它跟 registry 比。读不到（不是 npm 包、或目录里没有
     * package.json）就返回 undefined —— 面板会省略版本号，而不是显示一个假版本。
     */
    /** 非空普通对象（`{}` 与数组都不算）。 */
    function isFilledObject(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
    }
    /**
     * 插件声明的运行选项示例：`package.json` 的 `magpie.options`。
     *
     * 与 magpie 的 `plugin.OptionsExample` 同一份数据（`internal/plugin/middleware.go:61`
     * 读的就是这个键）。没声明、读不到、不是对象一律返回 undefined。
     */
    async function pluginOptionsExample(p, pkg) {
        if (typeof pkg !== 'string' || pkg === '' || pkg.startsWith('.') || (pkg.includes('/') && !pkg.startsWith('@')))
            return undefined;
        try {
            const text = await readFile(join(p.modules, pkg, 'package.json'), 'utf8');
            const options = JSON.parse(text)?.magpie?.options;
            return isFilledObject(options) ? options : undefined;
        }
        catch {
            return undefined;
        }
    }
    async function pluginVersion(p, pkg) {
        if (typeof pkg !== 'string' || pkg === '' || pkg.startsWith('.') || pkg.includes('/') && !pkg.startsWith('@'))
            return undefined;
        try {
            const text = await readFile(join(p.modules, pkg, 'package.json'), 'utf8');
            const version = JSON.parse(text)?.version;
            return typeof version === 'string' && version !== '' ? version : undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * 插件页的清单：**一个包一行**。
     *
     * `host.loaded` 是「插件导出的函数」粒度 —— 一个包可能导出多个插件
     * （`magpie-providers-hub` 这类聚合包就是），按它直接列会得到 21 行，
     * 而用户装的是 11 个包。所以这里按 `packageName` 合并 provider 列表。
     */
    async function pluginPageEntries() {
        const byPkg = new Map();
        for (const p of host.loaded) {
            const pkg = p.packageName ?? p.spec;
            const entry = byPkg.get(pkg) ?? { spec: p.spec, packageName: pkg, providers: [] };
            for (const id of p.providers) {
                if (!entry.providers.includes(id))
                    entry.providers.push(id);
            }
            byPkg.set(pkg, entry);
        }
        const updatable = new Set(Array.isArray(updateStatus?.updatable) ? updateStatus.updatable : []);
        // 已保存的运行选项与「开关」状态都来自 plugins.json：与 magpie 桌面端
        // 同一份判据（`off: true` 表示关掉），面板要显示它才能对齐。
        let stored = [];
        try {
            stored = await plugins.list();
        }
        catch { /* 读不到就当没配置，不影响列表 */ }
        const storedOf = new Map();
        for (const item of stored) {
            if (typeof item?.spec === 'string')
                storedOf.set(moduleNameOf(item.spec), item);
        }
        // 停用的插件**不会被装载**（`runtime.js:333` `if (item.enabled === false) continue;`），
        // 所以 host.loaded 里没有它。只按 host.loaded 列会让停用的插件直接从
        // 「已安装」里消失 —— 用户再也没法在手机上把它启用回来。补一条占位。
        for (const item of stored) {
            const pkg = moduleNameOf(item.spec);
            if (byPkg.has(pkg) || pkg === '')
                continue;
            byPkg.set(pkg, { spec: item.spec, packageName: pkg, providers: [], off: true });
        }
        const entries = [];
        for (const entry of byPkg.values()) {
            const names = entry.providers.map(id => providerName(id)).filter((n) => typeof n === 'string' && n !== '');
            const record = storedOf.get(entry.packageName) ?? storedOf.get(entry.spec);
            const saved = record?.options;
            // 桌面端「Options」在没有保存过时会把包里的示例填进编辑框，
            // 判据是 package.json 的 `magpie.options`（magpie 的
            // `plugin.OptionsExample`）。手机端照同一份数据给初值。
            const example = await pluginOptionsExample(paths, entry.packageName);
            entries.push({
                spec: record?.spec ?? entry.spec,
                packageName: entry.packageName,
                // 标题优先用包名（用户装的就是它）；平台名放副标题。
                name: entry.packageName,
                ...(names.length === 0 ? {} : { providerNames: names }),
                version: await pluginVersion(paths, entry.packageName),
                providers: entry.providers,
                // 关掉的插件：`runtime.js` 照样能装（本宿主没有「跳过 off」的语义），
                // 但面板要如实显示，用户才能知道它为什么没在列表里出现账号。
                ...(entry.off === true || record?.enabled === false || record?.off === true ? { off: true } : {}),
                ...(isFilledObject(saved) ? { options: saved } : {}),
                ...(isFilledObject(example) ? { optionsExample: example } : {}),
                ...(updatable.has(entry.packageName) ? { updateTo: updateStatus?.to?.[entry.packageName] ?? true } : {}),
            });
        }
        return entries;
    }
    /** 包 `package.json` 的 `magpie.options`：magpie 桌面端拿它当「建议值」。 */
    async function pluginOptionsExample(p, pkg) {
        try {
            const text = await readFile(join(p.modules, pkg, 'package.json'), 'utf8');
            const parsed = JSON.parse(text);
            const example = parsed?.magpie?.options;
            return isFilledObject(example) ? example : undefined;
        }
        catch {
            return undefined;
        }
    }
    async function installedStoreEntries(h, m) {
        let listings;
        try {
            listings = await m.listings(false);
        }
        catch {
            listings = [];
        }
        // provider 类 = kind 缺省（middleware/agent/tools/page 都是别的类别）
        const subs = listings.filter((l) => l.kind === undefined);
        const out = [];
        for (const l of subs) {
            let installed = false;
            try {
                installed = (await stat(join(paths.modules, l.package))).isDirectory();
            }
            catch { /* 没装 */ }
            out.push({
                package: l.package,
                name: l.name,
                ...(l.providers === undefined ? {} : { providers: l.providers }),
                ...(typeof l.summary?.zh === 'string' ? { summary: l.summary.zh } : {}),
                installed,
            });
        }
        // 离线兜底：清单为空但本机装过 → 至少把装过的列出来
        if (out.length === 0) {
            for (const spec of await plugins.list()) {
                const dir = join(paths.modules, moduleNameOf(spec.spec));
                try {
                    const info = await stat(dir);
                    if (!info.isDirectory())
                        continue;
                    out.push({ package: spec.spec, name: spec.spec, installed: true });
                }
                catch { /* 没装 */ }
                if (out.length >= 16)
                    break;
            }
        }
        return out;
    }    /** 没有快照时的空面（面板先画骨架，数据随后到）。 */
    function emptySnapshot() {
        return {
            providers: [],
            usage: [],
            stats: {
                period: 'all', tokens: 0, inputTokens: 0, outputTokens: 0,
                cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, errors: 0, retried: 0,
                series: [], byProvider: [],
            },
            routing: [],
            store: [],
        };
    }
    /** 事件流：登录/额度变化都重推面板。 */
    host.onEvent(() => {
        void refresh().catch(() => { });
    });
    // ── 预热 ────────────────────────────────────────────────────────────────
    //
    // ⚠ `view` 只读内存里的 `latest`，它初始是空快照；而 `refresh()` 原本只在
    // 「手机面板被打开」（data 回调）时触发一次。于是**先取 view 的人拿到空态**
    // ——实测症状：手机上第一次打开面板显示「还没有安装 magpie 插件」，下拉刷新
    // 一次才有内容。
    //
    // 装载完就先读一遍：面板打开时数据已经在了。失败只记一条 warn，不影响插件。
    void refresh().catch((e) => {
        ctx.logger?.warn?.(`[magpie-hub] 首次读取面板数据失败：${e instanceof Error ? e.message : String(e)}`);
    });
}
/**
 * magpie 的数据根目录。
 *
 * 这个插件要**取代 magpie 桌面程序**，所以默认就该读写 magpie 自己的数据目录：
 * 用户装过的供应商插件（`plugins.json`）和已登录的账号（`plugin-auth.json`）
 * 立刻可用，不需要在 DSH 里重装一遍、重登一次。
 *
 * 查找顺序（**目录里真有 magpie 的文件才算命中**，否则会误判成空目录）：
 * 1. `MAGPIE_HUB_ROOT`（显式覆盖，测试与自定义部署用）
 * 2. `$XDG_CONFIG_HOME/magpie`
 * 3. `<USERPROFILE|HOME>/.config/magpie`（Windows / Linux 的实际位置）
 * 4. `<DSH_HOME>/magpie`
 * 5. `<DSH_HOME>`（历史布局：magpie 的文件直接落在 DSH_HOME 下）
 * 6. `<HOME>/.dsh/magpie`、`<HOME>/.dsh`
 *
 * 全都没有时建在 `<DSH_HOME>/magpie`：干净机器上装了这个插件也能直接用。
 */
function configRoot() {
    const home = process.env.DSH_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
    const user = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const xdg = process.env.XDG_CONFIG_HOME;
    const candidates = [
        process.env.MAGPIE_HUB_ROOT,
        xdg === undefined || xdg === '' ? undefined : join(xdg, 'magpie'),
        user === '' ? undefined : join(user, '.config', 'magpie'),
        join(home, 'magpie'),
        home,
        user === '' ? undefined : join(user, '.dsh', 'magpie'),
        user === '' ? undefined : join(user, '.dsh'),
    ];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === '')
            continue;
        if (hasMagpieFiles(candidate))
            return candidate;
    }
    return join(home, 'magpie');
}
/** 这个目录里有没有 magpie 自己的文件（有才算「这就是数据根」）。 */
function hasMagpieFiles(dir) {
    for (const name of ['plugins.json', 'plugin-providers.json', 'plugin-auth.json']) {
        try {
            if (existsSync(join(dir, name)))
                return true;
        }
        catch {
            // 权限/路径异常：当作没有，继续找下一个候选。
        }
    }
    return false;
}
/**
 * 这个错误是不是「同一个 provider 已经注册过了」。
 *
 * 与 jet-hub 的 `isDuplicateRegistrationError` 同一判据：`code` 命中
 * `DUPLICATE_DIRECTORY`，或 message 里有 `already declared` / `already registered` /
 * `is already a adapter`。**只有这一种**当成正常竞态吞掉，别的错误照常抛。
 */
function isDuplicateRegistration(e) {
    if (typeof e !== 'object' || e === null)
        return false;
    const code = e.code;
    if (code === 'DUPLICATE_DIRECTORY')
        return true;
    const message = e.message;
    if (typeof message !== 'string')
        return false;
    return /already declared|already registered|is already (?:a|an) adapter/.test(message);
}
/** 从动作事件里取 provider（面板的按钮静态带 `args.provider`）。 */
function providerArg(event) {
    const value = event?.value;
    const provider = value?.provider;
    return typeof provider === 'string' ? provider : '';
}
/** 手机端密钥表单的绑定前缀（`data.login.<provider>.key`）。 */
const LOGIN_PATH = 'data.login.';
/** 异常 → 一句可读的话（toast 要一句话，不能塞堆栈）。 */
function messageOf(e) {
    const message = e instanceof Error ? e.message : String(e);
    return message.length > 60 ? `${message.slice(0, 60)}…` : message;
}
/** 第 `index` 个登录方式的显示名（拿不到就退回编号，不编造）。 */
function methodLabel(host, provider, index) {
    const method = host.methodsOf(provider)[index];
    return method !== undefined && typeof method.label === 'string' && method.label !== ''
        ? method.label
        : `${provider} ${index + 1}`;
}
/** 中英双语（面板与 toast 共用）。 */
function text(locale, zh, en) {
    return locale === 'en' ? en : zh;
}
/** 时间窗的毫秒跨度；`all` 返回 `undefined`（不过滤）。 */
function windowMs(period, now) {
    if (period === 'all')
        return undefined;
    if (period === 'today') {
        // 「今天」按 UTC+8 的日界算（与 magpie / hub 的记账口径一致）
        const dayStart = Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
        return now - dayStart;
    }
    if (period === '7d')
        return 7 * 86_400_000;
    return 30 * 86_400_000;
}
/** 取窗口内的记录（`all` 时原样返回）。 */
function recordsSince(rows, period, now) {
    const span = windowMs(period, now);
    if (span === undefined)
        return rows;
    const from = now - span;
    return rows.filter((r) => r.at >= from);
}
/**
 * 一个时间点落在哪个桶里。
 *
 * `hourly`（今天）= `HH:00` 两位小时；否则 = `MM-DD`。用固定宽度便于面板当
 * 类目名横向排列（不用本地化格式，避免不同设备宽度不一致）。
 */
function bucketLabel(at, hourly) {
    const d = new Date(at + 8 * 3_600_000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    if (hourly)
        return `${hh}:00`;
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${mm}-${dd}`;
}
/** 从账号 key（`provider` 或 `provider#xxxxxx`）取回 provider id。 */
function providerOfKey(key) {
    const hash = key.indexOf('#');
    return hash > 0 ? key.slice(0, hash) : key;
}
/**
 * 登录态 → 面板的三种标记。
 *
 * `expired` 才会让面板画警示；`kept` 是「401 但跟登录无关」，对外等同于正常。
 */
/** 续期提前量：距过期不足这么多就算「快过期」，界面照样按有效显示。 */
const SIGNIN_GRACE_MS = 60_000;
/**
 * 账号的登录状态。
 *
 * 来源有两条，**先看宿主写的标记，再看凭据自带的 `expires`**：
 * 1. `stored.signIn` —— 续期流程写的（`renewed` / `expired`）。
 * 2. `stored.expires` —— magpie 所有插件都会写这个毫秒时间戳。
 *
 * 之前只看第 1 条，而插件装载时并不会写它（那是续期时才写的），
 * 于是**所有账号都显示「登录态未知」**，连刚登录完的也一样 ——
 * 真机截图里 WPS 明明没过期（expires 是 2027 年）却写着未知。
 */
function signInOf(stored, now = Date.now()) {
    if (stored === undefined)
        return undefined;
    const mark = stored.signIn;
    if (mark === 'expired' || mark === 'renewed')
        return mark;
    const expires = stored.expires;
    if (typeof expires === 'number' && Number.isFinite(expires)) {
        if (expires + SIGNIN_GRACE_MS < now)
            return 'expired';
        return 'kept';
    }
    return undefined;
}
/** 把当前快照压成一段可复制的纯文本（面板的「复制概览」）。 */
function summaryText(snapshot, locale) {
    const lines = [];
    lines.push(text(locale, 'Magpie 插件概览', 'Magpie plugins'));
    lines.push('');
    lines.push(`${text(locale, '平台', 'Providers')}: ${snapshot.providers.length}`);
    for (const p of snapshot.providers) {
        const accounts = p.accounts.length;
        lines.push(`- ${p.name} (${p.id}): ${accounts} ${text(locale, '个账号', accounts === 1 ? 'account' : 'accounts')} · ${p.models} ${text(locale, '个模型', 'models')}`);
        if (p.error !== undefined)
            lines.push(`  ! ${p.error}`);
    }
    lines.push('');
    lines.push(`${text(locale, '用量', 'Usage')} (${snapshot.stats.period}): ${snapshot.stats.tokens} tokens · ${snapshot.stats.calls} ${text(locale, '次请求', 'calls')} · ${snapshot.stats.errors} ${text(locale, '次失败', 'failed')}`);
    return lines.join('\n');
}
/** 额度的一句话摘要（面板与 toast 共用）。 */
function summarizeUsage(usage, locale) {
    const parts = [];
    if (typeof usage.plan === 'string' && usage.plan !== '')
        parts.push(usage.plan);
    for (const w of usage.windows ?? []) {
        const used = typeof w.used === 'number' ? `${Math.round(w.used)}%` : '—';
        parts.push(`${w.name ?? 'window'} ${used}`);
    }
    if (parts.length === 0)
        parts.push(text(locale, '没有额度信息', 'No allowance reported'));
    return parts.join(' · ').slice(0, 120);
}
//# sourceMappingURL=index.js.map