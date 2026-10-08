/**
 * self/commands.ts —— `nh self ...` 命令行入口
 *
 * 子命令：
 *   nh self run [选项]            运行一段自改进会话（默认在 nano/self/* 分支提交，等你审阅）
 *   nh self gate                  只跑一次质量闸门
 *   nh self journal [-n 10]       查看最近的自改进记录
 *   nh self backlog list          查看待办
 *   nh self backlog add "标题" [--hint "说明"]
 *                                投放一条改进任务（run 时优先做待办）
 *   nh self backlog done <id>     标记待办完成
 *   nh self stop                  急停：当前尝试收尾后不再开始新尝试
 *   nh self resume                清除急停标记
 *
 * run 选项：
 *   --attempts <n>        本次最多尝试次数（默认 3）
 *   --fix-rounds <n>      闸门失败后最多修复几轮（默认 2）
 *   --token-budget <n>    本会话 token 硬上限（默认 200000）
 *   --idle-limit <n>      连续多少次无改进就收工（默认 2）
 *   --interval <ms>       两次尝试间隔（默认 0）
 *   --integrate <mode>    branch（默认，只提交到 nano/self/*）| ff（快进合并进当前分支）
 *   --max-steps <n>       单个 agent 回合的步数上限（默认取配置、最多 20）
 *   --turn-continuations <n>  单轮到顶后自动带上下文续跑几轮（默认 1，0=不续跑，最多 5）
 */

