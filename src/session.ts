/**
 * session.ts —— 会话持久化
 *
 * 模型无状态，"记得上次聊到哪"全靠 harness 把对话历史落盘。
 * 每轮任务结束后把 messages 存成 JSON 文件；用户下次用 /resume 恢复。
 * 存储位置：~/.nano-harness/sessions/<时间戳>.json
 *
 * 这是 harness 六大件里最朴素的模块，但没有它，
 * 用户在终端里跑了一小时的长任务会因一个 Ctrl+C 全部蒸发。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import type { ChatMessage } from './llm.js';

const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');

/** 一个会话文件在磁盘上的形状 */
interface SessionFile {
  createdAt: string;
  /** 第一条用户消息——列表预览用，让人认得出"这是哪个会话" */
  title: string;
  messages: ChatMessage[];
}

/** 确保目录存在并保存一个会话，返回文件名 */
export async function saveSession(messages: ChatMessage[]): Promise<string> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  // 找第一条 user 消息当标题；找不到（理论上不会）就退化为"未命名会话"
  const firstUser = messages.find((m) => m.role === 'user') as { content: string } | undefined;
  const title = (firstUser?.content ?? '未命名会话').replace(/\s+/g, ' ').slice(0, 60);
  const name = `${Date.now()}.json`;
  const data: SessionFile = {
    createdAt: new Date().toISOString(),
    title,
    messages,
  };
  await fs.writeFile(join(SESSIONS_DIR, name), JSON.stringify(data, null, 2), 'utf8');
  return name;
}

/** 最近会话列表（新的在前），最多 limit 条 */
export async function listSessions(limit = 10): Promise<{ file: string; title: string; createdAt: string }[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch {
    return []; // 目录还不存在 = 从未有过会话
  }
  // 文件名是时间戳，按名称倒序即按时间倒序
  const sorted = names.filter((n) => n.endsWith('.json')).sort().reverse().slice(0, limit);
  const result: { file: string; title: string; createdAt: string }[] = [];
  for (const name of sorted) {
    try {
      const data = JSON.parse(await fs.readFile(join(SESSIONS_DIR, name), 'utf8')) as SessionFile;
      result.push({ file: name, title: data.title, createdAt: data.createdAt });
    } catch {
      // 单个会话文件损坏不碍事，跳过即可——持久化层要有"脏数据免疫力"
    }
  }
  return result;
}

/** 按文件名加载一个会话，返回完整消息历史 */
export async function loadSession(name: string): Promise<ChatMessage[]> {
  const raw = await fs.readFile(join(SESSIONS_DIR, name), 'utf8');
  const data = JSON.parse(raw) as SessionFile;
  return data.messages;
}
