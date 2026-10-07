# ⚡ nano-harness

> 一个**零运行时依赖**、模块化的 AI Agent Harness。
> 终端 CLI + **macOS 桌面应用** + **插件市场**，让你读懂并拥有一个完整的 Agent——Agent = Model + Harness。

大模型本身只会"文字进、文字出"。它不能读你的文件、不能跑命令、记不住上一句话。
把模型变成能干活的**智能体（Agent）**的，是包裹在模型外面的那一整套软件——**Harness**（原意"马具"：模型是马，harness 是缰绳和马鞍）。

Claude Code、OpenAI Codex CLI、DeepSeek Harness（dsh）都是这个思路的工业级实现。
nano-harness 用**带中文注释的 TypeScript** 实现了它们共同的核心骨架，并提供两种形态：

- **终端 CLI（`nh`）**：REPL 多轮对话 / 一次性任务，体验对标 Claude Code
- **macOS 桌面应用（`npm run desktop`）**：原生窗口 + 毛玻璃侧栏 + 跟随系统深浅色 + 插件市场界面

## ✨ 特性

- **零运行时依赖**：核心只用 Node 原生模块 + 内置 `fetch`，安全可审计
- **模型无关**：OpenAI 兼容协议，DeepSeek / 智谱 GLM / Ollama / 任何兼容端点，改一行配置即切换
- **macOS 原生体验**：hiddenInset 红绿灯、vibrancy 毛玻璃侧栏、原生菜单、浅色/深色/跟随系统三态主题
- **插件市场**：插件 = 工具包（与内置工具同构），UI 一键安装；发布 = 向 `marketplace/index.json` 提 PR
- **安全护栏**：路径越界防护、危险操作人工确认（终端问询 / UI 弹窗）、最大步数熔断
- **事件驱动架构**：核心无头化，CLI 与桌面 UI 都是事件的订阅者——任何人都能写自己的订阅者
- **全程中文注释**：每个文件的开头都讲清楚"这个模块为什么存在、怎么设计的"

## 📦 安装

```bash
# 方式一：从源码安装（推荐开发者）
git clone <your-repo-url> && cd nano-harness
npm install && npm run build
npm link          # 把 nh 挂为全局命令

# 方式二：发布后一行安装（规划中）
npm install -g nano-harness
```

要求：Node.js ≥ 20。

## 🚀 快速开始

```bash
$ nh              # 首次运行进入 30 秒配置向导
$ nh "看看这个项目结构，写一个 README 提纲"   # 一次性任务，跑完退出
$ nh              # 之后进入交互模式，像聊天一样连续对话
```

**macOS 桌面应用**（首次构建约需下载 Electron，已配置国内镜像）：

```bash
npm run desktop   # 构建（核心+桌面+界面）并打开原生应用窗口
```

桌面版功能：极简首屏（居中输入框 + 示例任务）、工具调用过程卡片、权限确认弹窗、
插件市场（浏览/安装/发布指引）、设置页（模型配置 + 外观三态 + 连接测试）。
深浅色自动跟随 macOS 系统外观，也可在设置里手动指定。

无 API Key 想先体验？用内置 mock 服务器跑通 CLI 全流程：

```bash
npm run mock     # 终端 1：启动模拟模型服务器
nh "测试" --base-url http://127.0.0.1:8787/v1 --api-key mock --model mock-model --yolo
```

交互模式内可用命令：`/help` `/tools` `/plugins` `/model` `/clear` `/sessions` `/resume` `/dir` `/exit`

## ⚙️ 配置

优先级：命令行参数 > 环境变量（`NANO_HARNESS_BASE_URL` / `NANO_HARNESS_API_KEY` / `NANO_HARNESS_MODEL`）> `~/.nano-harness/config.json` > 默认值。

```jsonc
// ~/.nano-harness/config.json
{
  "baseUrl": "https://api.deepseek.com",        // OpenAI 兼容端点
  "apiKey": "sk-xxxx",                          // Ollama 可留空
  "model": "deepseek-chat",
  "maxSteps": 25,                               // Agent Loop 熔断步数
  "yolo": false,                                // true = 跳过所有权限确认
  "contextChars": 48000                         // 历史超过此字符数触发压缩
}
```

内置厂商预设（配置向导可直接选）：

| 预设 | baseUrl | 默认模型 | 说明 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | 便宜，国内直连 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 有免费额度，国内直连 |
| Ollama | `http://localhost:11434/v1` | `qwen3:8b` | 完全免费离线 |

## 🔌 插件系统

**插件 = 一个文件夹 = `plugin.json`（说明书）+ `tools.mjs`（导出 Tool[]）**。
插件工具与内置工具完全同构——写插件和给 harness 内置工具是同一件事。

