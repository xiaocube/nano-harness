/**
 * self/store.ts —— 自改进守护进程的本地状态与待办（全部在仓库内 .nano-self/）
 *
 *  .nano-self/
 *    state.json    累计统计（提交数、token、连续无进展次数、最后运行时间）
 *    journal.jsonl 每次尝试的结构化记录（一行一个对象，便于审计"它都干了什么"）
 *    backlog.json  待办队列：用户可手写改进项；为空时走内置的常青维护任务
 *    STOP          急停标记文件，存在即不再开始新的尝试（`nh self stop`）
 *
 * 该目录会被写进 .git/info/exclude（不污染被版本管理的 .gitignore，也不会被提交）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from '../llm.js';

export const SELF_DIR_NAME = '.nano-self';
const STATE_FILE = 'state.json';
const JOURNAL_FILE = 'journal.jsonl';
const BACKLOG_FILE = 'backlog.json';
export const STOP_FILE = 'STOP';

/** 原子写 JSON（先写临时文件再 rename，避免写到一半崩溃损坏状态） */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 累计统计（跨多次 `nh self run` 持久，用于预算与熔断） */
export interface SelfState {
  totalAttempts: number;
  totalCommits: number;
  totalTokens: number;
  /** 连续"没做出有效改进"的尝试次数（无改动/回滚）；达到阈值自动休息停止 */
  consecutiveIdle: number;
  lastRunAt?: string;
}

export const DEFAULT_STATE: SelfState = {
  totalAttempts: 0,
  totalCommits: 0,
  totalTokens: 0,
  consecutiveIdle: 0,
};

/** 一条待办 */
export interface BacklogItem {
  id: string;
  title: string;
  hint?: string;
  status: 'pending' | 'done' | 'skipped';
  createdAt: string;
}

/** 单次尝试的结果（写进 journal，并由 supervisor 汇总返回） */
export type AttemptOutcome =
  | 'committed'    // 改了代码、闸门通过、已本地提交
  | 'rolled_back'  // 改了但闸门失败且修不好，已回滚
  | 'idle'         // 模型判断没有安全可做的改进，未改动
  | 'baseline_red_wait'; // 基线就失败且本轮没能修绿

export interface JournalEntry {
  ts: string;
  attempt: number;
  outcome: AttemptOutcome;
  branch: string;
  baseSha: string;
  commitSha?: string;
  tokens: number;
  steps: number;
  baselineOk: boolean;
  fixRounds: number;
  durationMs: number;
  taskTitle: string;
  note: string;
}

export class SelfStore {
  readonly dir: string;
  private stateFile: string;
  private journalFile: string;
  private backlogFile: string;
  readonly stopFile: string;

  constructor(repoRoot: string) {
    this.dir = path.join(repoRoot, SELF_DIR_NAME);
    this.stateFile = path.join(this.dir, STATE_FILE);
    this.journalFile = path.join(this.dir, JOURNAL_FILE);
    this.backlogFile = path.join(this.dir, BACKLOG_FILE);
    this.stopFile = path.join(this.dir, STOP_FILE);
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async isStopRequested(): Promise<boolean> {
    try { await fs.access(this.stopFile); return true; } catch { return false; }
  }

  async readState(): Promise<SelfState> {
    return { ...DEFAULT_STATE, ...(await readJson<Partial<SelfState>>(this.stateFile, {})) };
  }

  async writeState(state: SelfState): Promise<void> {
    state.lastRunAt = new Date().toISOString();
    await writeJsonAtomic(this.stateFile, state);
  }

  async appendJournal(entry: JournalEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.journalFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async readBacklog(): Promise<BacklogItem[]> {
    const items = await readJson<BacklogItem[]>(this.backlogFile, []);
    return Array.isArray(items) ? items.filter((i) => i && i.status === 'pending') : [];
  }

  /** 列出全部待办（含已完成/跳过，便于 backlog list 展示） */
  async listAllBacklog(): Promise<BacklogItem[]> {
    const items = await readJson<BacklogItem[]>(this.backlogFile, []);
    return Array.isArray(items) ? items : [];
  }

  /** 追加一条待办，返回新条目 */
  async addBacklog(title: string, hint?: string): Promise<BacklogItem> {
    const all = await readJson<BacklogItem[]>(this.backlogFile, []);
    const item: BacklogItem = {
      id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title, hint, status: 'pending', createdAt: new Date().toISOString(),
    };
    all.push(item);
    await writeJsonAtomic(this.backlogFile, all);
    return item;
  }

  /** 设置/解除急停标记 */
  async setStop(stop: boolean): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    if (stop) {
      await fs.writeFile(this.stopFile, `requested at ${new Date().toISOString()}\n`, 'utf8');
    } else {
      await fs.rm(this.stopFile, { force: true });
    }
  }

  /** 取一条待办并标记完成/跳过（提交成功后才标 done，回滚则仍留待办） */
  async checkoutBacklogItem(id: string, mark: 'done' | 'skipped'): Promise<void> {
    const all = await readJson<BacklogItem[]>(this.backlogFile, []);
    for (const item of all) {
      if (item.id === id) item.status = mark;
    }
    await writeJsonAtomic(this.backlogFile, all);
  }

  /** 查看最近若干条 journal（`nh self journal` 用） */
  async tailJournal(n: number): Promise<JournalEntry[]> {
    let text = '';
    try { text = await fs.readFile(this.journalFile, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l) as JournalEntry);
  }
}

/** 把 agent 历史里对自改进没用的 system 消息去掉后给日志/展示用 */
export function withoutSystem(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== 'system');
}
