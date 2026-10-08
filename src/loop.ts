/**
 * loop.ts —— Agent Loop（智能体主循环）
 *
 * ★ 这是整个 harness 的心脏。理解了这 100 行，就理解了 Claude Code / dsh / Codex
 *   的共同骨架：
 *
 *     ┌────────────────────────────────────────────────┐
 *     │  1. 把任务+历史+工具说明书发给模型               │
 *     │  2. 模型回复：                                  │
 *     │      a) 纯文字 → 这就是最终答案，循环结束        │
 *     │      b) tool_calls → 模型想动"手脚"             │
 *     │  3. harness 逐个执行工具（危险操作先问用户）      │
 *     │  4. 把工具结果作为 tool 消息追加进历史            │
 *     │  5. 回到第 1 步，让模型看到结果、决定下一步       │
 *     └────────────────────────────────────────────────┘
 *
 * v0.2 无头化改造：核心不再直接打印任何东西，而是通过 onEvent 发射事件。
 * 终端 CLI 和桌面 UI 都是"事件的订阅者"——任何人都能写自己的订阅者
 * （比如日志收集器、监控面板），这正是"可 DIY harness"的底座。
 */

import type { ChatMessage, ToolCall } from './llm.js';
import type { HarnessConfig, AgentPreset } from './config.js';
import { callChat } from './llm.js';
import { getTool, listTools, type ToolContext, type Tool } from './tools/index.js';
import { confirm } from './permission.js';
import { maybeCompact } from './context.js';
import { previewForPermission } from './tools/fs-tools.js';

/**
 * Agent 预设：不同任务形态用不同的"人设 + 工具面"。
 * 与 dsh 的模式设计同源——标准覆盖日常，极简控制成本与噪声，创造面向扩展 harness 自身。
 */
export const PRESET_DEFS: Record<AgentPreset, {
  label: string; description: string; tools: string[] | null; system: (ws: string) => string;
}> = {
  standard: {
    label: '标准模式',
    description: '处理代码、文件和资料，适合大多数任务。使用全部工具。',
    tools: null, // null = 全部可用工具（含插件）
    system: (ws) => [
      '你是运行在 nano-harness 里的智能体。',
      `当前工作目录：${ws}`,
      '',
      '你可以调用工具读取/写入/编辑文件、查看目录、执行 bash 命令。',
      '',
      '工作准则：',
      '1. 先看再改：修改文件前先用 read_file 查看现状，用 list_dir 了解结构。',
      '2. 最小改动：只做与任务直接相关的修改，不顺手重构。',
      '3. 简洁汇报：回答用简体中文，直接给结论和关键信息。',
      '4. 面对错误：工具报错时阅读错误信息、调整方案重试，而不是放弃。',
      '5. 明确收尾：任务完成后简要说明做了什么、结果如何。',
    '6. 输出格式：使用标准 Markdown——列表用 "- " 开头（不要用 "--"），加粗用 **，行内代码用反引号，代码块用三反引号。',
    ].join('\n'),
  },
  minimal: {
    label: '极简模式',
    description: '仅使用只读工具快速回答，适合查询、对比和基础测试。',
    tools: ['read_file', 'list_dir'],
    system: (ws) => [
      '你是运行在 nano-harness 里的智能体（极简模式）。',
      `当前工作目录：${ws}`,
      '',
      '你只有只读能力（读文件、看目录），不能修改任何东西。',
      '回答追求快、准、短：直接给结论，必要时引用文件路径。',
      '输出格式：使用标准 Markdown——列表用 "- " 开头（不要用 "--"），加粗用 **，代码用反引号。',
    ].join('\n'),
  },
  creative: {
    label: '创造模式',
    description: '面向定制 nano-harness：让 Agent 编写插件，添加新能力和工具。',
    tools: null,
    system: (ws) => [
      '你是运行在 nano-harness 里的智能体（创造模式）。',
      `当前工作目录：${ws}`,
      '',
      '你的特殊使命：当任务缺少趁手的工具时，主动提出并动手为用户编写插件来扩展 harness——',
      '插件是一个文件夹：plugin.json（name/version/description/author）+ tools.mjs（默认导出 { tools: [...] }），',
      '放入 ~/.nano-harness/plugins/<名字>/ 后重启应用生效。参考 examples/plugins/devtools 的写法。',
      '',
      '其余准则与标准模式一致：先看再改、最小改动、简洁汇报、面对错误自愈、明确收尾。',
    ].join('\n'),
  },
};