import * as path from 'node:path';
import { loadConfig, isConfigUsable } from '../config.js';
import { SelfStore } from './store.js';
import { repoRoot, recentLog, currentBranch } from './git.js';
import { runGates, defaultGates } from './gate.js';
import { SelfSupervisor, type SupervisorEvent } from './supervisor.js';

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function intArg(args: string[], name: string, fallback: number, min: number, max: number): number {
  const raw = argValue(args, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} 需要是数字，收到：${raw}`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const HELP = `nano-harness 自改进守护进程

用法：
  nh self run [--attempts 3] [--fix-rounds 2] [--token-budget 200000]
              [--idle-limit 2] [--interval 0] [--integrate branch|ff]
              [--max-steps 20] [--turn-continuations 1]
  nh self gate
  nh self journal [-n 10]
  nh self backlog list
  nh self backlog add "改进标题" [--hint "补充说明"]
  nh self backlog done <id>
  nh self stop
  nh self resume

安全边界：只在干净的 git 仓库内工作；自动改动先过质量闸门才提交；
默认只提交到 nano/self/* 分支（不外联、不 push、不装依赖、不碰 main）。
`;

function onEvent(evt: SupervisorEvent): void {
  switch (evt.type) {
    case 'session_start':
      console.log(`\n▶ 自改进会话开始  仓库 ${evt.repo}  分支 ${evt.branch}  最多 ${evt.maxAttempts} 次尝试`);
      break;
    case 'attempt_start':
      console.log(`\n── 尝试 #${evt.attempt}｜${evt.baselineOk ? '基线通过' : '基线失败(需修绿)'}｜任务：${evt.taskTitle}`);
      break;
    case 'gate_result':
      console.log(`   闸门（修复轮次 ${evt.fixRound}）：${evt.ok ? '✅ 通过' : '❌ 失败'} — ${evt.summary}`);
      break;
    case 'turn_tokens':
      console.log(`   ↳ 本回合约 ${evt.tokens} tokens`);
      break;
    case 'attempt_end': {
      const r = evt.result;
      const icon = r.outcome === 'committed' ? '✅' : r.outcome === 'idle' ? '⚪' : '↩️';
      console.log(`   ${icon} ${r.outcome}｜${r.note}｜用时 ${(r.durationMs / 1000).toFixed(1)}s`);
      break;
    }
    case 'session_end': {
      const s = evt.summary;
      console.log(
        `\n■ 会话结束：尝试 ${s.attempts}，提交 ${s.committed}，回滚 ${s.rolledBack}，` +
        `空闲 ${s.idle}，累计约 ${s.tokens} tokens。原因：${s.stopReason}`,
      );
      break;
    }
    case 'info':
      console.log(`   ${evt.message}`);
      break;
  }
}

async function cmdRun(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!isConfigUsable(cfg)) {
    console.error('✗ 模型尚未配置。请先运行 nh 完成配置向导（或设置 base_url/api_key/model）。');
    return 2;
  }
  const workspace = path.resolve(process.cwd());
  const supervisor = new SelfSupervisor({
    workspace,
    cfg,
    maxAttempts: intArg(args, '--attempts', 3, 1, 50),
    maxFixRounds: intArg(args, '--fix-rounds', 2, 0, 10),
    maxTotalTokens: intArg(args, '--token-budget', 200_000, 1000, 100_000_000),
    maxConsecutiveIdle: intArg(args, '--idle-limit', 2, 1, 20),
    intervalMs: intArg(args, '--interval', 0, 0, 24 * 3600 * 1000),
    turnMaxSteps: intArg(args, '--max-steps', Math.min(cfg.maxSteps || 20, 20), 2, 40),
    turnContinuations: intArg(args, '--turn-continuations', 1, 0, 5),
    integrate: argValue(args, '--integrate') === 'ff' ? 'ff' : 'branch',
    onEvent,
  });
  const summary = await supervisor.run();
  // 基线/仓库/脏工作树等前置不满足时 attempts=0，返回非零以便脚本感知"没跑成"
  return summary.attempts > 0 ? 0 : 1;
}

async function cmdGate(): Promise<number> {
  const root = await repoRoot(process.cwd());
  const { ok, results } = await runGates(defaultGates(), root);
  for (const r of results) {
    console.log(`── ${r.label}：${r.ok ? '通过' : `失败（code=${r.code}${r.timedOut ? ', 超时' : ''}）`}`);
    if (!r.ok) console.log(r.output);
  }
  console.log(ok ? '\n闸门通过 ✅' : '\n闸门失败 ❌');
  return ok ? 0 : 1;
}

async function withStore<T>(fn: (store: SelfStore, root: string) => Promise<T>): Promise<T> {
  const root = await repoRoot(process.cwd());
  return fn(new SelfStore(root), root);
}

/** `nh self ...` 总入口，返回进程退出码 */
export async function runSelfCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return 0;

      case 'run':
        return await cmdRun(rest);

      case 'gate':
        return await cmdGate();

      case 'journal':
        return await withStore(async (store) => {
          const n = intArg(rest, '-n', 10, 1, 200);
          const entries = await store.tailJournal(n);
          if (entries.length === 0) { console.log('还没有自改进记录。先运行 nh self run。'); return 0; }
          for (const e of entries) {
            console.log(`[${e.ts}] #${e.attempt} ${e.outcome}｜${e.taskTitle}｜${e.note}`);
          }
          return 0;
        });

      case 'backlog': {
        const action = rest[0] ?? 'list';
        if (action === 'list') {
          return await withStore(async (store) => {
            const items = await store.listAllBacklog();
            const pending = items.filter((i) => i.status === 'pending');
            if (pending.length === 0) { console.log('待办为空——run 时会执行内置常青维护任务。'); return 0; }
            for (const i of pending) console.log(`${i.id}  ${i.title}${i.hint ? `\n    ↳ ${i.hint}` : ''}`);
            return 0;
          });
        }
        if (action === 'add') {
          const title = rest[1];
          if (!title) { console.error('用法：nh self backlog add "改进标题" [--hint "说明"]'); return 2; }
          return await withStore(async (store) => {
            const item = await store.addBacklog(title, argValue(rest, '--hint'));
            console.log(`已加入待办：${item.id}  ${item.title}`);
            return 0;
          });
        }
        if (action === 'done') {
          const id = rest[1];
          if (!id) { console.error('用法：nh self backlog done <id>'); return 2; }
          return await withStore(async (store) => {
            await store.checkoutBacklogItem(id, 'done');
            console.log(`已标记完成：${id}`);
            return 0;
          });
        }
        console.error(`未知 backlog 动作：${action}（可用 list/add/done）`);
        return 2;
      }

      case 'stop':
        return await withStore(async (store) => {
          await store.setStop(true);
          console.log('已设置急停标记（.nano-self/STOP）：当前尝试收尾后不再开始新尝试。');
          return 0;
        });

      case 'resume':
        return await withStore(async (store, root) => {
          await store.setStop(false);
          const branch = await currentBranch(root);
          const log = await recentLog(root, 3);
          console.log('已清除急停标记，可继续 nh self run。');
          console.log(`当前分支 ${branch}；最近提交：\n${log}`);
          return 0;
        });

      default:
        console.error(`未知子命令：${sub}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}
