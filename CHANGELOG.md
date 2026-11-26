# 更新内容

本文件记录每个版本的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.5 — 2026-11-26

手机端照搬了 [Hipple/dsh-go-magpie] 的四个手法，桌面端一行没动（网页端 UI 本来就是 magpie 原版）。

### 页签换成 App 原生 `tabs`

- 之前是自绘 `chips` 换行：每切一次页都要 `refresh` 重建整个视图，一次往返。
- 现在用视图的 `tabs` 节点，当前页是**客户端状态**，切页不发请求。五个页签会超过
  `DshUiTabBar` 的 `fit(columns: 4)` 上限、折成 4+1 行且「设置」没有下划线指示器，
  所以**额度并进平台页**（卡片尾部本来就写着「剩 N」，点进详情有完整窗口），
  页签固定四个：平台 / 用量 / 插件 / 设置。
- 旧版 App 不认 `tabs` 时退回 chips（只渲染当前页），两条路径都返回数组。

### 开关用原生 `toggle`、多选项用原生 `select`

- 设置页的三个布尔项（自动签到、额度条、消耗脚注）从「两个 chips」换成真开关；
  两个多选项（脚注写什么、模型列表排法）从 chips 换成下拉。
- **`toggle` 的 `value` 必须是布尔**（App 侧 `current is! bool` 直接判 broken），
  所以数据绑定根也跟着换：有 `toggle` 能力时给 `true/false`，退回 chips 时给 `'on'/'off'`。
  两侧用同一个 `hasNode` 判断，任何一边单独变都会让开关立刻坏掉。

### 按设备能力渐进增强

- 读 `caps.components`（App 上报它认识哪些节点）决定用哪个控件。
- **空数组按「没有信息」处理、一律乐观返回 true**：旧 App 不上报这个字段，
  不代表什么都不支持；面板本来就依赖 v2 节点，真不支持的话整页早就 broken 了。

### 根节点加 `accent` 与 `style.gap`

- `accent: 'app'` 跟随用户的主题色（原来写死默认蓝，跟 App 其他界面没区别）。
- `style: { gap: 'M' }`（12dp）。

### 顺手修掉两个真 bug

- `usageTab` 在 `stats` 缺失时抛 `TypeError`。之前只渲染当前页，永远走不到；改成五页
  同时渲染后，任何一页的空数据都会把整个面板带崩。现在容忍空快照。
- `boolSwitch` 的 chips 分支少写了一层括号，只在「设备明确不支持 toggle」时才暴露。

## 0.2.4 — 2026-11-26

补上 `engines.dsh` 声明。

- 之前只有 `engines.node`，插件市场读不到「这个包需要哪个版本的 DSH」，索引里 `engines` 是空的，客户端也就没法按版本判断能不能装。
- 现在声明 `>=0.2.1-rc.5 <0.3.0-0`：与 `peerDependencies` 里 `@deepseek-ai/dsh-llm` 的范围一致，也是实测过的区间。
- 无代码改动。
## 0.2.3 — 2026-11-25

补上桌面端仍然缺失的 15 个端点，这些端点全部是把上游 magpie 已有的页面接到我们的数据上。

### 每日签到（新增，此前只在手机端有一半）

- `/api/settings` 带上 `checkinPlugins` / `checkinAccounts` / `checkinAt`，设置页的签到段终于画得出来。
- 新端点 `settings/plugin-checkin`（按插件开关）与 `settings/checkin-account`（按账号开关）。
- 新端点 `usage/checkin-account`（立刻签一次）与 `usage/checkins/off`（今天还没签的账号）。
- 签到结果落盘到 `checkins.json`，插件重启后额度卡仍显示「今天已签」。
- 被单独关掉的账号不会在自动签到里被签回来。

### 用量页

- `usage/requests`：请求流水（分页、按供应商/账号/模型/失败筛选、时间桶序列）。
- `usage/heatmap`：最近 90 天的每日用量。
- `usage/arrange`：额度卡与请求表的排布、隐藏、客户端归并偏好。
- `usage/quotas` 从空数组改成真实额度卡；`usage/quotas/refresh` 重新读某个平台。
- `usage/quotas/history/holds` 与 `usage/codex-reset` 给出明确答复，不再 501。
- `tune` 与 `context` 回空列表（页面显示「调用太少」而不是挂红条）。
- 请求表的表头合计补上输入/输出/缓存读写四列，不再显示 NaN。

### 平台编辑

- `provider/keylisted`、`provider/arrange`、`provider/move`、`provider/unfetch`、`provider/test`、`provider/teststop`、`provider/detect`。
- `provider/test` 是真发一次最小请求：能测出这个平台现在到底通不通。
## 0.2.2 — 2026-11-25

只改包元数据，没有功能变化：修正一句描述，避免第三方目录把本插件误判成「只给网页版用」。

### 修复

- **描述里的「桌面」被当成客户端特征**
  包描述原文是「…，桌面与手机共用一套面板」。某些第三方插件目录（如 dshfind）用关键词给插件自动分类，其 `client` 分类的触发词包含「桌面 / desktop / electron / 移动端」等；命中后被归为「客户端」，而 DSH Go 的手机端市场把 `client` 类目判定为「仅支持网页版」并默认隐藏，于是本插件在手机市场里被标成「仅支持网页版」。

  描述改为「…，双端共用一套面板」，不再触发该关键词。功能、代码、依赖均未变动。

## 0.2.1 — 2026-11-16

