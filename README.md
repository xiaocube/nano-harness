# ⚡ nano-harness

![platform](https://img.shields.io/badge/platform-macOS-000000)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![license](https://img.shields.io/badge/license-MIT-blue)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-8338e6)

> **一款可直接落地生产的本地化 AI 智能体工作台。**
> 终端 CLI + **macOS 桌面应用** + **插件市场**，一套内核、两种形态——把任意 OpenAI 兼容模型，变成能读写文件、执行命令、跨会话持续交付的工程助手。

nano-harness 已完成从 0 到 1 的产品闭环：开箱即用的桌面端与命令行、模型厂商无关、工作区级安全护栏、插件生态，以及一套覆盖关键路径的自动化测试体系。它在你的本机与内网内运行，**源代码、API Key 与业务数据始终留在你手里**，不锁定厂商、不依赖云托管，可自由商用与二次开发。

- **终端 CLI（`nh`）**：交互式多轮会话 / 一次性任务，适合工程师日常与脚本化、CI 化集成
- **macOS 桌面应用（`npm run desktop`）**：原生窗口、毛玻璃侧栏、深浅色跟随系统，会话 / 文件 / 成果预览 / 插件市场 / 设置一体化

## ✨ 产品能力

- **模型无关，避免厂商锁定**：标准 OpenAI 兼容协议，DeepSeek / 智谱 GLM / Ollama 本地模型 / 任意私有或自建端点，改一行配置即可切换，也可在多供应商间并存
- **真正能交付的 Agent**：读写代码、执行命令、跨会话记忆与恢复、超长上下文自动压缩，工具执行过程全程可见、可审计
- **本地化与私有部署**：核心零运行时依赖、无需云端；配合 Ollama 等可完全离线运行，满足内网与数据敏感场景
- **企业级安全护栏**：工作区路径围栏（含符号链接越狱防护）、危险操作人工确认、最大步数熔断与有界自动续跑，默认安全、最小授权
- **macOS 原生体验**：hiddenInset 红绿灯、vibrancy 毛玻璃侧栏、原生菜单、浅色 / 深色 / 跟随系统三态主题
- **成果预览面板**：HTML 就地运行、Markdown / 图片 / 代码分类渲染，多标签并排查看 Agent 产出，无需在访达与浏览器间来回切换
- **插件市场与扩展体系**：插件与内置工具同构，UI 一键安装；团队可发布私有插件，把内部系统与工作流快速接入 Agent
- **自改进守护进程（`nh self`）**：有预算、有质量闸门、失败自动回滚、可急停的回合制自动化能力，可持续维护与优化代码库
- **事件驱动、易于集成**：无头核心 + 事件总线，CLI 与桌面端都是订阅者，可平滑嵌入现有平台与流水线

## 🖼️ 界面预览

> 以下为 macOS 桌面端实拍（截图中的对话与项目均为演示数据，API Key 只存在本机）。

**对话页：工具执行过程可见，Markdown / 代码块 / 表格直接渲染**

![对话页](docs/images/02-conversation.png)

<p align="center">
  <img alt="首屏（浅色）" src="docs/images/01-overview-light.png" width="49%" />
  <img alt="首屏（深色，侧栏为原生毛玻璃）" src="docs/images/06-overview-dark.png" width="49%" />
</p>

<p align="center">
  <img alt="文件面板" src="docs/images/03-files.png" width="49%" />
  <img alt="插件市场" src="docs/images/04-plugins.png" width="49%" />
</p>

<p align="center">
  <img alt="设置：外观 / 权限模式 / 最大步数" src="docs/images/05-settings.png" width="72%" />
</p>

## 📦 安装

```bash
# 从源码安装（当前可用方式）
git clone https://github.com/xiaocube/nano-harness.git && cd nano-harness
npm install && npm run build
npm link          # 把 nh 注册为全局命令
```

要求：Node.js ≥ 20。全局 npm 分发（`npm install -g nano-harness`）与签名 `.dmg` 安装包已在路线图中。

质量自检（每次改动后的固定闸门）：

```bash
npm run check          # 类型检查 + 构建 + 全部测试（提交前必跑）
npm run typecheck      # core(tsc) + desktop(tsc) + web(tsc --noEmit)
npm test               # 构建 + 全量自动化用例（Node 内置 test runner，零额外依赖）
npm run build:all      # 产出 dist/ + dist-desktop/ + web/dist/
npm run pack           # 打包 macOS .app（electron-builder）
npm run smoke:desktop  # 真实 Electron 启动渲染冒烟（需图形会话，不进默认闸门）
```

## 🚀 快速开始

```bash
$ nh              # 首次运行进入 30 秒配置向导
$ nh "梳理这个项目结构，输出一份 README 提纲"   # 一次性任务，跑完即退
$ nh              # 再次进入即为交互式多轮会话
```

**macOS 桌面应用**（首次构建会下载 Electron，已配置国内镜像）：

```bash
npm run desktop   # 构建核心 + 桌面壳 + 界面，并打开原生窗口
```

桌面端提供：极简首屏（居中输入框 + 示例任务）、工具调用过程卡片、权限确认弹窗、
**工作区（文件夹）切换**、插件市场（浏览 / 安装 / 发布）、设置页（模型配置 + 外观三态 + 连接测试）。
深浅色自动跟随 macOS 系统外观，也可在设置中手动指定。

无 API Key 也可先用内置 mock 服务跑通整条链路：

```bash
npm run mock     # 终端 1：启动模拟模型服务
nh "测试" --base-url http://127.0.0.1:8787/v1 --api-key mock --model mock-model --yolo
```

交互模式命令：`/help` `/tools` `/plugins` `/model` `/clear` `/sessions` `/resume` `/dir` `/exit`

## 👀 成果预览（右侧可拖拽面板）

Agent 的产出不必再去访达或浏览器里翻找——内容区右侧即开即用一列预览面板：

```
┌────────┬──────────────┬──────────────────┐
│ 侧栏    │ 对话 / 文件   │ ⇔ │ README.md ✕  │   ← 标签页，多份成果并存
│        │              │   │ demo.png  ✕  │
│        │              │   │  ...内容...   │
└────────┴──────────────┴──────────────────┘
              ↑ 拖拽这条边调宽（双击复位，宽度本地记忆）
```

- 侧栏 **「文件」** 按目录列出当前工作区，点文件即在右侧打开；
- 对话中工具卡片上的 **「预览」** 按钮，可直接打开刚生成的文件；
- 按类型分流渲染：**HTML 就地运行**（可用于即时预览页面与前端原型）、Markdown 排版、
  图片直接显示、代码 / 文本等宽展示；其它格式提供「用默认应用打开」；
- 多文件以多标签并存，关闭最后一个标签面板自动收起；面板宽度本地记忆；
- 面板宽度设上限，始终为对话区保留至少 360px。

实现要点：HTML 经自定义协议 `nh-file://` 提供给 sandbox iframe。

- 不使用 `data:` URL——data: 文档会**继承应用页面的 CSP**，预览页内联 `<script>`
  会被 `default-src 'self'` 拦截（只剩静态样式、脚本无法运行）；
- `nh-file://` 是独立来源、自带响应头，既不继承 CSP，相对路径引用的 CSS/JS/图片
  也能沿同一协议正确加载；
- iframe 仍带 `sandbox`（禁止顶层跳转 / 弹窗），协议处理器同样受**工作区边界**约束，
  越界路径一律拒绝。

**工作区 = Agent 的活动边界**：文件读写的路径安全限制、bash 工作目录、系统提示词中的
"当前目录"均由它决定。侧栏「工作区」是**按文件夹分组的会话列表**：

- 每个打开过的文件夹一行，**点击展开 / 收起其下会话**；
- 列表**始终按修改时间倒序**（取"该文件夹最新会话时间"与"文件夹自身修改时间"中较新者），
  **切换选择不改变排序**；当前文件夹仅以蓝点标记，不抢占位置；
- 点击非当前工作区的文件夹会一并切换（后续任务即在该目录执行）；
- **尚无会话的文件夹，点击直接进入该文件夹的空白新任务**，组内也提供"开始新任务"入口；
- 空文件夹不会从列表消失（记入"最近打开"），可随时返回新建任务；
- 打开任一会话会自动切回它所属的工作区；会话文件记录 `workspace` 字段，重启后分组不乱；
- 「打开文件夹…」调用原生选择框（可在其中新建文件夹），新文件夹即刻出现；
- 顶部搜索框按标题过滤，右侧漏斗切换"隐藏已归档 / 全部 / 仅已归档"。

选择结果写入 `~/.nano-harness/config.json`，**下次启动自动回到同一文件夹**；
文件夹被删除或移动时自动从列表剔除并回落默认目录，不崩溃。

## ⚙️ 配置

优先级：命令行参数 > 环境变量（`NANO_HARNESS_BASE_URL` / `NANO_HARNESS_API_KEY` / `NANO_HARNESS_MODEL`）> `~/.nano-harness/config.json` > 默认值。

```jsonc
// ~/.nano-harness/config.json
{
  "baseUrl": "https://api.deepseek.com",        // 任意 OpenAI 兼容端点
  "apiKey": "sk-xxxx",                          // 本地模型（如 Ollama）可留空
  "model": "deepseek-chat",
  "maxSteps": 25,                               // Agent Loop 单轮熔断步数
  "yolo": false,                                // true = 跳过所有权限确认
  "contextChars": 48000,                        // 历史超过此字符数触发压缩
  "workspace": "/path/to/project",              // 桌面端工作区（Agent 的活动边界）
  "recentWorkspaces": ["/path/to/other"]        // 最近使用的文件夹（最多 8 个）
}
```

内置厂商预设（配置向导可直接选择）：

| 预设 | baseUrl | 默认模型 | 说明 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | 低成本，国内直连 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 含免费额度，国内直连 |
| Ollama | `http://localhost:11434/v1` | `qwen3:8b` | 完全免费、离线运行 |

## 🔌 插件系统

**插件 = 一个文件夹 = `plugin.json`（清单）+ `tools.mjs`（导出 Tool[]）**。
插件工具与内置工具完全同构，团队扩展能力与使用原生能力体验一致。

```js
// my-plugin/tools.mjs —— 一个最小插件
const hello = {
  name: 'say_hello',
  description: '向指定的人打招呼',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  needsPermission: false,
  describe: (args) => String(args.name),
  execute: async (args) => `你好，${args.name}！`,
};
export default { tools: [hello] };
```

- **安装**：桌面端插件市场一键安装，或放入 `~/.nano-harness/plugins/<名字>/`
- **发布**：插件置于公开（或团队私有）GitHub 仓库 → 向 `marketplace/index.json` 提 PR → 合并后对用户可见
- **参考示例**：`examples/plugins/devtools`（时间 / 字数统计 / 系统信息三个工具）
- 安全说明：v1 插件在 harness 进程内运行（拥有相同权限），安装前请审阅插件源码；worker / 子进程沙箱隔离已在路线图

## 🤖 自改进守护进程（`nh self`）

一套**有预算、有验收、能回滚、可急停**的回合制自动化能力，可在受控边界内持续维护代码库——
不是放任一个 agent 空转，而是由"主管"按工程规范编排每一次改动。

```bash
nh self run                 # 运行一段自改进会话（默认最多 3 次尝试）
nh self run --attempts 10 --token-budget 300000
nh self gate                # 只执行一次质量闸门（= npm run check）
nh self backlog add "为 X 补充边界测试"   # 投放指定任务（优先于内置维护任务）
nh self journal             # 查看结构化工作日志
nh self stop                # 急停；nh self resume 解除
```

每次"尝试（attempt）"的流程：

1. **前置安全**：要求干净的 git 仓库、非 detached HEAD；工作树有未提交改动直接拒绝
   （绝不卷入在制工作）；存在 `.nano-self/STOP` 标记则不启动。
2. **先跑闸门取基线**：闸门通过则执行一项小改进；闸门本就失败，则本轮唯一目标是修复至通过。
3. **切 `nano/self/*` 临时分支**，以**受限工具集**运行：只能读写仓库源码、
   执行固定的 `run_check`、只读查看 `git_status`；**无 shell、不能联网、不能装依赖、
   不能自行提交**，且禁止写 `.git / node_modules / dist / package.json / .github`。
   单轮撞步数上限会携带上下文**自动续跑**（默认再 1 轮，可用 `--turn-continuations` 调整，
   `--max-steps` 控制单轮步数），避免改到一半被熔断而回滚成果。
4. **再跑闸门**：失败则在限额（`--fix-rounds`）内修复；仍失败 → `reset --hard`
   并清理本次未跟踪文件，硬回滚到原提交、删除临时分支。
5. **通过且确有改动 → 由主管（非模型）执行 add + 本地提交**。默认只提交到 `nano/self/*`
   分支供审阅（合并或丢弃由你决定）；加 `--integrate ff` 才会**快进合并**到当前分支，
   绝不产生合并提交、绝不 `push`。
6. 记录结构化日志（`.nano-self/journal.jsonl`）、累计 token 与连续空闲次数；
   超出 token 预算或连续无安全可做的改进即自动收工，避免空转消耗。

> 安全边界：只本地提交，**不外联、不 push、不发布、不安装依赖**；所有自动改动必须让
> `npm run check`（类型检查 + 构建 + 全部测试）持续通过，且禁止以删除或弱化测试"造绿"。
> 请在**已 `npm install`（含 devDependencies）的源码检出**中运行。

## 🛡️ 生产就绪与安全

nano-harness 以"默认安全、最小授权、全程可审计"为设计前提，关键路径均有自动化测试守护。

**三层安全防御**

| 层 | 机制 | 位置 |
|---|---|---|
| 1 | 工作区路径围栏：文件操作强制限制在边界内（含符号链接越狱拦截） | `tools/fs-tools.ts` |
| 2 | 权限确认：写文件 / 执行命令前展示内容，默认拒绝，终端与 UI 均可注入决策 | `permission.ts` |
| 3 | 熔断：单轮最大步数强制刹车并可有界续跑，防止死循环与失控消耗 | `loop.ts` |

**可靠性工程（全量自动化用例，测试目录与真实配置完全隔离）**

测试通过 `NANO_HARNESS_HOME` 将配置 / 会话目录指向临时文件夹，绝不触碰真实的
`~/.nano-harness/`（含 API Key）。覆盖范围：

| 文件 | 覆盖内容 |
|---|---|
| `tests/config.test.mjs` | 默认值、读写、环境变量覆盖、脏数据免疫、权限 0600 |
| `tests/session.test.mjs` | 保存 / 列出 / 加载 / 归档、workspace 归属、损坏文件免疫、文件名安全 |
| `tests/fs-tools.test.mjs` | **路径围栏（含符号链接越狱）**、读写编辑、大文件分段读取 |
| `tests/loop.test.mjs` | Agent Loop 全链路、权限放行 / 拒绝、未知工具、坏 JSON、步数熔断与续跑、预设 |
| `tests/context.test.mjs` | 压缩触发条件、**不切开工具调用组**、失败降级 |
| `tests/bash-tool.test.mjs` | 工作目录、退出码、**超时杀掉整个进程组**、输出截断 |
| `tests/plugins.test.mjs` | 安装 / 启用 / 禁用、**禁用不执行代码**、**插件名注入与越界删除** |

面板与弹窗的无头核心逻辑（权限决策、超时、会话与工具链路）由 `node --test` 覆盖；
桌面 GUI 的"能否真正启动并渲染"由 `npm run smoke:desktop` 做真实 Electron 冒烟
（需图形会话，本机桌面或 macOS CI 可跑，默认不计入 `npm test`）。

**数据与合规**

- 完全本地运行，API Key 仅存于本机（配置文件权限 0600），不上传、不经过第三方；
- 可搭配本地模型实现**断网 / 内网离线**使用，适配金融、政企等强监管环境；
- 源码以 MIT 许可开放，零运行时依赖，每一处网络、文件与命令行为均可自行审计。

## 🧠 工程架构

无头核心 + 事件总线，CLI 与桌面端是对等的两种"订阅者"外壳：

```
┌──────────────────────── 终端 CLI（src/cli.ts）────────────────────┐
│  REPL / 一次性任务 —— 核心事件的终端渲染订阅者                       │
└──────────────────────────┬─────────────────────────────────────┘
                           │ 同一套核心，两种外壳
┌──────────────────────────┴─────────────────────────────────────┐
│  Electron 渲染层（web/，Vite+React）—— 事件的可视化订阅者          │
│  聊天 · 插件市场 · 设置 ══ contextBridge IPC ══ desktop/ 主进程    │
└──────────────────────────┬─────────────────────────────────────┘
                           │
   ┌───────────┬───────────┴───────────┬──────────────┐
   ▼           ▼                       ▼              ▼
 loop.ts★   tools/ + plugins.ts     llm.ts         config / session / context
 Agent Loop  工具注册表 + 插件加载    模型客户端       配置 / 会话 / 上下文
（onEvent 事件流 · 权限确认可注入：终端 readline 或 UI 弹窗）
```

Agent Loop（`src/loop.ts`）以标准的"模型决策 → 工具调用 → 结果回填 → 再决策"循环驱动，
直到模型给出最终答复；工具说明书按当前注册表与已装插件每次动态生成，能力即插即用。

## 🔧 开发者：扩展自定义工具

新增工具与内置工具完全同构。以"查天气"为例，新建 `src/tools/weather-tool.ts`：

```ts
import { registerTool } from './index.js';
import type { Tool } from './index.js';

export function registerWeatherTool(): void {
  const getWeather: Tool = {
    name: 'get_weather',
    description: '查询指定城市当前天气。用户问天气时使用。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 北京' },
      },
      required: ['city'],
    },
    needsPermission: false,           // 只读操作无需确认
    describe: (args) => String(args.city ?? ''),
    execute: async (args) => {
      const res = await fetch(`https://wttr.in/${args.city}?format=3`);
      return await res.text();
    },
  };
  registerTool(getWeather);           // 登记进注册表即生效
}
```

在 `src/tools/index.ts` 的 `registerBuiltinTools()` 中引入并调用即可；
下一轮对话模型即可使用该能力——工具说明书随每次请求动态生成。

## 🗺️ 路线图

- [x] ~~macOS 桌面应用 + 插件市场~~（v0.2.0）
- [x] ~~多提供商模型管理 + 工作区切换~~（v0.3.x）
- [x] ~~成果预览面板 + 自动化测试体系 + 发布加固 + 应用图标~~（v0.4.0）
- [x] ~~自改进守护进程 `nh self` + 单轮有界自动续跑~~（v0.5.0）
- [ ] 流式输出（SSE 逐字打印）与"停止任务"控制
- [ ] 签名 / 公证 `.dmg` 分发 + 自动更新，以及 npm 全局安装
- [ ] 子 agent（任务拆分并行，保护主上下文）
- [ ] MCP 支持（接入协议生态的第三方工具）
- [ ] 插件沙箱（worker / 子进程隔离运行 + 权限声明）
- [ ] 会话列表虚拟滚动（海量会话不掉帧）

## 🤝 商业与生态

- 源码以 **MIT** 许可开放，可自由商用、二次开发、私有化与 OEM 交付；
- 面向团队的典型落地：内网私有部署、接入内部系统的定制插件、与私有模型 / 网关集成；
- 需要私有化交付、定制工具链或企业内集成支持，欢迎通过 [GitHub Issues](https://github.com/xiaocube/nano-harness/issues) 联系。

## 📄 License

[MIT](./LICENSE)
