# dsh-magpie-hub

在 **DSH 进程内**直接跑 magpie 的供应商插件：登录、列模型、转发请求、看额度、签到、装插件。桌面与手机共用一套面板。

**不需要安装 magpie 桌面程序**——本插件读写的正是 magpie 自己的数据目录（`~/.config/magpie`），所以装过的插件、登录过的账号直接继承。

---

## 它解决什么

magpie 的价值在**插件生态**（WPS 灵犀、腾讯 Marvis、CodeArts、小浣熊、GitHub Copilot…）。那些插件是普通 ESM 模块，导出一个函数返回一组钩子——本插件在 DSH 里实现这些钩子的宿主，于是**为 magpie 写的插件不改一行就能在 DSH 里用**。

| 能力 | 说明 |
|---|---|
| 继承既有数据 | 读 `plugins.json` / `plugin-auth.json`，不用重装重登 |
| 模型进 DSH | 每个 provider 注册成 DSH 的一条模型路由（与 jet Hub 同款注册方式） |
| 双端面板 | 桌面（DSH Web UI）+ 手机（dsh-Go 原生面板） |
| 登录 | 手机端也能登录：OAuth 给链接、API Key 给表单 |

---

## 结构

```
magpie-hub/
├── package.json        两份清单：dsh.bundle.patch（桌面）+ dshGo（手机）
├── cordis.patch.yml    把本包挂进 DSH
├── src/                纯 ESM JavaScript，**无编译步骤**
│   ├── index.js        入口：装载 → 注册路由 → 面板 → 预热
│   ├── runtime.js      插件加载（入口解析、函数身份去重、热重载）
│   ├── host.js         钩子编排（登录/续期/loader/models/usage/checkin）
│   ├── adapter.js      DSH LlmAdapter：stream / listModels
│   ├── protocols.js    三套 SDK 协议（OpenAI / Anthropic / Gemini）
│   ├── store.js        数据文件读写（原子写、登录记录 settle）
│   ├── panel.js        手机端视图 JSON
│   ├── rpc.js          桌面端 RPC
│   └── ...
├── client/             桌面 UI（esbuild 产物）
└── test/               真实数据验证脚本
```

**为什么是纯 ESM**：上一版只有编译后的 `lib/*.js`，源码丢失后无法维护。现在 `package.json` 的 `main` 直接指 `src/index.js`，没有编译中间层。

---

## 数据在哪

按顺序找，**目录里真有 magpie 文件才算命中**：

1. `MAGPIE_HUB_ROOT`
2. `$XDG_CONFIG_HOME/magpie`
3. `<USERPROFILE|HOME>/.config/magpie`
4. `<DSH_HOME>/magpie`
5. `<DSH_HOME>`
6. `<HOME>/.dsh/magpie`、`<HOME>/.dsh`

全都没有时建在 `<DSH_HOME>/magpie`。

| 文件 | 用途 |
|---|---|
| `plugins.json` | 已装插件 spec 列表 |
| `plugin-providers.json` | 供应商与登录方式 |
| `plugin-auth.json` | 登录态 |
| `usage.jsonl` | 请求记录（算额度与用量） |

插件装在 `<数据根>/plugins/node_modules/`（不是 `<数据根>/node_modules/`）。

---

## 模型注册（与 jet Hub 一致）

```js
ctx.llm.registerAdapter(providers, adapter)   // 一次把全部 provider 交给一个适配器
```

- 每个 provider 各自成为模型选择器里的一条路由；
- 名字来自插件的 `config().name`（如「WPS 灵犀 Lingxi」）；
- **重复注册只吞「已注册」这一种错误**（插件 fiber 重启的正常竞态），其余照常抛。

---

## 手机端

单面板 + 内部页签（供应商 / 额度 / 用量 / 路由 / 商店）。

- 每个供应商可展开：账号列表 + 登录按钮；
- OAuth 方式返回 `{link}` 让 App 打开浏览器，回来点「我已完成」收尾（手机的本机回调端口连不上，所以不靠自动回调）；
- API Key 方式在页签层级给表单（`form` 不能嵌套）；
- 手机端**只读配置**，改设置去桌面端。

---

## 自检

```sh
# 语法
for f in src/*.js; do node --check "$f"; done

# dsh-go 检查器（DSH_DIR 指向真实运行时）
DSH_DIR="<...>/node_modules/@deepseek-ai/dsh" \
  node <dsh-go>/sdk/plugin-kit/bin/check.mjs . --load

# 真实数据装载（不需要 DSH 运行时）
node test/real-data.mjs
```

期望：检查器 `原生界面能显示（面板 1）` + `已加载宿主半侧`，**0 error**；装载脚本列出真实 provider 与其登录方式。

---

## 验证过的事实（本机实测）

| 项 | 结果 |
|---|---|
| 数据根 | `~/.config/magpie`（Windows：`%USERPROFILE%\.config\magpie`） |
| 装载插件 | 48 个成功、2 个失败（git spec 未装 / 无导出函数） |
| provider | 48 个，含 `wps-lingxi`、`sensenova-token-plan`、`raccoon`、`codearts`、`officeace`、`catpaw`、`github-copilot` 等 |
| 模型目录 | `wps-lingxi` → 11 个真实模型（`deepseek-v4.1-flash`、`kimi-k3`、`GLM-5.3` …） |
| 手机面板 | 48 个节点 / 5774 字节 / `issues: []`，账号与登录按钮都在 |
| 检查器 | 0 error |

---

## 已知边界

- **git spec 不会自动安装**（`https://github.com/xxx/yyy`）：magpie 用 bun 装，本插件不代劳，面板会提示「没有找到插件目录」。
- **面板里的 `hub-*` / `jet-hub-*` provider** 来自 `magpie-providers-hub` 插件本身（magpie 版的 jet Hub），不是重复实现。
- **签到**依赖插件声明的 `auth.checkin`；没声明就没有签到按钮。