/**
 * Agent 循环过程中对外发射的全部事件。
 * UI 层（终端/桌面）按 type 渲染，核心完全不关心长什么样。
 */
export type AgentEvent =
  /** 每步开始等模型：UI 借此显示 spinner/骨架屏 */
  | { type: 'thinking_start'; step: number; maxSteps: number }
  /** 模型返回 */
  | { type: 'thinking_end' }
  /** 本次调用的 token 用量 */
  | { type: 'usage'; tokens?: number; model: string }
  /** 历史被压缩成摘要 */
  | { type: 'compacted' }
  /** 模型发起一次工具调用（target = 被操作的文件/目录，UI 据此提供"预览"入口） */
  | { type: 'tool_call'; step: number; maxSteps: number; name: string; summary: string; target?: string }
  /** 工具执行完成（preview 是给用户看的截断预览） */
  | { type: 'tool_result'; name: string; preview: string }
  /** 用户拒绝了某次工具调用 */
  | { type: 'tool_denied'; name: string }
  /** 最终回答（与 runAgentTurn 返回值一致，事件形式方便流式 UI） */
  | { type: 'answer'; answer: string }
  /** 单轮跑到 maxSteps 上限被制动（宿主据此决定是否自动续跑） */
  | { type: 'max_steps'; maxSteps: number }
  /** 宿主决定自动续跑：index 为第几次续跑，max 为允许的续跑总次数 */
  | { type: 'continuation'; index: number; max: number };

/** 系统提示词：按预设生成（极简/创造模式各有不同人设与工具面说明） */
export function systemPromptFor(preset: AgentPreset | undefined, workspace: string): string {
  return PRESET_DEFS[preset ?? 'standard'].system(workspace);
}

/**
 * 用当前工作区/预设刷新一段历史的首条 system 消息（原地修改）。
 * 宿主在"恢复磁盘会话"或"切换工作区/预设后继续对话"时调用：
 *   - 首条是 system → 替换内容；
 *   - 首条不是 system → 在最前面补一条。
 */
export function refreshSystemPrompt(
  messages: ChatMessage[],
  preset: AgentPreset | undefined,
  workspace: string,
): void {
  const content = systemPromptFor(preset, workspace);
  if (messages.length > 0 && messages[0].role === 'system') {
    messages[0] = { role: 'system', content };
  } else {
    messages.unshift({ role: 'system', content });
  }
}

/** 工具结果回填给模型前的最大字符数（防止异常插件一条消息撑爆上下文） */
const TOOL_RESULT_MAX = 100_000;

/**
 * 把工具返回值归一化成"非空字符串"：
 *   - string 原样使用；
 *   - 对象/数组/数字等转成 JSON 文本；
 *   - null/undefined/纯空白给一个明确占位（空字符串会让模型误以为调用没发生）；
 *   - 超长截断并标注。
 */
function normalizeToolResult(raw: unknown): string {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw === null || raw === undefined) text = '';
  else {
    try {
      text = typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw);
    } catch {
      text = String(raw);
    }
  }
  if (!text.trim()) return '(工具执行成功，但没有返回内容)';
  if (text.length > TOOL_RESULT_MAX) {
    return text.slice(0, TOOL_RESULT_MAX) + `\n[工具结果过长，已截断：原文共 ${text.length} 字符]`;
  }
  return text;
}

/** 一次 agent 回合的运行参数 */
export interface LoopOptions {
  /** 当前配置（maxSteps / contextChars / 提供商都从这里来） */
  cfg: HarnessConfig;
  /** 工作区根目录（也是工具的路径安全边界） */
  workspace: string;
  /** YOLO 模式：跳过权限确认 */
  yolo: boolean;
  /** Agent 预设（缺省 standard）：决定系统提示词与工具白名单 */
  preset?: AgentPreset;
  /**
   * 直接指定本轮可用工具（自改进守护进程用它传入"无 bash、无网络"的受限工具表）。
   * 提供后忽略预设的工具白名单过滤；不提供则用全局注册表（含插件）按预设过滤。
   */
  tools?: Tool[];
  /**
   * 直接指定系统提示词（自改进守护进程用它下发专门的"只修代码、先过后闸门再提交"指令）。
   * 提供后忽略预设 system()。
   */
  systemPrompt?: string;
  /** 事件订阅者：终端打印、桌面渲染、日志收集都从这里接 */
  onEvent?: (evt: AgentEvent) => void;
}

