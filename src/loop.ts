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
import { getTool, listTools, type ToolContext } from './tools/index.js';
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
  /** 模型发起一次工具调用 */
  | { type: 'tool_call'; step: number; maxSteps: number; name: string; summary: string }
  /** 工具执行完成（preview 是给用户看的截断预览） */
  | { type: 'tool_result'; name: string; preview: string }
  /** 用户拒绝了某次工具调用 */
  | { type: 'tool_denied'; name: string }
  /** 最终回答（与 runAgentTurn 返回值一致，事件形式方便流式 UI） */
  | { type: 'answer'; answer: string };

/** 系统提示词：模型的"人设 + 规则"，上下文工程的第一块拼图。 */
function buildSystemPrompt(workspace: string): string {
  return [
    '你是运行在 nano-harness 里的智能体。',
    `当前工作目录：${workspace}`,
    '',
    '你可以调用工具读取/写入/编辑文件、查看目录、执行 bash 命令。',
    '',
    '工作准则：',
    '1. 先看再改：修改文件前先用 read_file 查看现状，用 list_dir 了解结构。',
    '2. 最小改动：只做与任务直接相关的修改，不顺手重构。',
    '3. 简洁汇报：回答用简体中文，直接给结论和关键信息。',
    '4. 面对错误：工具报错时阅读错误信息、调整方案重试，而不是放弃。',
    '5. 明确收尾：任务完成后简要说明做了什么、结果如何。',
  ].join('\n');
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
  /** 事件订阅者：终端打印、桌面渲染、日志收集都从这里接 */
  onEvent?: (evt: AgentEvent) => void;
}

/** 一次 agent 回合的产出 */
export interface TurnResult {
  /** 模型的最终文字回答 */
  answer: string;
  /** 更新后的完整对话历史（宿主接着用，实现多轮记忆） */
  messages: ChatMessage[];
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
  const presetDef = PRESET_DEFS[opts.preset ?? 'standard'];

  // 历史为空说明是新会话：先放系统提示词（随预设变化）
  if (messages.length === 0) {
    messages.push({ role: 'system', content: presetDef.system(opts.workspace) });
  }
  // 用户任务入栈——这就是模型看到的"需求"
  messages.push({ role: 'user', content: task });

  // 工具面按预设过滤：极简模式只暴露白名单内的工具（含启用的插件工具）
  const tools = listTools()
    .filter((t) => !presetDef.tools || presetDef.tools.includes(t.name))
    .map((t) => ({
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
    emit({ type: 'usage', tokens: result.usage?.total_tokens, model: opts.cfg.model });

    // ② 模型没要工具 → 它认为任务完成了，输出就是最终答案
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      messages.push({ role: 'assistant', content: assistant.content });
      emit({ type: 'answer', answer: assistant.content });
      return { answer: assistant.content, messages };
    }

    // ③ 模型要工具：先把它的"调用意图"原样入栈。
    //    协议要求：tool 消息必须紧跟在带 tool_calls 的 assistant 消息之后
    messages.push({
      role: 'assistant',
      content: assistant.content,
      ...(assistant.tool_calls ? { tool_calls: assistant.tool_calls } : {}),
    });

    // ④ 逐个执行工具调用（模型一次可能要求多个并行调用）
    for (const call of assistant.tool_calls as ToolCall[]) {
      const tool = getTool(call.function.name);

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
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        const msg = `错误：工具参数不是合法 JSON：${call.function.arguments.slice(0, 200)}`;
        messages.push({ role: 'tool', tool_call_id: call.id, content: msg });
        emit({ type: 'tool_result', name: tool.name, preview: msg });
        continue;
      }

      // ④-3 过程可视化 + 危险操作权限确认（确认方式由宿主注入：终端问询/桌面弹窗）
      emit({ type: 'tool_call', step, maxSteps, name: tool.name, summary: tool.describe(args) });
      if (tool.needsPermission) {
        const isBash = tool.name === 'run_bash';
        const detail = isBash ? String(args.command ?? '') : await previewForPermission(args);
        const allowed = await confirm(
          { title: isBash ? '执行命令' : '写入文件', detail, target: isBash ? undefined : String(args.path ?? '') },
          opts.yolo,
        );
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
      }

      // ④-4 真正执行。任何异常都转成文字回传——模型擅长读报错并自愈
      try {
        const result = await tool.execute(args, toolCtx);
        emit({ type: 'tool_result', name: tool.name, preview: result.replace(/\s+/g, ' ').trim().slice(0, 120) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      } catch (err) {
        const errMsg = `工具执行出错：${(err as Error).message}`;
        emit({ type: 'tool_result', name: tool.name, preview: errMsg.slice(0, 120) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: errMsg });
      }
    }
    // ⑤ 回到循环开头：工具结果已在历史里，下一轮模型就能"看到"它们了
  }

  // 跑满 maxSteps 仍没收敛：主动刹车，把控制权还给用户。
  // 这一步防的是"模型死循环烧钱"——生产级 harness 必须有熔断。
  const brake = `已达最大步数（${maxSteps}）上限，为防止无限循环我停止了执行。请把任务拆分成更小的步骤重试。`;
  messages.push({ role: 'assistant', content: brake });
  emit({ type: 'answer', answer: brake });
  return { answer: brake, messages };
}
