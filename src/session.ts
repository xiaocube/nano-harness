/**
 * session.ts —— 会话持久化
 *
 * 模型无状态，"记得上次聊到哪"全靠 harness 把对话历史落盘。
 * 每轮任务结束后把 messages 存成 JSON 文件；用户下次用 /resume 恢复。
 * 存储位置：~/.nano-harness/sessions/<时间戳>.json
 *
 * v0.3：文件携带元数据（updatedAt/archived），支持排序与"归档/筛选"——
 * 对齐 dsh 的会话管理：隐藏已归档 / 全部对话 / 仅显示已归档。
 */

import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import type { ChatMessage, ToolCall } from './llm.js';

const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');

/** 一个会话文件在磁盘上的形状 */
interface SessionFile {
  createdAt: string;
  /** 最后活动时间（每轮任务保存时刷新；列表默认按它倒序） */
  updatedAt: string;
  /** 归档标记：归档的会话默认从列表隐藏 */
  archived: boolean;
  /** 第一条用户消息——列表预览用，让人认得出"这是哪个会话" */
  title: string;
  /**
   * 这个会话是在哪个文件夹（工作区）里跑的。
   * 侧栏按它把会话挂到各个文件夹下面（对齐 dsh 的 grouped session list）；
   * 早期版本没有这个字段，界面会把它们单列成"未记录文件夹"。
   */
  workspace?: string;
  messages: ChatMessage[];
}

/** 列表用的会话摘要 */
export interface SessionInfo {
  file: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** 会话所属工作区绝对路径（老会话可能没有） */
  workspace?: string;
}

/** 归档筛选模式（对齐 dsh：隐藏已归档 / 全部对话 / 仅显示已归档） */
export type ArchiveFilter = 'hide' | 'all' | 'only';

/**
 * 会话文件名守卫：只允许"本目录下的单个 .json 文件名"。
 * 文件名会从渲染层（侧栏）一路传进来，不校验的话 `../config.json`
 * 就能读写会话目录之外的文件。
 */
function safeName(name: unknown): string {
  if (typeof name !== 'string' || basename(name) !== name || !/^[\w.-]+\.json$/.test(name)) {
    throw new Error(`非法的会话文件名：${String(name)}`);
  }
  return name;
}

/**
 * 确保目录存在并保存一个会话，返回文件名。
 * @param workspace 本轮任务的工作区（侧栏据此把会话挂到对应文件夹下）
 */