/** 一次 agent 回合的结束原因：正常作答 / 撞上单轮步数上限 */
export type TurnStopReason = 'answered' | 'max_steps';

/** 一次 agent 回合的产出 */
export interface TurnResult {
  /** 模型的最终文字回答 */
  answer: string;
  /** 更新后的完整对话历史（宿主接着用，实现多轮记忆） */
  messages: ChatMessage[];
  /** 结束原因：answered=模型主动收尾；max_steps=单轮步数耗尽被制动 */
  stopReason: TurnStopReason;
}

/**
 * 运行一个 agent 回合：把用户的任务交给模型，循环执行工具直到给出最终回答。
 *
 * @param messages 对话历史（首次调用传 []，恢复会话时传已加载的历史）
 * @param task     用户本轮输入的任务
 * @param opts     运行参数
 */
export async function runAgentTurn(
  messages: ChatMessage[],
  task: string,
  opts: LoopOptions,
): Promise<TurnResult> {
  const toolCtx: ToolContext = { workspace: opts.workspace, cfg: opts.cfg };
  const emit = (evt: AgentEvent) => opts.onEvent?.(evt);
  const maxSteps = opts.cfg.maxSteps;
  // 本回合实际使用的预设：调用方显式指定优先，否则取配置里的持久选择（桌面端 pill 切换）。
  // 以前这里写死 standard，于是设置/创作区切了预设，对话回合仍按 standard 组装提示词与工具面。
  const preset = opts.preset ?? opts.cfg.activePreset ?? 'standard';
  const presetDef = PRESET_DEFS[preset];

  // 系统提示词（随预设/工作区变化）：
  //   历史归宿主所有——首条已是 system 时保留宿主写入的内容（宿主负责在
  //   "恢复会话/切换工作区或预设"时调用 refreshSystemPrompt 刷新，桌面端每轮
  //   发送前都会刷新，见 agent-bridge）；缺失（全新会话）时补一条到最前。
  const systemContent = opts.systemPrompt ?? presetDef.system(opts.workspace);
  if (messages.length === 0 || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: systemContent });
  }
  // 用户任务入栈——这就是模型看到的"需求"
  messages.push({ role: 'user', content: task });

  // 工具面：调用方显式注入（自改进模式的受限工具表）优先；
  // 否则取全局注册表（含插件）并按预设白名单过滤（极简模式只给只读工具）。
  const availableTools = opts.tools
    ? opts.tools
    : listTools().filter((t) => !presetDef.tools || presetDef.tools.includes(t.name));
  const tools = availableTools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  for (let step = 1; step <= maxSteps; step++) {
    // 历史太长先压缩：压缩也调一次模型，但换来"无限长对话"的能力
    const { messages: compacted, compacted: didCompact } = await maybeCompact(messages, opts.cfg);
    if (didCompact) {
      messages.length = 0; // 原地替换内容而非换引用——宿主持有的还是同一个数组
      messages.push(...compacted);
      emit({ type: 'compacted' });
    }

    // ① 问模型。事件让 UI 有机会显示"思考中"
    emit({ type: 'thinking_start', step, maxSteps });
    let result;
    try {
      result = await callChat(opts.cfg, messages, tools);
    } finally {
      emit({ type: 'thinking_end' });
    }
    const assistant = result.message;
    // 个别兼容端点会把"纯文字"消息的 content 返回成 null：当字符串归一化，
    // 否则它会一路进到会话文件，下次请求被端点以 400 拒绝。
    const assistantText = assistant.content ?? '';
    emit({ type: 'usage', tokens: result.usage?.total_tokens, model: opts.cfg.model });

    // ② 模型没要工具 → 它认为任务完成了，输出就是最终答案
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      messages.push({ role: 'assistant', content: assistantText });
      emit({ type: 'answer', answer: assistantText });
      return { answer: assistantText, messages, stopReason: 'answered' };
    }

    // ③ 模型要工具：先把它的"调用意图"原样入栈。
    //    协议要求：tool 消息必须紧跟在带 tool_calls 的 assistant 消息之后。
    //    先把调用归一化：id 缺失（部分兼容端点/模型会漏）时补一个稳定 id，
    //    arguments 不是字符串时按空对象处理——否则下面的 tool 回复会找不到归属。
    const calls: ToolCall[] = assistant.tool_calls.map((c, i) => ({
      id: typeof c?.id === 'string' && c.id ? c.id : `call-${step}-${i}-${Date.now()}`,
      type: 'function',
      function: {
        name: typeof c?.function?.name === 'string' ? c.function.name : '',
        arguments: typeof c?.function?.arguments === 'string' ? c.function.arguments : '{}',
      },
    }));
    messages.push({ role: 'assistant', content: assistantText, tool_calls: calls });

    // ④ 逐个执行工具调用（模型一次可能要求多个并行调用）
    for (const call of calls) {
      // 工具查找：优先本回合注入的工具表（自改进模式），否则查全局注册表。
      const tool = opts.tools?.find((t) => t.name === call.function.name) ?? getTool(call.function.name);

      // ④-0 工具名缺失：把错误作为"工具结果"回传
      if (!call.function.name) {
        const msg = '错误：模型返回的工具调用缺少工具名，请重新发起调用。';
        messages.push({ role: 'tool', tool_call_id: call.id, content: msg });
        emit({ type: 'tool_result', name: '(unknown)', preview: msg });
        continue;
      }

      // ④-1 工具不存在：把错误作为"工具结果"回传，模型会自己纠正
      if (!tool) {
        const available = tools.map((t) => t.function.name).join(', ');
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `错误：不存在名为 "${call.function.name}" 的工具。可用工具：${available}`,
        });
        emit({ type: 'tool_result', name: call.function.name, preview: `未知工具，可用：${available}` });
        continue;
      }

      // ④-2 解析模型生成的参数 JSON（协议里 arguments 是字符串）。解析失败也回传错误
      let args: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('参数必须是一个 JSON 对象');
        }
        args = parsed as Record<string, unknown>;
      } catch {
        const msg = `错误：工具参数不是合法 JSON 对象：${call.function.arguments.slice(0, 200)}`;
        messages.push({ role: 'tool', tool_call_id: call.id, content: msg });
        emit({ type: 'tool_result', name: tool.name, preview: msg });
        continue;
      }

      // ④-3 过程可视化 + 危险操作权限确认（确认方式由宿主注入：终端问询/桌面弹窗）
      //      target 让界面知道这次动的是哪个文件——桌面端据此给出"预览成果"入口。
      //      这一整段都在 try 里：describe/emit/confirm 任何一处抛错，都必须
      //      立刻给这次调用补一条 tool 回复，否则历史里会留下"有调用无结果"，
      //      后续每次请求都会被端点以 400 拒绝。
      let allowed = true;
      try {
        emit({
          type: 'tool_call', step, maxSteps, name: tool.name, summary: tool.describe(args),
          ...(typeof args.path === 'string' ? { target: args.path } : {}),
        });
        if (tool.needsPermission) {
          const isBash = tool.name === 'run_bash';
          const detail = isBash ? String(args.command ?? '') : await previewForPermission(args);
          allowed = await confirm(
            { title: isBash ? '执行命令' : '写入文件', detail, target: isBash ? undefined : String(args.path ?? '') },
            opts.yolo,
          );
        }
      } catch (err) {
        const msg = `工具调用准备失败：${(err as Error).message}`;
        messages.push({ role: 'tool', tool_call_id: call.id, content: msg });
        emit({ type: 'tool_result', name: tool.name, preview: msg.slice(0, 120) });
        continue;
      }
      if (!allowed) {
        // 拒绝也要回传消息：模型必须知道"这次调用被用户否了"，否则它会一直干等
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: '用户拒绝了此操作。请说明你的意图，或改用其他方案。',
        });
        emit({ type: 'tool_denied', name: tool.name });
        continue;
      }

      // ④-4 真正执行。任何异常都转成文字回传——模型擅长读报错并自愈。
      //      返回值统一归一化：非字符串转 JSON、空结果给占位提示、超长截断
      //      （内置工具各自有截断，但第三方插件不一定有，这里是最后一道防线，
      //        防止一条工具结果把上下文窗口撑爆）。
      try {
        const raw = await tool.execute(args, toolCtx);
        const text = normalizeToolResult(raw);
        emit({ type: 'tool_result', name: tool.name, preview: text.replace(/\s+/g, ' ').trim().slice(0, 120) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      } catch (err) {
        const errMsg = `工具执行出错：${(err as Error).message}`;
        emit({ type: 'tool_result', name: tool.name, preview: errMsg.slice(0, 120) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: errMsg });
      }
    }
    // ⑤ 回到循环开头：工具结果已在历史里，下一轮模型就能"看到"它们了
  }

  // 跑满 maxSteps 仍没收敛：主动刹车。
  // 这一步防的是"模型死循环烧钱"——生产级 harness 必须有熔断。
  // 注意：
  //  - 这里【不】把刹车文案塞进对话历史，也【不】发终态 'answer' 事件——
  //    它不是一个真正的回答，外层（runAgentTurnWithContinuations）可能马上续跑，
  //    网页端又会把每个 answer 事件当成最终气泡，中途发会造成"提前收尾 + 重复气泡"。
  //  - 只诚实地报告 stopReason='max_steps'；是否续跑、是否把刹车文案作为最终回答，
  //    全部交给外层决定。
  const brake = `已达最大步数（${maxSteps}）上限，为防止无限循环我停止了执行。请把任务拆分成更小的步骤重试。`;
  emit({ type: 'max_steps', maxSteps });
  return { answer: brake, messages, stopReason: 'max_steps' };
}

