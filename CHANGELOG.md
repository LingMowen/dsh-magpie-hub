# 更新内容

本文件记录每个版本的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.2 — 2026-11-17

修复签到按钮与重新扫描按钮缺失、启动竞态快照空态与签到后端端点未实现问题。

### 修复

- **DSH 桌面端 Agent 卡片与面板按钮补齐**
  - 在 DSH 桌面端 MagpiePage 的空态提示页与导航栏右侧补充「重新扫描」按钮，避免因异步装配竞态卡在空提示。
  - 在具备签到能力的供应商（`hasCheckin`）卡片标题栏将原先纯展示的静态「可签到」标签升级为可点击的「立即签到」交互按钮，支持防重、执行态与即时结果反馈展示。
- **Web 控制台签到区域与按钮缺失修复**
  - `/api/state` 补全 `checkinPlugins` 与 `checkinAccounts` 字段，驱动 Web 界面正确渲染设置页签到配置区域与「Check in now」按钮。
- **Web 端签到与额度端点补齐**
  - 补齐 `usage/checkin-account` 实现单账号即时签到调度并返回标准结果结构。
  - 补齐 `settings/plugin-checkin` 与 `settings/checkin-account` 接收并持久化自动签到开关。
  - 补齐 `login/usage` 支持账号级签到就绪与额度探测。
- **后端签到调度与快照竞态修复**
  - 修复 `checkin` RPC 与移动端动作在未指定供应商时将平台 ID 误当作 Key 遍历的问题，改为先取登录平台再遍历各平台有效账号 Key。
  - 在 `panel.snapshot` 中增加对装载 Promise 的等待与按需刷新机制，杜绝未装配完成即返回空快照。

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