export async function saveSession(
  messages: ChatMessage[],
  existingFile?: string,
  workspace?: string,
): Promise<string> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  const firstUser = messages.find((m) => m.role === 'user') as { content: string } | undefined;
  const title = (firstUser?.content ?? '未命名会话').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名会话';

  // 追加保存（传了 existingFile）时保留原有的 createdAt/archived/workspace
  let createdAt = new Date().toISOString();
  let archived = false;
  let storedWorkspace = workspace;
  if (existingFile) {
    try {
      const prev = JSON.parse(await fs.readFile(join(SESSIONS_DIR, safeName(existingFile)), 'utf8')) as SessionFile;
      createdAt = prev.createdAt ?? createdAt;
      archived = prev.archived ?? false;
      storedWorkspace = workspace ?? prev.workspace;
    } catch { /* 旧文件读不到就按新会话处理 */ }
  }

  // 文件名用时间戳 + 随机后缀：同一毫秒内连续保存两个新会话也不会互相覆盖
  const name = existingFile ? safeName(existingFile) : `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const data: SessionFile = {
    createdAt,
    updatedAt: new Date().toISOString(),
    archived,
    title,
    ...(storedWorkspace ? { workspace: storedWorkspace } : {}),
    messages,
  };
  // 原子写：先写临时文件再 rename，避免中断留下半截 JSON（会被当成损坏会话丢弃）
  const target = join(SESSIONS_DIR, name);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, target);
  return name;
}

/**
 * 最近会话列表。默认按 updatedAt 倒序（最近更新在前，对齐 dsh 的排序方式），
 * archiveFilter 控制归档可见性。
 */
export async function listSessions(limit = 50, archiveFilter: ArchiveFilter = 'hide'): Promise<SessionInfo[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch {
    return []; // 目录还不存在 = 从未有过会话
  }
  const result: SessionInfo[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const data = JSON.parse(await fs.readFile(join(SESSIONS_DIR, name), 'utf8')) as Partial<SessionFile>;
      // 载荷也要有最低限度的结构：缺 messages 的半截文件不算合法会话
      if (!Array.isArray(data.messages)) continue;
      // 时间字段缺失/损坏时互相兜底，避免排序时 NaN 打乱整个列表
      const now = new Date().toISOString();
      const createdAt = typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : now;
      result.push({
        file: name,
        title: typeof data.title === 'string' && data.title ? data.title : '未命名会话',
        createdAt,
        updatedAt: typeof data.updatedAt === 'string' && data.updatedAt ? data.updatedAt : createdAt,
        archived: data.archived === true,
        ...(typeof data.workspace === 'string' && data.workspace ? { workspace: data.workspace } : {}),
      });
    } catch {
      // 单个会话文件损坏不碍事，跳过即可——持久化层要有"脏数据免疫力"
    }
  }
  // 归档筛选 → 按 updatedAt 倒序 → 截取条数
  return result
    .filter((s) => archiveFilter === 'all' || (archiveFilter === 'only' ? s.archived : !s.archived))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** 按文件名加载一个会话，返回完整消息历史（对坏消息做清洗，保证恢复后能继续发请求） */
export async function loadSession(name: string): Promise<ChatMessage[]> {
  const raw = await fs.readFile(join(SESSIONS_DIR, safeName(name)), 'utf8');
  const data = JSON.parse(raw) as SessionFile;
  // 载荷也要校验：坏文件塞进来会让宿主拿到 undefined，之后处处报错
  if (!Array.isArray(data?.messages)) {
    throw new Error(`会话文件格式不正确（缺少 messages 数组）：${name}`);
  }
  return sanitizeMessages(data.messages);
}

/**
 * 清洗对话历史：只保留形状合法的消息，把 content 归一化成字符串。
 * 磁盘上的会话可能来自旧版本/写入中断/手动编辑，直接发给端点会 400；
 * runAgentTurn 每轮开始还会再刷新首条 system，所以这里把不合法的首条 system 删掉即可。
 */
function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  const out: ChatMessage[] = [];
  for (const m of input as unknown[]) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    const content = typeof msg.content === 'string' ? msg.content : '';
    switch (msg.role) {
      case 'system':
      case 'user':
        if (content || msg.role === 'user') out.push({ role: msg.role, content });
        break;
      case 'assistant': {
        const calls = Array.isArray(msg.tool_calls)
          ? (msg.tool_calls as unknown[]).flatMap((c): ToolCall[] => {
              if (!c || typeof c !== 'object') return [];
              const tc = c as Record<string, unknown>;
              const fn = tc.function as Record<string, unknown> | undefined;
              if (typeof fn?.name !== 'string') return [];
              return [{
                id: typeof tc.id === 'string' && tc.id ? tc.id : `restored-${out.length}-${Math.random().toString(36).slice(2, 8)}`,
                type: 'function',
                function: { name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}' },
              }];
            })
          : undefined;
        out.push(calls && calls.length > 0
          ? { role: 'assistant', content, tool_calls: calls }
          : { role: 'assistant', content });
        break;
      }
      case 'tool':
        // tool 消息必须带 tool_call_id；没有归属的孤儿 tool 会让端点 400，丢弃
        if (typeof msg.tool_call_id === 'string' && msg.tool_call_id) {
          out.push({ role: 'tool', tool_call_id: msg.tool_call_id, content });
        }
        break;
      default:
        break;
    }
  }
  // 二次校正"工具调用组"，保证发出去的历史满足 OpenAI 协议（每个 tool_call 都要有
  // 紧跟的 tool 结果、每条 tool 都要指向一个真实存在的 call）。写入中断 / 手工编辑 /
  // 旧版本都可能造成不配对，这类历史恢复后会被端点稳定 400，且永远发不出去。
  //   1) 收集所有 assistant 声明过的 call id；
  //   2) 丢弃"孤儿 tool"（tool_call_id 指向一个不存在的 call）；
  //   3) assistant 上只保留"确实有 tool 结果回应"的 call；一个都没有就转成普通文字。
  const declaredIds = new Set<string>();
  for (const m of out) {
    if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) declaredIds.add(c.id);
  }
  const paired: ChatMessage[] = [];
  for (const m of out) {
    if (m.role === 'tool' && !declaredIds.has(m.tool_call_id)) continue; // 孤儿 tool
    paired.push(m);
  }
  const answeredIds = new Set<string>();
  for (const m of paired) if (m.role === 'tool') answeredIds.add(m.tool_call_id);
  for (let i = 0; i < paired.length; i++) {
    const m = paired[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const answered = m.tool_calls.filter((c) => answeredIds.has(c.id));
      paired[i] = answered.length > 0
        ? { role: 'assistant', content: m.content, tool_calls: answered }
        : { role: 'assistant', content: m.content };
    }
  }
  // 首条若非 system，不动它——runAgentTurn 会自动补/刷 system。
  return paired;
}

/** 切换会话归档状态（列表里一行小按钮即可归档/恢复）。原子写，防止并发保存把文件写花 */
export async function setSessionArchived(name: string, archived: boolean): Promise<void> {
  const file = join(SESSIONS_DIR, safeName(name));
  const data = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<SessionFile>;
  if (!Array.isArray(data.messages)) {
    throw new Error(`会话文件格式不正确（缺少 messages 数组）：${name}`);
  }
  data.archived = archived;
  data.updatedAt = data.updatedAt ?? new Date().toISOString();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