```js
// my-plugin/tools.mjs —— 一个最小的插件
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

- **安装**：桌面版插件市场一键安装，或手动放入 `~/.nano-harness/plugins/<名字>/`
- **发布**：把插件放到公开 GitHub 仓库 → 向主仓库 `marketplace/index.json` 提 PR → 合并后全用户可见
- **参考示例**：`examples/plugins/devtools`（时间/字数统计/系统信息三个工具）
- ⚠️ v1 插件在 harness 进程内运行（拥有相同权限），安装前请阅读插件源码；沙箱化在路线图中

## 🧠 架构：核心 + 双外壳

```
┌──────────────────────── 终端 CLI（src/cli.ts）────────────────────┐
│  REPL / 一次性任务 —— 核心事件的"终端渲染订阅者"                     │
└──────────────────────────┬─────────────────────────────────────┘
                           │ 同一套核心，两种外壳
┌──────────────────────────┴─────────────────────────────────────┐
│  Electron 渲染层（web/，Vite+React）── 事件的可视化订阅者          │
│  聊天 · 插件市场 · 设置 ══ contextBridge IPC ══ desktop/ 主进程    │
└──────────────────────────┬─────────────────────────────────────┘
                           │
   ┌───────────┬───────────┴───────────┬──────────────┐
   ▼           ▼                       ▼              ▼
 loop.ts★   tools/ + plugins.ts     llm.ts         config / session / context
 Agent Loop  工具注册表+插件加载     模型客户端       配置/会话/上下文
（onEvent 事件流 · 权限确认可注入：终端 readline 或 UI 弹窗）
```

### Agent Loop（`src/loop.ts`，全项目的心脏）

```
任务入栈 ──▶ 调模型（带上全部历史+工具说明书）
              │
              ├─ 返回文字 ──▶ 这就是最终回答，结束
              │
              └─ 返回 tool_calls ──▶ 逐个执行：
                    危险工具？──▶ 权限确认（默认拒绝）
                    执行 ──▶ 结果作为 tool 消息回填历史 ──▶ 回到顶部
```

模型没有"连续工作"的能力，它每次只能输出一段文字；
**"智能体在连续干活"的表象，是这个 while 循环喂出来的。**

### 安全设计（三层防御）

| 层 | 机制 | 位置 |
|---|---|---|
| 1 | 路径越界防护：文件操作强制限制在工作区内 | `tools/fs-tools.ts` |
| 2 | 权限确认：写文件/跑命令前展示内容，默认拒绝 | `permission.ts`（终端/UI 可注入） |
| 3 | 熔断：最大 25 步强制刹车，防死循环烧钱 | `loop.ts` |

## 🔧 如何添加自己的工具（10 分钟教程）

以"查天气"为例，新建 `src/tools/weather-tool.ts`：

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
  registerTool(getWeather);           // 就这一行，登记进注册表
}
```

然后在 `src/tools/index.ts` 的 `registerBuiltinTools()` 里 `import` 并调用即可。
模型会在下一轮对话里"自动学会"这个新能力——因为工具说明书是每次请求动态生成的。

## 🆚 与工业级 harness 的对照

| 能力 | nano-harness | Claude Code | dsh |
|---|---|---|---|
| Agent Loop | ✅ | ✅ | ✅ |
| 工具注册表 + JSON Schema | ✅ | ✅ | ✅（插件化） |
| 权限确认 | ✅ | ✅ | ✅（沙箱化） |
| 会话持久化 / 恢复 | ✅ | ✅ | ✅ |
| 上下文压缩 | ✅（基础版） | ✅（/compact） | ✅（记忆管理） |
| 流式输出 | 路线图 | ✅ | ✅ |
| 子 agent / MCP / Skills | 路线图 | ✅ | ✅ |
| 代码规模 | ~800 行 | 数十万行 | 数万行 |

看懂本项目 = 掌握了它们共享的那 20% 核心骨架。

## 🗺️ 路线图

- [x] ~~macOS 桌面应用 + 插件市场~~（v0.2.0 ✅）
- [ ] 流式输出（SSE 逐字打印，体验对齐 Claude Code）
- [ ] 打包 .dmg / .app 安装包（electron-builder + 自动更新）
- [ ] 子 agent（任务拆分并行，保护主上下文）
- [ ] MCP 支持（接入协议生态的第三方工具）
- [ ] 插件沙箱（worker/子进程隔离运行 + 权限声明）
- [ ] 应用图标与 Dock 集成

## 🤔 商业化思路（给同样想开源的你）

harness 本身大多免费开源，价值捕获在别处：

1. **开源 CLI + 云服务**：CLI 免费（获客），托管版/团队版收费（OpenCode 模式：1300 万月活 → $60M ARR）
2. **绑定自家模型 API**：harness 免费引流，token 消耗即收入（DeepSeek 模式）
3. **订阅制**：个人 Pro 档 + 企业席位（Claude Code 模式：$2.5B+ ARR）
4. **控制平面卡位**：争夺"agent 任务调度入口"的生态位，比 CLI 本身更值钱

## 📄 License

MIT
