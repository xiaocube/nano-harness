/**
 * context.ts —— 上下文管理
 *
 * 模型的上下文窗口是有限且昂贵的（超过窗口直接报错；接近窗口时费用线性上涨）。
 * agent 又是"token 消耗机器"：每一步都把全部历史重新发送一遍，
 * 长任务里几十个工具结果能把窗口塞爆。
 *
 * 解法是"压缩"（compaction）：当历史超过阈值，把较早的对话交给模型自己总结成
 * 一段摘要，用摘要替换原始历史，只保留最近几轮原文。信息有损，但换来了
 * "无限长对话"的能力——Claude Code 的 /compact、dsh 的记忆管理都是这个思路。
 */

import type { ChatMessage } from './llm.js';
import type { HarnessConfig } from './config.js';
import { callChat } from './llm.js';

/**
 * 粗略估算一段文本的 token 数。
 * 精确计数需要每家模型的 tokenizer（又重又依赖厂商），
 * 教学实现用经验值：英文约 4 字符/token，中文约 1~1.5 字符/token，
 * 中英混合取 2.5 字符/token，误差 ±30%，对"是否该压缩"的判断完全够用。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

/** 估算整个对话历史的 token 占用 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(JSON.stringify(m)), 0);
}

/** 压缩时保留的最近消息条数：太少会让模型"失忆"，太多则压缩收益不明显 */
const KEEP_RECENT = 6;

/**
 * 检查历史是否超限，超限则压缩。
 *
 * @param messages 当前完整历史（system + 对话）
 * @param cfg      配置（contextChars 是压缩阈值）
 * @returns 压缩后的历史；未超限则原样返回
 */
export async function maybeCompact(
  messages: ChatMessage[],
  cfg: HarnessConfig,
): Promise<{ messages: ChatMessage[]; compacted: boolean }> {
  const totalChars = messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  if (totalChars <= cfg.contextChars) {
    return { messages, compacted: false }; // 没超限，不折腾
  }

  // 拆成三段：system 提示（永远保留且永远在最前）/ 旧历史（待压缩）/ 最近消息（保留原文）
  const [system, ...rest] = messages;
  const oldPart = rest.slice(0, Math.max(0, rest.length - KEEP_RECENT));
  const recentPart = rest.slice(-KEEP_RECENT);
  if (oldPart.length === 0) {
    return { messages, compacted: false }; // 除了最近几轮没有可压缩的
  }

  // 让同一个模型来当"会议纪要员"：把旧历史浓缩成结构化摘要
  const transcript = oldPart
    .map((m) => {
      const role =
        m.role === 'assistant' ? '助手' : m.role === 'user' ? '用户' : m.role === 'tool' ? '工具' : '系统';
      const content = 'content' in m ? String(m.content) : JSON.stringify(m);
      return `[${role}] ${content.slice(0, 2000)}`;
    })
    .join('\n');

  const summaryRes = await callChat(
    cfg,
    [
      {
        role: 'system',
        content:
          '你是对话摘要助手。把给定的对话历史压缩成一份结构化摘要，供后续对话作为背景知识。' +
          '必须保留：用户的最终目标、已做出的关键决定、已创建/修改过的文件路径、重要命令的执行结果、尚未解决的问题。' +
          '直接输出摘要正文，不要任何开场白。',
      },
      { role: 'user', content: `请总结以下对话历史：\n\n${transcript.slice(0, cfg.contextChars)}` },
    ],
    [], // 摘要过程不需要工具
  );

  const summary = summaryRes.message.content;
  const compacted: ChatMessage[] = [
    system, // 人设规则回到最前
    {
      role: 'user',
      content: `【此前对话的摘要——压缩自 ${oldPart.length} 条消息】\n${summary}\n【摘要结束。以上是背景，请基于摘要与后续对话继续任务】`,
    },
    ...recentPart,
  ];
  return { messages: compacted, compacted: true };
}
