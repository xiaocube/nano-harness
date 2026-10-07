#!/usr/bin/env node
/**
 * cli.ts —— 命令行入口
 *
 * 职责清单：
 *   1. 解析命令行参数（任务、--yolo、--dir、模型覆盖等）
 *   2. 首启向导：没配置过？三步问答带你完成配置（傻瓜式的关键）
 *   3. 两种运行模式：
 *      a) 一次性任务：nh "修复这个bug" —— 跑完即退出，适合脚本化
 *      b) 交互 REPL：nh —— 像聊天一样连续对话，支持 /命令
 *   4. 组装各模块（config / llm / tools / loop / session）并接管 Ctrl+C
 */

import { parseArgs } from 'node:util';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { C, banner, printAnswer, startSpinner, printToolCall, printToolResult, printUsage } from './ui.js';
import { loadConfig, saveConfig, configExists, isConfigUsable, getActiveProvider, PRESETS, type HarnessConfig } from './config.js';
import { registerBuiltinTools, listTools } from './tools/index.js';
import { runAgentTurn, type LoopOptions, type AgentEvent } from './loop.js';
import { setAskQuestion } from './permission.js';
import { saveSession, listSessions, loadSession } from './session.js';
import { loadInstalledPlugins } from './plugins.js';
import type { ChatMessage } from './llm.js';

const VERSION = '0.3.0';

/**
 * 把核心事件翻译成终端渲染——CLI 是核心事件的第一个订阅者。
 * 桌面端（Electron）会写自己的订阅者把同样的事件渲染成界面。
 */
function makeTerminalSubscriber(): (evt: AgentEvent) => void {
  let spinner: { stop: (finalText?: string) => void } | null = null;
  return (evt: AgentEvent) => {
    switch (evt.type) {
      case 'thinking_start':
        spinner = startSpinner(`思考中…（第 ${evt.step}/${evt.maxSteps} 步）`);
        break;
      case 'thinking_end':
        spinner?.stop();
        spinner = null;
        break;
      case 'usage':
        printUsage(evt.tokens, evt.model);
        break;
      case 'compacted':
        console.log('  (上下文已压缩，较早的对话被折叠成摘要)');
        break;
      case 'tool_call':
        printToolCall(evt.step, evt.maxSteps, evt.name, evt.summary);
        break;
      case 'tool_result':
        printToolResult(evt.preview);
        break;
      case 'tool_denied':
        console.log(C.gray(`  ↳ ${evt.name} 被用户拒绝`));
        break;
      case 'answer':
        break; // 最终回答由调用方拿返回值统一渲染
    }
  };
}

/* ---------------- 帮助文本 ---------------- */

function printHelp(): void {
  console.log(`
  nano-harness v${VERSION} —— 零依赖的终端 AI Agent Harness

  用法:
    nh                     交互模式（REPL，支持多轮对话）
    nh "<任务>"            一次性任务模式（跑完自动退出）
    nh --resume            从上次的会话继续

  常用参数:
    --dir <path>           指定工作区目录（默认当前目录）
    --model <name>         临时覆盖模型名
    --base-url <url>       临时覆盖 API 地址（OpenAI 兼容）
    --api-key <key>        临时覆盖 API Key（更推荐用环境变量）
    --yolo                 跳过所有权限确认（仅建议在沙箱/容器中使用）
    --help                 显示本帮助
    --version              显示版本号

  环境变量:
    NANO_HARNESS_BASE_URL / NANO_HARNESS_API_KEY / NANO_HARNESS_MODEL

  交互模式内命令:
    /help     显示命令列表        /tools    列出可用工具
    /model    查看或切换模型      /clear    清空当前对话
    /sessions 查看历史会话        /resume   恢复历史会话
    /exit     退出
`);
}

/* ---------------- 首启向导 ---------------- */

/** 第一次使用时的三步配置向导：选厂商 → 粘 Key → 选模型，然后落盘 */
async function runWizard(cfg: HarnessConfig): Promise<HarnessConfig> {
  console.log(C.cyan('\n  👋 欢迎使用 nano-harness！检测到这是首次运行，先做个 30 秒配置。\n'));

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // 第 1 步：选厂商（预设了 base_url，用户零记忆负担）
  console.log('  可用的模型服务商（都会随更新扩充）：');
  PRESETS.forEach((p, i) => console.log(`    ${i + 1}. ${p.label}`));
  const pick = await rl.question(C.bold(`  选择 [1-${PRESETS.length}]，回车默认 1: `));
  const preset = PRESETS[Number(pick.trim() || '1') - 1] ?? PRESETS[0];
  console.log(C.gray(`  ${preset.keyHint}\n`));

  cfg.baseUrl = preset.baseUrl || cfg.baseUrl;

  // 第 2 步：API Key（本地模型跳过）
  if (preset.needsKey || preset.key === 'custom') {
    const key = await rl.question(C.bold('  粘贴你的 API Key: '));
    cfg.apiKey = key.trim();
  }

  // 第 3 步：模型名（回车用推荐默认值）
  if (preset.defaultModel) {
    const model = await rl.question(C.bold(`  模型名 [回车默认 ${preset.defaultModel}]: `));
    cfg.model = model.trim() || preset.defaultModel;
  } else {
    const model = await rl.question(C.bold('  模型名: '));
    cfg.model = model.trim();
  }
  if (preset.key === 'custom') {
    const base = await rl.question(C.bold('  API base_url（如 https://api.example.com/v1）: '));
    if (base.trim()) cfg.baseUrl = base.trim();
  }

  rl.close();
  await saveConfig(cfg);
  console.log(C.green(`\n  ✅ 配置已保存到 ${'~/.nano-harness/config.json'}（随时可手动编辑或删除重配）\n`));
  return cfg;
}