/**
 * 自动续跑时发给模型的"继续"指令。
 * 关键是要求它【收敛】：撞上限往往是因为一直在并行浏览/反复读文件而不动手，
 * 所以续跑不是简单说"继续"，而是明令停止大范围探索、立刻完成手头那一个最小改动。
 */
export const CONTINUATION_PROMPT = [
  '请继续完成上面的任务（单轮步数已到上限，现在是续跑）。',
  '不要再大范围浏览、重复读文件或另起新方向；请基于你已经掌握的信息立即收敛：',
  '1) 如果手头已有一个明确的小改动，就用最少的工具调用把它做完并验证；',
  '2) 然后直接给出最终结论；',
  '3) 若确实无法安全完成，请保持工作区可用并明确说明卡点，不要留下半成品。',
].join('\n');

export interface ContinuableLoopOptions extends LoopOptions {
  /**
   * 单轮撞 maxSteps 后，最多自动续跑几轮（0 = 旧行为，撞上限即停）。
   * 有界：总模型回合数 ≤ (1 + maxContinuations) × maxSteps，到顶仍未完成就收工，
   * 不会无限烧 token。
   */
  maxContinuations: number;
}

/**
 * 在 runAgentTurn 之上加一层"有界自动续跑"：
 *   单轮以 stopReason='max_steps' 结束且还有续跑额度时，复用同一份对话历史
 *   （上一轮读到的内容、工具结果都还在）追加一条收敛指令再开一轮，
 *   直到模型主动作答，或续跑额度用尽（最终 stopReason 仍为 max_steps）。
 *
 * CLI 一次性任务 / REPL / 自改进守护进程都通过它获得"干到一半不被硬停"的能力，
 * 而成本被 maxContinuations 硬性封顶。
 */
export async function runAgentTurnWithContinuations(
  messages: ChatMessage[],
  task: string,
  opts: ContinuableLoopOptions,
): Promise<TurnResult> {
  let result = await runAgentTurn(messages, task, opts);
  let used = 0;
  while (result.stopReason === 'max_steps' && used < opts.maxContinuations) {
    used += 1;
    opts.onEvent?.({ type: 'continuation', index: used, max: opts.maxContinuations });
    // runAgentTurn 会自己把这条 user 消息压入历史，无需手动 push。
    result = await runAgentTurn(messages, CONTINUATION_PROMPT, opts);
  }
  // 续跑额度用尽仍未收敛：此刻才把刹车文案作为【最终回答】落库并发终态事件，
  // 让 CLI / 桌面网页都能正常收尾（单轮内部不发，以免被误当成中途答案）。
  if (result.stopReason === 'max_steps') {
    messages.push({ role: 'assistant', content: result.answer });
    opts.onEvent?.({ type: 'answer', answer: result.answer });
  }
  return result;
}
