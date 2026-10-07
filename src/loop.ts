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
 * 模型没有"多步执行"的能力——它每次只能输出一段文字。
 * "连续工作"的表象，是 harness 这个 while 循环喂出来的。
 */

import type { ChatMessage, ToolCall } from './llm.js';
import type { HarnessConfig } from './config.js';
import { callChat } from './llm.js';
import { getTool, toOpenAITools, type ToolContext } from './tools/index.js';
import { confirm } from './permission.js';
import { maybeCompact } from './context.js';
import { startSpinner, printToolCall, printToolResult, printUsage } from './ui.js';
import { previewForPermission } from './tools/fs-tools.js';

/**
 * 系统提示词：模型的"人设 + 规则"，上下文工程的第一块拼图。
 * 它会被放进历史的第一条，之后每轮都随历史一起发给模型。
 */
function buildSystemPrompt(workspace: string): string {
  return [
    '你是运行在终端里的智能体（nano-harness）。',
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
  /** 当前配置（maxSteps / contextChars / 模型信息都从这里来） */
  cfg: HarnessConfig;
  /** 工作区根目录（也是工具的路径安全边界） */
  workspace: string;
  /** YOLO 模式：跳过权限确认 */
  yolo: boolean;
}

/** 一次 agent 回合的产出 */
export interface TurnResult {
  /** 模型的最终文字回答 */
  answer: string;
  /** 更新后的完整对话历史（cli 层接着用，实现多轮记忆） */
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

  // 历史为空说明是新会话：先放系统提示词
  if (messages.length === 0) {
    messages.push({ role: 'system', content: buildSystemPrompt(opts.workspace) });
  }
  // 用户任务入栈——这就是模型看到的"需求"
  messages.push({ role: 'user', content: task });

  const tools = toOpenAITools();

  for (let step = 1; step <= opts.cfg.maxSteps; step++) {
    // 历史太长先压缩：压缩也调一次模型，但换来"无限长对话"的能力
    const { messages: compacted, compacted: didCompact } = await maybeCompact(messages, opts.cfg);
    if (didCompact) {
      messages.length = 0; // 原地替换内容而非换引用——cli 层持有的还是同一个数组
      messages.push(...compacted);
      console.log('  (上下文已压缩，较早的对话被折叠成摘要)');
    }

    // ① 问模型。spinner 让用户知道"没卡死，在等模型"
    const spinner = startSpinner(`思考中…（第 ${step}/${opts.cfg.maxSteps} 步）`);
    let result;
    try {
      result = await callChat(opts.cfg, messages, tools);
    } finally {
      spinner.stop(); // 无论成败都停掉转圈，否则光标会一直闪
    }
    const assistant = result.message;
    printUsage(result.usage?.total_tokens, opts.cfg.model);

    // ② 模型没要工具 → 它认为任务完成了，输出就是最终答案
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      messages.push({ role: 'assistant', content: assistant.content });
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
        const available = toOpenAITools().map((t) => t.function.name).join(', ');
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `错误：不存在名为 "${call.function.name}" 的工具。可用工具：${available}`,
        });
        continue;
      }

      // ④-2 解析模型生成的参数 JSON（协议里 arguments 是字符串）。解析失败也回传错误
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `错误：工具参数不是合法 JSON：${call.function.arguments.slice(0, 200)}`,
        });
        continue;
      }

      // ④-3 过程可视化 + 危险操作权限确认
      printToolCall(step, opts.cfg.maxSteps, tool.name, tool.describe(args));
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
          continue;
        }
      }

      // ④-4 真正执行。任何异常都转成文字回传——模型擅长读报错并自愈
      try {
        const result = await tool.execute(args, toolCtx);
        printToolResult(result);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      } catch (err) {
        const errMsg = `工具执行出错：${(err as Error).message}`;
        printToolResult(errMsg);
        messages.push({ role: 'tool', tool_call_id: call.id, content: errMsg });
      }
    }
    // ⑤ 回到循环开头：工具结果已在历史里，下一轮模型就能"看到"它们了
  }

  // 跑满 maxSteps 仍没收敛：主动刹车，把控制权还给用户。
  // 这一步防的是"模型死循环烧钱"——生产级 harness 必须有熔断。
  const brake = `已达最大步数（${opts.cfg.maxSteps}）上限，为防止无限循环我停止了执行。请把任务拆分成更小的步骤重试。`;
  messages.push({ role: 'assistant', content: brake });
  return { answer: brake, messages };
}
