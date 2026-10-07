/**
 * permission.ts —— 权限层
 *
 * 模型提出危险操作（写文件、跑命令）时，harness 在"真正执行"前插入一道人工闸门：
 * 把要做的事展示给用户，用户点头才放行。这是 agent 安全的最后一道、也是最重要的一道防线——
 * 因为沙箱可能被绕过、路径校验可能漏判，只有"人"最清楚这个操作会不会毁掉自己的项目。
 *
 * 可注入设计：confirm() 底层的"提问函数"可以被 cli.ts 替换。
 * 为什么？REPL 模式下主循环已经持有一个 readline 接口在监听键盘，
 * 如果这里再另开一个，两个监听者会抢输入、串行回显，一片混乱。
 * 所以 cli 启动时调用 setAskQuestion() 把自己的 readline 塞进来复用；
 * 一次性命令模式没有主 readline，就用默认实现（临时开一个）。
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { C } from './ui.js';

/** 底层提问函数签名：显示问题，等用户敲回车，返回用户输入 */
type AskFn = (question: string) => Promise<string>;

/** 默认实现：临时开一个 readline（一次性命令模式用） */
let askQuestion: AskFn = async (question) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close(); // 用完必须关掉，否则进程挂起不退出
  }
};

/** cli.ts 在 REPL 模式下注入自己的 readline，避免双监听冲突 */
export function setAskQuestion(fn: AskFn): void {
  askQuestion = fn;
}

/**
 * 整个确认流程的注入口（v0.2 新增）：注入后 confirm() 完全交给宿主处理。
 * 桌面端用它把权限请求变成 UI 弹窗（IPC 往返），终端不注入则走默认的
 * "画确认框 + readline 问询"流程。返回 true = 放行。
 */
let confirmHandler: ((req: PermissionRequest) => Promise<boolean>) | null = null;
export function setConfirmHandler(fn: (req: PermissionRequest) => Promise<boolean>): void {
  confirmHandler = fn;
}

/** 一次权限确认的入参 */
export interface PermissionRequest {
  /** 操作类别标题，如 "写入文件" / "执行命令" */
  title: string;
  /** 具体内容：命令原文，或写文件的内容预览 */
  detail: string;
  /** 目标路径（执行命令类操作时可省略） */
  target?: string;
}

/**
 * 请求用户批准一次危险操作。
 * @returns true = 放行；false = 用户拒绝（loop 层会把拒绝结果回传给模型）
 */
export async function confirm(req: PermissionRequest, yolo: boolean): Promise<boolean> {
  // YOLO 模式：跳过确认。给哪些人用？在容器/虚拟机里跑批任务的开发者。
  // 提示语必须醒目——用户需要知道此刻没有闸门。
  if (yolo) {
    console.log(C.yellow(`  ⚠ [YOLO] 自动放行：${req.title} → ${req.detail.slice(0, 100)}`));
    return true;
  }

  // 宿主注入了确认处理器（桌面端）：交给它，核心不关心呈现方式
  if (confirmHandler) {
    return confirmHandler(req);
  }

  // 确认框：视觉上和普通输出区分开，让用户的注意力停在关键信息上
  console.log('');
  console.log(C.yellow('  ┌─ 权限确认 ─────────────────────────────'));
  console.log(C.yellow(`  │ 操作: ${req.title}`));
  if (req.target) console.log(C.yellow(`  │ 目标: ${req.target}`));
  // detail 可能多行（比如要写入的文件内容），逐行加边框
  for (const line of req.detail.split('\n').slice(0, 20)) {
    console.log(C.yellow(`  │ ${line}`));
  }
  console.log(C.yellow('  └────────────────────────────────────────'));

  // 默认拒绝：直接回车或输入其他任何内容都不放行。
  // "默认拒绝"是安全系统的第一原则——误拒绝的代价是重试一次，误放行的代价可能是数据。
  const answer = await askQuestion(C.bold('  允许执行吗? [y/N] '));
  const allowed = answer.trim().toLowerCase() === 'y';
  console.log(C.gray(allowed ? '  ✓ 已放行' : '  ✗ 已拒绝'));
  return allowed;
}
