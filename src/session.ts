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
import type { ChatMessage } from './llm.js';

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
      const data = JSON.parse(await fs.readFile(join(SESSIONS_DIR, name), 'utf8')) as SessionFile;
      result.push({
        file: name,
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt ?? data.createdAt,
        archived: data.archived ?? false,
        ...(data.workspace ? { workspace: data.workspace } : {}),
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

/** 按文件名加载一个会话，返回完整消息历史 */
export async function loadSession(name: string): Promise<ChatMessage[]> {
  const raw = await fs.readFile(join(SESSIONS_DIR, safeName(name)), 'utf8');
  const data = JSON.parse(raw) as SessionFile;
  // 载荷也要校验：坏文件塞进来会让宿主拿到 undefined，之后处处报错
  if (!Array.isArray(data?.messages)) {
    throw new Error(`会话文件格式不正确（缺少 messages 数组）：${name}`);
  }
  return data.messages;
}

/** 切换会话归档状态（列表里一行小按钮即可归档/恢复） */
export async function setSessionArchived(name: string, archived: boolean): Promise<void> {
  const file = join(SESSIONS_DIR, safeName(name));
  const data = JSON.parse(await fs.readFile(file, 'utf8')) as SessionFile;
  data.archived = archived;
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}