/* ---------------- REPL 的斜杠命令 ---------------- */

/** 处理 /开头 的本地命令。返回 'exit' 表示要退出，'handled' 表示已处理，否则当任务发给模型 */
async function handleCommand(
  input: string,
  messages: ChatMessage[],
  cfg: HarnessConfig,
  workspace: string,
): Promise<'exit' | 'handled' | 'task'> {
  const [cmd, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '/help':
      console.log(
        [
          '  /help     显示本命令列表',
          '  /tools    列出当前注册的全部工具',
          '  /model    查看/切换模型：/model 或 /model glm-4-flash',
          '  /clear    清空当前对话历史（重新开始）',
          '  /sessions 查看最近保存的会话',
          '  /resume   恢复一个历史会话继续聊',
          '  /exit     退出（会话已自动保存）',
        ].join('\n'),
      );
      return 'handled';

    case '/tools':
      for (const t of listTools()) {
        console.log(`  ${C.cyan(t.name.padEnd(12))} ${C.gray(t.needsPermission ? '🔒需确认 ' : '          ')}${t.description}`);
      }
      return 'handled';

    case '/plugins': {
      const plugins = await loadInstalledPlugins(cfg, false);
      if (plugins.length === 0) {
        console.log(C.gray('  未安装任何插件。插件目录：~/.nano-harness/plugins/'));
      } else {
        for (const p of plugins) {
          const state = p.loadError ? C.red(`加载失败: ${p.loadError}`) : C.gray(`工具: ${p.toolNames.join(', ') || '无'}`);
          const flag = p.enabled ? C.green('✓') : C.yellow('✗禁用');
          console.log(`  ${flag} ${C.cyan(p.manifest.name)} v${p.manifest.version}  ${state}`);
        }
      }
      return 'handled';
    }

    case '/model': {
      if (!arg) {
        console.log(`  当前模型: ${C.bold(cfg.model)}  （用法：/model <模型名>）`);
      } else {
        cfg.model = arg;
        await saveConfig(cfg);
        console.log(`  ${C.green('✓')} 模型已切换为 ${C.bold(arg)}（已写入配置）`);
      }
      return 'handled';
    }

    case '/clear':
      messages.length = 0;
      console.log(C.gray('  已清空对话历史。'));
      return 'handled';

    case '/sessions': {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.log(C.gray('  还没有历史会话。'));
      } else {
        for (const s of sessions) {
          console.log(`  ${C.gray(s.createdAt.slice(0, 16).replace('T', ' '))}  ${s.title}`);
        }
      }
      return 'handled';
    }

    case '/resume': {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.log(C.gray('  没有可恢复的会话。'));
        return 'handled';
      }
      sessions.forEach((s, i) => console.log(`    ${i + 1}. [${s.createdAt.slice(0, 16).replace('T', ' ')}] ${s.title}`));
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const pick = await rl.question(C.bold(`  选择要恢复的会话 [1-${sessions.length}]: `));
      rl.close();
      const chosen = sessions[Number(pick.trim()) - 1];
      if (!chosen) {
        console.log(C.gray('  无效选择，已取消。'));
        return 'handled';
      }
      const loaded = await loadSession(chosen.file);
      messages.length = 0;
      messages.push(...loaded);
      console.log(C.green(`  ✓ 已恢复会话「${chosen.title}」（${loaded.length} 条消息），接着聊即可。`));
      return 'handled';
    }

    case '/exit':
      return 'exit';

    case '/dir':
      console.log(`  工作区: ${C.bold(workspace)}`);
      return 'handled';

    default:
      console.log(C.gray(`  未知命令 ${cmd}，输入 /help 查看可用命令。`));
      return 'handled';
  }
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
  // 参数解析：allowPositionals 允许接收位置参数（即"一次性任务"文本）
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      yolo: { type: 'boolean', default: false },
      dir: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  });

  if (values.help) return printHelp();
  if (values.version) return console.log(`nano-harness v${VERSION}`);

  // 组装配置：默认值 → 配置文件/环境变量 → 命令行参数（最高优先级）
  let cfg = await loadConfig();
  if (values['base-url']) cfg.baseUrl = values['base-url'];
  if (values['api-key']) cfg.apiKey = values['api-key'];
  if (values.model) cfg.model = values.model;
  cfg.yolo = values.yolo || cfg.yolo;
  // v0.3 多提供商：CLI 临时参数必须同步进"当前提供商"，
  // 否则 callChat 走 getActiveProvider 会绕过 --base-url/--api-key/--model
  {
    const active = getActiveProvider(cfg);
    if (values['base-url']) active.baseUrl = values['base-url'];
    if (values['api-key']) active.apiKey = values['api-key'];
    if (values.model) active.model = values.model;
    cfg.providers = [active, ...(cfg.providers ?? []).filter((x) => x.id !== active.id)];
    cfg.activeProviderId = active.id;
  }

  // 首启判断：仅在"既没有命令行临时配置、配置也不可用"时才走向导。
  // （一次性任务模式用 --base-url/--api-key 直跑时不应被向导拦住）
  if (!isConfigUsable(cfg) && !(await configExists())) {
    cfg = await runWizard(cfg);
    if (!isConfigUsable(cfg)) {
      console.log(C.red('  配置仍不完整（缺少 API Key 或模型名）。可重新运行 nh 再次配置，或手动编辑 ~/.nano-harness/config.json'));
      return;
    }
  }

  // 工作区：--dir 指定，或当前目录。所有文件工具的活动边界
  const workspace = path.resolve(values.dir ?? process.cwd());

  // 登记全部内置工具（想加自定义工具？看 src/tools/index.ts 的说明）
  await registerBuiltinTools();
  // 加载用户已安装的插件工具（~/.nano-harness/plugins/，禁用的插件跳过，失败不阻塞启动）
  for (const p of await loadInstalledPlugins(cfg, true)) {
    if (p.loadError) console.error(C.yellow(`  ⚠ 插件 ${p.manifest.name} 加载失败：${p.loadError}`));
  }

  /* -------- 一次性任务模式：nh "任务描述" --------
   * 注意：此模式不创建 readline——它会把 stdin 的关闭误判为用户退出。
   * 权限确认用 permission.ts 的默认实现（临时 readline，用完即关）。
   */
  if (positionals.length > 0) {
    const task = positionals.join(' ');
    const messages: ChatMessage[] = [];
    const loopOpts: LoopOptions = { cfg, workspace, yolo: cfg.yolo, onEvent: makeTerminalSubscriber() };
    try {
      const { answer, messages: updated } = await runAgentTurn(messages, task, loopOpts);
      printAnswer(answer);
      await saveSession(updated);
    } catch (err) {
      console.error(C.red(`\n  ✗ ${(err as Error).message}`));
      process.exitCode = 1;
    }
    return;
  }

  /* -------- 交互 REPL 模式 -------- */

  // 把主 readline 的提问函数注入权限层，避免双监听冲突
  const rl = readline.createInterface({ input: stdin, output: stdout });
  setAskQuestion((q) => rl.question(q));

  /** 对话历史：REPL 内跨轮次共享，这就是"多轮记忆"的本体 */
  const messages: ChatMessage[] = [];
  const loopOpts: LoopOptions = { cfg, workspace, yolo: cfg.yolo, onEvent: makeTerminalSubscriber() };

  banner(cfg.model, workspace, cfg.yolo);

  // Ctrl+C 优雅退出：readline 的 SIGINT 由 close 事件接住
  rl.on('close', () => {
    console.log(C.gray('\n  再见！（会话已自动保存，下次 /resume 可继续）'));
    process.exit(0);
  });

  for (;;) {
    let input: string;
    try {
      input = (await rl.question(C.cyan('❯ '))).trim();
    } catch {
      break; // stdin 关闭（如 Ctrl+D）
    }
    if (!input) continue;

    if (input.startsWith('/')) {
      const verdict = await handleCommand(input, messages, cfg, workspace);
      if (verdict === 'exit') {
        console.log(C.gray('（会话已自动保存）'));
        break;
      }
      continue; // 本地命令已处理，不发模型
    }

    // 把任务交给 Agent Loop，跑完把"最新历史"取回来（runAgentTurn 原地更新 messages）
    try {
      const { answer, messages: updated } = await runAgentTurn(messages, input, loopOpts);
      printAnswer(answer);
      await saveSession(updated); // 每轮自动落盘：任何时候退出都不丢对话
    } catch (err) {
      console.error(C.red(`\n  ✗ ${(err as Error).message}`));
      console.error(C.gray('  提示：检查网络、API Key 与 base_url 配置（/model 查看，或编辑 ~/.nano-harness/config.json）'));
    }
  }
}

main().catch((err) => {
  console.error(C.red(`致命错误: ${(err as Error).stack ?? (err as Error).message}`));
  process.exit(1);
});
