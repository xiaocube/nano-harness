/**
 * llm.ts —— 模型客户端（OpenAI 兼容协议）
 *
 * 这一层是 harness 与大模型之间的"电话线"：把对话历史和工具定义发给模型，
 * 收回模型的回复（可能是纯文字，也可能是"我要调用某工具"的意图）。
 *
 * 为什么只支持 OpenAI 兼容协议就够？
 *   因为它已是事实标准——DeepSeek、智谱 GLM、Ollama、OpenRouter、vLLM……
 *   全都实现了同一个 /chat/completions 接口。harness 因此天然"模型无关"。
 *
 * 零依赖设计：Node 18+ 内置全局 fetch，不需要 openai 官方 SDK。
 */

import type { HarnessConfig } from './config.js';

/* ---------- 协议类型定义（与 OpenAI chat completions 对齐） ---------- */

/** 模型发起的"工具调用意图"：arguments 是 JSON 字符串而非对象（协议如此定义） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 对话历史中的一条消息。
 * 四种角色构成 agent 的记忆：
 *   system    —— 给模型的"人设与规则"（通常只有一条，永远排在最前）
 *   user      —— 用户说的话
 *   assistant —— 模型说过的话（可能附带 tool_calls）
 *   tool      —— 工具执行结果，必须用 tool_call_id 对应回某次调用
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** 发给模型的工具说明书（OpenAI function calling 格式） */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 一次模型调用的返回：assistant 消息 + token 用量 */
export interface ChatResult {
  message: { role: 'assistant'; content: string; tool_calls?: ToolCall[] };
  usage?: { total_tokens?: number };
}

/** 把 base_url 和路径拼成完整 URL（容忍末尾多余的 /） */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/** 从 HTTP 状态码翻译出人话——这是"傻瓜式"的一部分：报错要告诉用户怎么修 */
function explainStatus(status: number, body: string): string {
  const excerpt = body.slice(0, 300);
  switch (status) {
    case 401:
      return `API Key 无效或未填写（401）。请检查配置：~/.nano-harness/config.json\n服务端返回：${excerpt}`;
    case 403:
      return `没有权限（403）。可能是 Key 欠费或该模型未开通。\n服务端返回：${excerpt}`;
    case 404:
      return `接口或模型不存在（404）。请检查 base_url 是否正确、模型名是否拼写正确。\n服务端返回：${excerpt}`;
    case 429:
      return `请求过于频繁或额度不足（429）。\n服务端返回：${excerpt}`;
    default:
      return `API 请求失败（HTTP ${status}）。\n服务端返回：${excerpt}`;
  }
}

/**
 * 调用模型：POST {baseUrl}/chat/completions
 *
 * @param cfg      当前配置（base_url / key / model）
 * @param messages 完整对话历史（模型是无状态的，每次都要把历史全部发给它）
 * @param tools    可用工具清单；为空时完全不传（普通对话模式）
 * @param retries  网络抖动/限流时的自动重试次数（退避递增等待）
 */
export async function callChat(
  cfg: HarnessConfig,
  messages: ChatMessage[],
  tools: OpenAITool[],
  retries = 2,
): Promise<ChatResult> {
  const url = joinUrl(cfg.baseUrl, 'chat/completions');
  // 请求体：模型无状态，所以每次都带上完整历史与工具清单
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: 0.7,
  };
  // 只有真有工具时才传 tools 字段——部分兼容端点对空数组会报错
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // 本地模型（Ollama/mock）可以没有 Key，此时不带 Authorization 头
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // 单次调用最长等 120 秒：本地小模型可能很慢，但也不能无限等
        signal: AbortSignal.timeout(120_000),
      });

      // 限流/服务端临时故障：等一会儿重试（退避：2s、4s）
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }

      if (!res.ok) {
        throw new Error(explainStatus(res.status, await res.text()));
      }

      const data = (await res.json()) as {
        choices?: { message?: { role: string; content: string | null; tool_calls?: ToolCall[] } }[];
        usage?: { total_tokens?: number };
      };
      const choice = data.choices?.[0]?.message;
      if (!choice) {
        throw new Error(`模型返回了意外格式：${JSON.stringify(data).slice(0, 300)}`);
      }
      return {
        message: {
          role: 'assistant',
          content: choice.content ?? '',
          ...(choice.tool_calls ? { tool_calls: choice.tool_calls } : {}),
        },
        usage: data.usage,
      };
    } catch (err) {
      lastError = err as Error;
      const msg = (err as Error).message ?? '';
      // 网络层错误（超时/断连）才值得重试；协议层错误（401/404）重试也没用
      const retriable = msg.includes('timeout') || msg.includes('fetch failed') || msg.includes('ECONNRESET');
      if (!retriable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
    }
  }
  throw lastError ?? new Error('模型调用失败');
}
