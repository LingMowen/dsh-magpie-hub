# dsh-magpie-hub

在 **DeepSeek Harness（DSH）进程内**直接运行 magpie 的供应商插件：登录、列模型、转发请求、看额度、签到、装插件。桌面与手机共用同一份数据。

**不需要安装 magpie 桌面程序**——本插件读写的正是 magpie 自己的数据目录（`~/.config/magpie`），所以装过的插件、登录过的账号直接继承。

| | |
|---|---|
| 版本 | 0.2.0 |
| 运行环境 | Node `^22.19.0 \|\| >=24.0.0` |
| 形态 | 纯 ESM，无可编译步骤 |
| 许可 | MIT |

---

## 它做什么

magpie 的价值在**插件生态**（WPS 灵犀、腾讯 Marvis、CodeArts、商汤小浣熊、GitHub Copilot……）。那些插件是普通 ESM 模块，导出一个函数、返回一组钩子——本插件在 DSH 里实现这些钩子的宿主，于是**为 magpie 写的插件不改一行就能在 DSH 里用**。

| 能力 | 说明 |
|---|---|
| 继承既有数据 | 读 `plugins.json` / `plugin-auth.json` / `plugin-provider*.json`，不用重装重登 |
| 模型进 DSH | 每个 provider 注册成 DSH 的一条模型路由 |
| 双端面板 | 桌面（DSH Web UI，magpie 原版界面）+ 手机（dsh-Go 原生插件面板） |
| 请求转发 | 三套 SDK 协议：OpenAI 兼容 / Anthropic / Gemini |
| 额度与用量 | 按平台与账号聚合，支持窗口剩余、到期时间、请求流水 |
| 登录 | 手机端也能登录：OAuth 给链接、API Key 给表单 |
| 插件管理 | 已装插件配置（运行选项/启停/移除）、检查更新、商店安装 |

---

## 安装

### 作为 DSH 插件

```sh
# 在 profile 目录里安装（desktop / web 各自一份）
cd ~/.dsh/profiles/web
npm i /path/to/dsh-magpie-hub-0.2.0.tgz
```

然后在 profile 的 `package.json` 里把本包加进 bundle 列表：

```json
{
  "dependencies": { "dsh-magpie-hub": "0.2.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-magpie-hub"] } }
}
```

重启 DSH 后：

- **桌面端**：左侧栏出现「插件」页，`/magpie-hub/` 托管 magpie 原版 Web UI；
- **手机端**：全部功能 → 插件 → **Magpie** 卡片打开原生面板。

### 数据从哪来

本插件不自己造数据，读的是 magpie 的目录。按顺序找，**目录里真有 magpie 文件才算命中**：

1. `MAGPIE_HUB_ROOT`
2. `$XDG_CONFIG_HOME/magpie`
3. `<USERPROFILE|HOME>/.config/magpie`
4. `<DSH_HOME>/magpie`
5. `<DSH_HOME>`
6. `<HOME>/.dsh/magpie`、`<HOME>/.dsh`

全都没有时建在 `<DSH_HOME>/magpie`。插件装在 `<数据根>/plugins/node_modules/`。

| 文件 | 用途 |
|---|---|
| `plugins.json` | 已装插件 spec 列表 |
| `plugin-providers.json` | 供应商与登录方式 |
| `plugin-auth.json` | 登录态 |
| `usage.jsonl` | 请求记录（算用量） |
| `hub-settings.json` | 本插件自己的设置（显示偏好、仓库密钥） |

---

## 手机端面板

五个自绘页签（不用 App 的页签控件——它会按宽度折行）：

| 页签 | 内容 |
|---|---|
| **平台** | 每个平台一张卡片（账号数、模型数、登录态、剩余额度），点开进详情；顶部搜索框 |
| **额度** | 按账号列额度窗口（剩余条 + 到期时间），拿不到的显示原因而不是原始报错 |
| **用量** | Token / 请求数 / 费用 / 缓存命中率 + 按平台明细 + 请求流水 |
| **插件** | 已装插件（点进配置页）、检查更新、可安装列表（商店）、手输包名安装 |
| **设置** | 显示偏好、模型列表排法、仓库密钥、这次扫描的结果（排障用） |

面板还占用了两个原生位置：

- **输入框上方的状态条**：`灵犀 · 剩 2,299`（当前平台 + 剩余额度），可在设置里关掉；
- **每回合的脚注**：`12K`（这一回合消耗的 token 或额度），可在设置里关掉或切换内容。

> 脚注必须短（App 的降级链是「放不下就整条丢弃」，不会缩略），所以只写纯 ASCII 的数量。

---

## 桌面端

`/magpie-hub/` 托管 **magpie 原版 Web UI**（`ui/` 目录，来自上游），配合 `src/ui-api.js` 的后端适配层工作。页面结构、配色、i18n 全部是上游原样，本仓库只补后端接口。

---

## 结构

