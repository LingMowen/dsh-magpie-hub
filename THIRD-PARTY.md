# 第三方来源声明

`dsh-magpie-hub` 不是一个从零开始的独立实现。它的存在前提是下面这些项目的工作——有的直接包含在本仓库中，有的是它运行所依赖的宿主，有的是它适配的外部生态。

本仓库与这些项目的作者**没有隶属关系，也未经其背书**。

**许可兼容性**：本仓库整体以 AGPL-3.0 发布。其中 `ui/` 目录是 magpie（MIT）的逐文件拷贝 —— MIT 允许被并入更严格的许可，条件是保留原版权与许可声明，本文档第 1 节即为该声明。其余上游（DeepSeek Harness、dsh-Go）只是运行宿主与协议来源，其代码不在本仓库内。

---

## 1. magpie —— 插件协议、数据格式与 Web UI

- **项目**：[yetone/magpie](https://github.com/yetone/magpie)（约 35k stars）
- **主页**：https://usemagpie.ai
- **许可**：MIT
- **一句话**：*"Every agent's model. One place. Codex on DeepSeek, Claude Code on Kimi, from the menu bar."*

本仓库对 magpie 的依赖是**最重的**，分三层：

| 依赖面 | 具体内容 | 是否包含在本仓库 |
|---|---|---|
| **Web UI（代码拷贝）** | `ui/` 目录下的 265 个文件 / 约 12 MB —— magpie 原版管理界面的完整前端 | **是**，逐文件来自上游，未做功能改动 |
| **插件协议** | 插件的模块形状（导出函数 → 返回钩子对象）、钩子契约 `M1-M20`（`auth` / `loader` / `models` / `usage` / `checkin` / `config` 等）、`ctx` 与 `scoped` 的语义 | 否，仅按其规范**重新实现宿主**（`src/host.js`、`src/types.js`、`src/scope.js`） |
| **数据格式** | `~/.config/magpie/` 下的 `plugins.json`、`plugin-auth.json`、`plugin-providers.json`、`usage.jsonl`、`hub-settings.json` 的字段布局 | 否，仅**读写**这些文件以继承既有数据 |

`ui/` 里的文件保留了上游的版权与注释。若你分发本仓库，请一并保留。

> **注意**：`ui/` 是上游 Web UI 的拷贝，**不是本仓库原创**。本仓库原创的是 `src/`（9604 行，17 个模块）、`client/` 的桌面客户端与 `test/`。上游若更新了 UI，本仓库需要手动同步。

---

## 2. DeepSeek Harness（DSH）—— 宿主运行时

- **项目**：DeepSeek Harness（`@deepseek-ai/*` 系列包）
- **许可**：随发行包声明
- **关系**：本仓库是它的**插件**，运行在它的进程内

| 包 | 用途 | 声明方式 |
|---|---|---|
| `@deepseek-ai/cordis` | 插件容器与依赖注入（`ctx.inject`、`ctx.llm`、`ctx.logger`） | `peerDependencies: ^4.0.2` |
| `@deepseek-ai/dsh-llm` | LLM 运行时：`LlmAdapter` 基类、`LlmError`、`registerAdapter` | `peerDependencies: >=0.2.1-rc.5 <0.3.0` |
| `@deepseek-ai/dsh-client-connection` | 桌面 Web UI 与宿主之间的连接层 | 运行时由 DSH 提供，不直接 import |

本仓库**只 import 一个外部包**：`src/adapter.js` 里的 `import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'`。其余全部是 Node 内置模块（`node:fs` / `node:path` / `node:zlib` / `node:crypto` / `node:stream` 等）。

未打包进本仓库、也未在 `dependencies` 里声明的（由宿主提供）：`cordis`、DSH 的 profile 装载器、Web UI 服务器。

---

## 3. dsh-Go —— 手机端原生插件协议

- **项目**：dsh-Go（DeepSeek Harness 的移动端客户端，本工作区的 `dsh-Go/` 目录）
- **关系**：本仓库的**手机端面板**实现的是它定义的原生插件协议

| 协议位置 | 本仓库用法 | 对应实现 |
|---|---|---|
| `panels` | 主面板（`id: magpie`） | `src/panel.js` + `src/index.js` 的 `ctx.dshGo.panel(...)` |
| `composer.strip` | 输入框上方的额度状态条（`id: magpie-strip`） | `src/index.js` 的 `dshGo.strip(...)` + `src/surfaces.js` 的 `stripLine` |
| `turn.note` | 每回合的消耗脚注（`id: magpie-note`） | `src/index.js` 的 `dshGo.turnNote(...)` + `src/surfaces.js` 的 `noteLine` / `noteQuota` |

设计文档参考（同样来自 dsh-Go 项目，未包含在本仓库）：

- `docs/design/native-plugins-protocol.md` —— 协议 v1 冻结稿，surface 上限、`effect` 白名单、`contributes` 声明规则
- `docs/design/native-plugins-views.md` —— 视图节点能力（`stack` / `row` / `text` / `metric` / `list` / `actions` / `form` / `chips` 等）、`_minWidth` 与图标名集合
- `docs/design/native-plugins.md` —— effect 白名单与节点总览

> 手机端面板的**全部**视觉约束（图标只有 43 个合法名、`actions` 在 v2 下永远是描边、`form` 提交按钮才实心、脚注放不下就整条丢弃）都来自上述协议与 App 实现，不是本仓库的设计选择。

---

## 4. 运行时与工具链

| 组件 | 用途 | 是否打包 |
|---|---|---|
| **Node.js** `^22.19.0 \|\| >=24.0.0` | 运行环境 | 否 |
| **React** | `client/magpie-hub.js` 里 `require("react")` —— 桌面客户端 UI，由 DSH 宿主提供 | 否（`peerDependencies` 未显式声明，运行时由 DSH 注入） |
| **esbuild** | 构建 `client/` 产物（`scripts.build: node build-client.mjs`） | 否，仅开发期 |
| **node:test** | 单元测试（`node --test test/*.test.js`），无第三方测试框架 | 否 |

除此之外**没有运行时第三方依赖**：`dependencies` 为空，所有 import 要么是 `node:*`，要么是宿主提供的 `@deepseek-ai/dsh-llm`。

---

## 5. 名字

本仓库名为 `dsh-magpie-hub`：`dsh-` 前缀表示它是 DSH 的插件，`magpie-hub` 表示它承载 magpie 的插件生态。它不是 magpie 官方项目的一部分，与上游作者没有隶属关系。

---

## 6. 本文档的维护

新增对任何第三方代码、协议或数据格式的依赖时，**必须在本文档补充一节**，写清：项目名与链接、许可、依赖面（含代码 / 只读规范 / 只读写数据）、是否打包。

当前已核对（0.2.0）：

- `src/*.js` 的外部 import：仅 `@deepseek-ai/dsh-llm` ✅
- `client/magpie-hub.js` 的外部 require：仅 `react` ✅
- `ui/*.js` 的外部 import：无 ✅
- `package.json` 的 `dependencies`：空 ✅