修掉两个会让插件生态「静默失效」的缺陷：桌面端装不上插件，以及面板里任何一次写操作都会把插件清单写成 magpie 读不出来的形状。

### 修复

- **`plugins.json` 被写成裸数组**（严重）
  `PluginStore` 的四个写方法（`add` / `remove` / `setEnabled` / `setOptions`）各自把插件列表直接序列化成**裸数组** `[{...}]`，而读取侧的 `list()` 同时兼容裸数组与 `{ plugins: [...] }` 两种形状 —— 于是「读得出来、写坏了」：只要在面板里做过一次写操作（装插件、启停、改运行选项），magpie 桌面程序与手机原生面板就会认为**一个插件都没装**，而本插件自己因为兼容读取毫无察觉。

  现在全文件只剩一个写入口 `writePlugins(list)`，永远写 `{ "plugins": [...] }`；历史遗留的裸数组在下次写入时自动修正为正确形状，插件条目不丢。

- **桌面端「安装插件」全部返回 501**（严重）
  `ui/plugins.js` 通过 `api("plugins/" + op)` 调用 11 个端点，而 `src/ui-api.js` 的 `makeUiHandlers` 只实现了 5 个，其余全部落到 `src/ui.js` 的兜底分支返回 `501 {"error":"not-implemented"}`，前端只能显示一句失败。

  已补齐 9 个端点：

  | 端点 | 作用 |
  |---|---|
  | `plugins/listings` | 插件商店清单（原先写死返回空数组，商店一张卡片都没有） |
  | `plugins/add` | 安装（npm 包名 / `owner/repo` / GitHub 链接 / 本地路径） |
  | `plugins/upgrade` | 覆盖重装（强制，跳过幂等短路） |
  | `plugins/off` | 启用 / 停用 |
  | `plugins/options` | 保存运行选项（校验必须是 JSON 对象） |
  | `plugins/remove` | 卸载（同时清模块目录） |
  | `plugins/update` | 批量更新到最新版 |
  | `plugins/check` | 检查更新 |
  | `plugins/npm` | 查 npm 上的版本与周下载量 |
  | `plugins/git` | 查 GitHub 仓库分支头 |

- **`makeUiHandlers` 依赖注入缺三个键**
  `ui-api.js` 用到 `deps.moduleNameOf` / `deps.installOne` / `deps.pluginVersion`，而 `src/index.js` 一个都没传 —— `moduleNameOf` 缺失被 `catch` 吞掉后包名退化成完整路径，另外两个直接让相关端点不可用。

- **`installOne` 无法强制重装**
  新增第三个参数 `force`，透传给 `market.install(pkg, signal, { force })`。否则「更新」和「覆盖重装」会被幂等判断短路，永远装不到新版本。

### 新增

- `test/store.test.js` —— 7 条用例，专门断言**磁盘上的形状**而不只是 `list()` 读回的值：
  - 每次写操作后顶层必须是对象，`plugins` 必须是数组
  - 重复 spec 是更新而非追加
  - `setOptions(null)` 会删掉 `options` 键
  - 历史遗留的裸数组能读出来，且写回时自动修正
  - 没有 `spec` 的条目被过滤
  - 文件不存在时 `list()` 返回空数组

### 说明

- 全量测试从 77 条增至 **84 条**，全部通过。
- 已在 4 GB 内存的 Android 模拟器上真机验证：面板插件页正常列出「已安装的插件（12）」、检查更新 / 更新全部两个按钮、插件卡片列表；在配置页点「启用插件」后 `plugins.json` 从裸数组变为 `{ "plugins": [...] }`，**条数保持 11 条不丢**。

## 0.2.0 — 2026-11-12

首个打包发布的版本。

### 新增

- 在 DSH 进程内直接运行 magpie 供应商插件：继承 `~/.config/magpie` 里已装的插件与已登录的账号，不重装、不重登。
- 每个 provider 注册成 DSH 的一条模型路由，支持三套 SDK 协议：OpenAI 兼容 / Anthropic / Gemini。
- 双端面板：桌面（DSH Web UI，magpie 原版界面）+ 手机（dsh-Go 原生插件面板）。
- 手机原生面板：平台卡片列表与详情页、额度窗口进度条、用量统计、插件配置（运行选项 / 启停 / 移除）、插件商店（检查更新 / 一键更新 / 手输包名安装）、设置（仓库密钥、显示偏好、模型浏览）。
- 输入框上方的额度胶囊（`composer.strip`）与每回合下方的消耗脚注（`turn.note`），两者都可在设置页关闭。
- 模型列表支持按供应商分组或平铺两种排法。

### 修复

- 适配器拿不到 provider 导致请求直连、返回 401：`providers` 数组在构造时为空且从未被 `reload()` 更新；新增 `providerOf(prefix, modelId)` 反查平台，并在每次 reload 后刷新依赖。
- 模型目录预热的 `at: 0` 让缓存永远判定过期、反复排队；改为真实时间戳，并把预热改为全局串行队列（手机端 `UV_THREADPOOL_SIZE=2`，并发会占满请求池）。
- 端点重复注册（`DUPLICATE_ADAPTER`）时整批 provider 全废：改为先整批试，失败后逐个注册，被其它插件占用的跳过并记日志。
- 错误文案不再直接暴露 `DPAPI` 等术语，改为「这个账号的登录是在 Windows 电脑上保存的，手机上打不开」这类可操作提示。
- 模型页返回行被标题栏压住点不到：children 首位补一个空格占位。

### 许可

- 从 MIT 切换到 **AGPL-3.0-only**。