```
magpie-hub/
├── package.json         两份清单：dsh.bundle（桌面）+ dshGo（手机）
├── cordis.patch.yml     把本包挂进 DSH
├── src/                 纯 ESM JavaScript，无编译步骤（9604 行 / 17 个模块）
│   ├── index.js         (2180) 入口：装载 → 注册路由 → 面板 → 状态条/脚注
│   ├── panel.js         (2005) 手机端视图 + 数据（纯函数，可独立测）
│   ├── protocols.js     (1308) 三套 SDK 协议：OpenAI 兼容 / Anthropic / Gemini
│   ├── market.js         (603) 插件市场：清单 + tarball 安装（npm / GitHub）
│   ├── rpc.js            (602) 桌面端管理 API
│   ├── host.js           (496) 钩子编排（登录/续期/loader/models/usage/checkin）
│   ├── ui-api.js         (487) magpie Web UI 的后端接口适配
│   ├── adapter.js        (397) DSH LlmAdapter：stream / listModels
│   ├── runtime.js        (340) 插件加载（入口解析、函数身份去重）
│   ├── store.js          (266) 数据文件读写（原子写、登录记录）
│   ├── state.js          (256) 面板策略：模型开关、平台启停、隐藏账号、路由
│   ├── ui.js             (247) 托管 magpie Web UI
│   ├── surfaces.js       (146) 状态条与脚注的文案（纯函数）
│   ├── hotreload.js      (146) 插件目录热重载
│   ├── deadline.js        (50) 给可选数据加硬性超时上限
│   ├── types.js           (42) M1-M20 钩子契约的类型面
│   └── scope.js           (33) 账号作用域
├── client/              桌面客户端 UI（esbuild 产物）
├── ui/                  magpie 原版 Web UI（上游拷贝，见 THIRD-PARTY.md）
└── test/                单测（node --test）+ 真实数据验证脚本
```

**为什么是纯 ESM**：上一版只有编译后的 `lib/*.js`，源码丢失后无法维护。现在 `package.json` 的 `main` 直接指 `src/index.js`，没有编译中间层。

---

## 模型注册

```js
ctx.llm.registerAdapter(providers, adapter)   // 一次把全部 provider 交给一个适配器
```

- 每个 provider 各自成为模型选择器里的一条路由；
- 名字来自插件的 `config().name`（如「WPS 灵犀 Lingxi」）；
- **整批注册被别的插件占用时会退化成逐个注册**：`registerAdapter` 是整批语义，列表里只要有一个 provider 已被占用（例如 `dsh-providers-hub` 的 `raccoon`），整批都会失败，而错误又被当成正常竞态吞掉。本插件捕获这种错误后逐个注册，被占用的跳过、其余接上。
- **适配器自己解析平台**：DSH 传给 `stream()` 的模型 id 是裸名（`deepseek-v4.1-flash`，不带平台前缀），所以适配器要反查「哪个平台声明了这个模型」，否则会拿到空 loader、请求退化成不带凭据的直连。

---

## 自检

```sh
# 语法
for f in src/*.js; do node --check "$f"; done

# 单元测试
node --test test/*.test.js

# 真实数据装载（不需要 DSH 运行时）
node test/real-data.mjs
```

---

## 已知边界

- **git spec 不会自动安装**（`https://github.com/xxx/yyy` 这类写进 `plugins.json` 的）：magpie 用 bun 装，本插件不代劳，面板会提示「没有找到插件目录」。
- **面板里的 `hub-*` / `jet-hub-*` provider** 来自 `magpie-providers-hub` 插件本身（magpie 版的 jet Hub），不是本仓库重复实现。
- **签到**依赖插件声明的 `auth.checkin`；没声明就没有签到入口。
- **Windows DPAPI 凭据不能跨系统**：桌面 magpie 用 Windows DPAPI 加密部分凭据，拷到安卓/Linux 解不开。这种情况面板会给出「请在手机上重新登录一次」，而不是抛原始报错。
- **手机端回合号是近似值**：App 不向插件暴露「第几回合」，本插件按会话内的调用次数累加，多对话并行时会串号。

---

## 授权与来源

本仓库使用 MIT 许可。它**建立在别人的工作之上**，完整清单见 [THIRD-PARTY.md](THIRD-PARTY.md)：

- **magpie**（[yetone/magpie](https://github.com/yetone/magpie)，MIT）—— 插件协议、数据格式、`ui/` 下的 Web UI 均来自上游；
- **DeepSeek Harness**（`@deepseek-ai/*`）—— 宿主运行时与扩展点；
- **dsh-Go** —— 手机端原生插件协议（`panels` / `composer.strip` / `turn.note`）；
- **magpie 供应商插件**（wps-lingxi、marvis、opencode-*-auth 等）—— 各自独立项目，**不在本仓库内**，由用户自行安装。

本仓库与上述项目的作者没有隶属关系，也未经他们背书。
