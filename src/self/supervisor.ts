/**
 * self/supervisor.ts —— 自改进守护进程（主管）
 *
 * 它不是"让一个 agent while(true) 随便跑"，而是一个有预算、有验收、能回滚、可急停的
 * 回合制主管。每个"尝试（attempt）"是一次受控的小改进：
 *
 *   1. 前置安全：急停标记 / 预算 / 必须是 git 仓库且非 detached / 工作树必须干净
 *      （绝不把用户未提交的改动卷进自动提交）；
 *   2. 先跑闸门拿基线（绿 → 做一项小改进；红 → 唯一任务是修绿）；
 *   3. 从当前提交切出 nano/self/* 临时分支，在其上用【受限工具集】跑 agent 回合
 *      （无 bash、无网络、无装依赖、无提交工具）；
 *   4. 再跑闸门：失败就在限额内让 agent 修，仍失败 → 硬回滚到原提交、删临时分支；
 *   5. 通过且确有改动 → 由主管（而非模型）add + 本地提交；默认只留在 nano/self/*
 *      分支等你审阅（--integrate=ff 才会快进合并进当前分支，绝不产生合并提交）；
 *   6. 记 journal、更新累计统计；连续无改进或预算耗尽即收工。
 *
 * 运行器（runTurn / runGate）可注入：生产默认接 runAgentTurn 与 runGates，
 * 测试注入脚本化假运行器，从而无需真实模型/网络即可验证编排、回滚与预算逻辑。
 */

import type { HarnessConfig } from '../config.js';
import type { ChatMessage } from '../llm.js';
import type { Tool } from '../tools/index.js';
import { runAgentTurnWithContinuations, type AgentEvent } from '../loop.js';
import { runGates, defaultGates, type GateResult } from './gate.js';
import { buildSelfTools } from './self-tools.js';
import {
  SelfStore, DEFAULT_STATE,
  type SelfState, type JournalEntry, type BacklogItem, type AttemptOutcome,
} from './store.js';
import * as git from './git.js';

/** 自改进临时分支前缀（git.ts 的删除守卫也认这个前缀） */
const BRANCH_PREFIX = 'nano/self/';

export type IntegrateMode = 'branch' | 'ff';

/** 可注入的 agent 回合运行器（生产默认由 runAgentTurn 适配） */
export interface TurnRunner {
  (params: {
    task: string;
    systemPrompt: string;
    tools: Tool[];
    messages: ChatMessage[];
    workspace: string;
    cfg: HarnessConfig;
    maxSteps: number;
    /** 单轮撞 maxSteps 后最多自动续跑几轮（0=不续跑） */
    continuations: number;
  }): Promise<{ answer: string; tokens: number; steps: number; messages: ChatMessage[] }>;
}

/** 可注入的闸门运行器 */
export type GateRunner = () => Promise<{ ok: boolean; results: GateResult[] }>;

export interface SupervisorOptions {
  /** 要自改进的仓库目录（默认 process.cwd()） */
  workspace: string;
  cfg: HarnessConfig;
  /** 本次会话最多尝试几次 */
  maxAttempts: number;
  /** 闸门失败后，最多再让 agent 修复几轮 */
  maxFixRounds: number;
  /** 本会话 token 硬上限（所有回合累计；达到即收工） */
  maxTotalTokens: number;
  /** 连续"无有效改进"多少次后收工（防空转烧钱） */
  maxConsecutiveIdle: number;
  /** 单个 agent 回合的最大步数 */
  turnMaxSteps: number;
  /** 单个 agent 回合撞 turnMaxSteps 后最多自动续跑几轮（默认 1，避免半成品被回滚） */
  turnContinuations?: number;
  /** 提交去向：branch=只留在 nano/self/* 分支（默认、最稳）；ff=快进进当前分支 */
  integrate: IntegrateMode;
  /** 两次尝试之间的间隔（毫秒），0 表示不停 */
  intervalMs: number;
  /** 注入：agent 回合（测试用）；缺省接真实 runAgentTurn */
  runTurn?: TurnRunner;
  /** 注入：闸门（测试用）；缺省跑 npm run check */
  runGate?: GateRunner;
  /** 进度回调（CLI 打印 / 日志） */
  onEvent?: (evt: SupervisorEvent) => void;
}

export type SupervisorEvent =
  | { type: 'session_start'; repo: string; branch: string; maxAttempts: number }
  | { type: 'attempt_start'; attempt: number; baselineOk: boolean; taskTitle: string }
  | { type: 'turn_tokens'; tokens: number }
  | { type: 'gate_result'; ok: boolean; fixRound: number; summary: string }
  | { type: 'attempt_end'; result: AttemptResult }
  | { type: 'session_end'; summary: SessionSummary }
  | { type: 'info'; message: string };

export interface AttemptResult {
  outcome: AttemptOutcome;
  branch: string;
  tempBranch?: string;
  baseSha: string;
  commitSha?: string;
  tokens: number;
  steps: number;
  fixRounds: number;
  baselineOk: boolean;
  durationMs: number;
  taskTitle: string;
  answer: string;
  note: string;
}

export interface SessionSummary {
  attempts: number;
  committed: number;
  rolledBack: number;
  idle: number;
  tokens: number;
  stopReason: string;
  branches: string[];
}

/** 内置常青任务（backlog 为空时使用）：把"自由发挥"收敛成有边界的维护动作 */
const EVERGREEN_TASK = [
  '当前质量闸门已通过。请做且仅做一个小而完整、明确有价值的改进，候选方向（按优先级）：',
  '1) 为尚未覆盖的边界补一条自动化测试；',
  '2) 修复一个你通过阅读源码能确定存在的真实小缺陷；',
  '3) 消除一处明确的坏味道或重复代码。',
  '',
  '硬要求：先用 run_check 确认基线、用 read_file/list_dir 阅读相关代码；只做最小必要改动；',
  '改完必须再跑 run_check 且保持通过。禁止重构无关代码；禁止改 package.json / package-lock.json /',
  ' .github / CHANGELOG / 构建产物；禁止为了让检查通过而删除、跳过或弱化任何测试断言。',
  '如果没有任何安全、明确、能让闸门保持通过的改进可做，就【不要修改任何文件】，只回复 NO_SAFE_CHANGE。',
].join('\n');

const BASELINE_RED_TASK = (output: string) => [
  '当前项目的质量闸门【未通过】。你这一轮唯一的任务是定位并修复，使闸门恢复通过。',
  '要求：先读相关文件再做最小修复；可以反复调用 run_check 验证；',
  '严禁删除、跳过或弱化测试断言来"造绿"。',
  '如果确认无法在本轮安全修复，就不要留下任何半成品改动，并清楚说明卡点。',
  '',
  '—— 基线闸门输出（尾部）——',
  output.slice(-8000),
].join('\n');

const FIX_TASK = (round: number, output: string) => [
  `质量闸门仍未通过（这是第 ${round} 次修复尝试）。请根据下面的输出继续修复，仍不得降低测试标准。`,
  '',
  '—— 闸门输出（尾部）——',
  output.slice(-8000),
].join('\n');

const SYSTEM_PROMPT = (ws: string) => [
  '你是 nano-harness 的自改进智能体，在无人值守下改进【当前这个仓库本身】。',
  `仓库根目录：${ws}`,
  '',
  '铁律：',
  '1. 能力边界：你只能读写仓库内源码/测试、运行系统固定的 run_check、只读查看 git_status。',
  '   你没有 shell、不能联网、不能安装依赖、不能执行 git 提交（提交由主管在闸门通过后代劳）。',
  '2. 每个回合只做一个小而完整、可独立验收的改动；最小 diff，不碰无关代码。',
  '3. 先读后改；改前改后都运行 run_check；只有在 run_check 通过时才算完成。',
  '4. 绝不通过删除/跳过/弱化测试来让闸门变绿；测试只能朝"更准确覆盖真实行为"的方向增强。',
  '5. 不修改 package.json、package-lock.json、.github 工作流、CHANGELOG，以及 dist/node_modules/.git/.nano-self 等目录。',
  '6. 没有安全可做的改进时，宁可不改（回复 NO_SAFE_CHANGE），也不要制造无意义 churn。',
  '7. 完成后用简体中文简述：改了什么、为什么、run_check 结果如何。',
].join('\n');

/** 生产默认回合运行器：把 runAgentTurnWithContinuations 适配成 TurnRunner，并统计 token 与步数 */
export const defaultTurnRunner: TurnRunner = async ({ task, systemPrompt, tools, messages, workspace, cfg, maxSteps, continuations }) => {
  let tokens = 0;
  let steps = 0;
  let segBase = 0;   // 已结束续跑段累计的步数
  let segMax = 0;    // 当前段内走到的最大步号
  const { answer, messages: out } = await runAgentTurnWithContinuations(messages, task, {
    cfg: { ...cfg, maxSteps },
    workspace,
    yolo: true, // 受限工具集本身只读/固定闸门，无人值守自动放行
    tools,
    systemPrompt,
    maxContinuations: continuations,
    onEvent: (evt: AgentEvent) => {
      if (evt.type === 'usage' && typeof evt.tokens === 'number') tokens += evt.tokens;
      if (evt.type === 'thinking_start') {
        segMax = Math.max(segMax, evt.step);
        steps = segBase + segMax;
      }
      // 进入下一段续跑：把上一段的步数结转，段内计数清零
      if (evt.type === 'continuation') { segBase += segMax; segMax = 0; steps = segBase; }
    },
  });
  return { answer, tokens, steps, messages: out };
};

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 从 agent 的最终回答里提炼一行提交标题（模型不直接写提交信息，注入风险更低） */
function commitTitle(taskTitle: string, answer: string): string {
  const cleaned = (answer || '')
    .replace(/NO_SAFE_CHANGE/gi, '')
    .split('\n').map((l) => l.replace(/^[#\-*\s\d.、）)]+/, '').trim())
    .find((l) => l.length >= 4);
  const title = (cleaned || taskTitle || 'self improvement').replace(/[`\n\r]/g, ' ').slice(0, 72);
  return `chore(self): ${title}`;
}

export class SelfSupervisor {
  private opts: Required<Omit<SupervisorOptions, 'runTurn' | 'runGate' | 'onEvent'>> & {
    runTurn: TurnRunner; runGate: GateRunner; onEvent: (e: SupervisorEvent) => void;
  };
  private store!: SelfStore;
  private repo = '';
  private originalBranch = '';
  private tools: Tool[] = [];
  private gateRunner!: GateRunner;
  private state: SelfState = { ...DEFAULT_STATE };
  private userGate?: GateRunner;

  constructor(opts: SupervisorOptions) {
    this.userGate = opts.runGate;
    this.opts = {
      workspace: opts.workspace,
      cfg: opts.cfg,
      maxAttempts: opts.maxAttempts,
      maxFixRounds: opts.maxFixRounds,
      maxTotalTokens: opts.maxTotalTokens,
      maxConsecutiveIdle: opts.maxConsecutiveIdle,
      turnMaxSteps: opts.turnMaxSteps,
      turnContinuations: opts.turnContinuations ?? 1,
      integrate: opts.integrate,
      intervalMs: opts.intervalMs,
      runTurn: opts.runTurn ?? defaultTurnRunner,
      runGate: opts.runGate ?? (() => runGates(defaultGates(), opts.workspace)),
      onEvent: opts.onEvent ?? (() => {}),
    };
  }

  private emit(evt: SupervisorEvent): void { this.opts.onEvent(evt); }

  /** 跑一整段自改进会话（1..maxAttempts 次尝试），返回汇总 */
  async run(): Promise<SessionSummary> {
    const summary: SessionSummary = {
      attempts: 0, committed: 0, rolledBack: 0, idle: 0, tokens: 0,
      stopReason: '', branches: [],
    };

    // —— 会话级前置检查（任一不满足直接收工，不做任何改动）——
    try {
      this.repo = await git.repoRoot(this.opts.workspace);
      this.originalBranch = await git.currentBranch(this.repo);
    } catch (err) {
      summary.stopReason = (err as Error).message;
      this.emit({ type: 'session_end', summary });
      return summary;
    }

    this.store = new SelfStore(this.repo);
    await this.store.ensure();
    // 默认闸门固定在仓库根运行（workspace 可能是个子目录）
    this.gateRunner = this.userGate ?? (() => runGates(defaultGates(), this.repo));
    // 状态目录本地忽略：既不进 status，也不会被 add -A 误提交
    await git.excludeLocally(this.repo, ['.nano-self/']);

    if (await this.store.isStopRequested()) {
      summary.stopReason = '检测到急停标记（.nano-self/STOP），未开始。可用 `nh self resume` 清除后继续。';
      this.emit({ type: 'session_end', summary });
      return summary;
    }
    if (await git.hasChanges(this.repo)) {
      summary.stopReason = '工作树存在未提交改动。为避免把你的在制工作卷入自动提交，请先提交或 stash 后再运行。';
      this.emit({ type: 'session_end', summary });
      return summary;
    }

    this.state = await this.store.readState();
    this.tools = buildSelfTools({
      runCheck: async () => {
        const r = await this.gateRunner();
        const last = r.results[r.results.length - 1];
        return { ok: r.ok, text: last ? last.output : '(无闸门输出)' };
      },
      gitStatus: async () => {
        const [branch, status, log] = await Promise.all([
          git.currentBranch(this.repo),
          git.runStatusPorcelain(this.repo),
          git.recentLog(this.repo, 5),
        ]);
        return [`分支：${branch}`, '改动：', status.trim() || '(干净)', '', '最近提交：', log || '(无)'].join('\n');
      },
    });

    this.emit({ type: 'session_start', repo: this.repo, branch: this.originalBranch, maxAttempts: this.opts.maxAttempts });

    for (let i = 1; i <= this.opts.maxAttempts; i++) {
      if (await this.store.isStopRequested()) { summary.stopReason = '收到急停（STOP 标记）'; break; }
      if (this.state.totalTokens >= this.opts.maxTotalTokens) { summary.stopReason = '达到 token 预算上限'; break; }

      const result = await this.attempt(i);
      summary.attempts += 1;
      summary.tokens += result.tokens;
      summary.branches.push(result.branch);
      if (result.outcome === 'committed') summary.committed += 1;
      else if (result.outcome === 'rolled_back' || result.outcome === 'baseline_red_wait') summary.rolledBack += 1;
      else summary.idle += 1;

      this.emit({ type: 'attempt_end', result });

      if (this.state.consecutiveIdle >= this.opts.maxConsecutiveIdle) {
        summary.stopReason = `连续 ${this.state.consecutiveIdle} 次无有效改进，自动收工（避免空转）`;
        break;
      }
      if (i < this.opts.maxAttempts && this.opts.intervalMs > 0) {
        if (!(await this.sleepInterruptible(this.opts.intervalMs))) { summary.stopReason = '间隔期间收到急停'; break; }
      }
    }

    if (!summary.stopReason) summary.stopReason = summary.attempts >= this.opts.maxAttempts ? '已达本次尝试次数上限' : '正常结束';
    this.emit({ type: 'session_end', summary });
    return summary;
  }

  /** 单次尝试 */
  private async attempt(attemptNo: number): Promise<AttemptResult> {
    const started = Date.now();
    const baseSha = await git.headSha(this.repo);
    const tempBranch = `${BRANCH_PREFIX}${nowStamp()}-${Math.random().toString(36).slice(2, 7)}`;

    // 每次尝试前都要求工作树干净（上一轮应已收尾），否则中止
    if (await git.hasChanges(this.repo)) {
      return this.mkAttempt('idle', baseSha, 0, 0, 0, true, '中止', '', '工作树不干净，跳过本次尝试', 0);
    }

    // 1) 基线闸门
    const baseline = await this.gateRunner();
    const baselineOk = baseline.ok;
    const baselineOutput = baseline.results[baseline.results.length - 1]?.output ?? '';
    this.emit({ type: 'gate_result', ok: baselineOk, fixRound: 0, summary: baselineOk ? '基线闸门通过' : '基线闸门失败' });

    // 2) 选任务：优先 backlog 队首；基线红时任务强制为"修绿"
    const backlog: BacklogItem[] = await this.store.readBacklog();
    const item = baselineOk ? backlog[0] : undefined;
    const taskTitle = baselineOk
      ? (item ? item.title : '常青维护：一项小改进')
      : '修复基线闸门';
    const firstTask = baselineOk
      ? (item ? `${item.title}${item.hint ? `\n\n补充说明：${item.hint}` : ''}\n\n${EVERGREEN_TASK}` : EVERGREEN_TASK)
      : BASELINE_RED_TASK(baselineOutput);

    this.emit({ type: 'attempt_start', attempt: attemptNo, baselineOk, taskTitle });

    // 3) 切临时分支
    await git.checkoutNewBranch(this.repo, tempBranch);

    let tokens = 0;
    let steps = 0;
    let fixRounds = 0;
    let answer = '';
    const messages: ChatMessage[] = [];
    let changed = false;
    let gate = baseline;

    try {
      // 首个 agent 回合
      const r1 = await this.opts.runTurn({
        task: firstTask, systemPrompt: SYSTEM_PROMPT(this.repo), tools: this.tools,
        messages, workspace: this.repo, cfg: this.opts.cfg, maxSteps: this.opts.turnMaxSteps,
        continuations: this.opts.turnContinuations ?? 1,
      });
      tokens += r1.tokens; steps = r1.steps; answer = r1.answer;
      this.emit({ type: 'turn_tokens', tokens: r1.tokens });

      changed = await git.hasChanges(this.repo);
      gate = await this.gateRunner();
      this.emit({ type: 'gate_result', ok: gate.ok, fixRound: 0, summary: gate.ok ? '改动后闸门通过' : '改动后闸门失败' });

      // 4) 失败限额内修复（沿用同一对话历史，让模型看到自己刚改了什么）
      while (!gate.ok && fixRounds < this.opts.maxFixRounds) {
        fixRounds += 1;
        const out = gate.results[gate.results.length - 1]?.output ?? '';
        const rf = await this.opts.runTurn({
          task: FIX_TASK(fixRounds, out), systemPrompt: SYSTEM_PROMPT(this.repo), tools: this.tools,
          messages, workspace: this.repo, cfg: this.opts.cfg, maxSteps: this.opts.turnMaxSteps,
          continuations: this.opts.turnContinuations ?? 1,
        });
        tokens += rf.tokens; steps += rf.steps; answer = rf.answer;
        this.emit({ type: 'turn_tokens', tokens: rf.tokens });
        changed = await git.hasChanges(this.repo);
        gate = await this.gateRunner();
        this.emit({ type: 'gate_result', ok: gate.ok, fixRound: fixRounds, summary: gate.ok ? `第 ${fixRounds} 轮修复后通过` : `第 ${fixRounds} 轮修复后仍失败` });
      }

      // 5) 判定与收尾
      const durationMs = Date.now() - started;
      if (gate.ok && changed) {
        await git.addAll(this.repo);
        const message = commitTitle(taskTitle, answer);
        let commitSha: string | undefined;
        if (await git.hasStagedChanges(this.repo)) {
          await git.commit(this.repo, `${message}\n\n由 nano-harness 自改进守护进程自动生成（闸门通过）。`);
          commitSha = await git.headSha(this.repo);
        }
        // 回到用户原分支
        await git.checkout(this.repo, this.originalBranch);
        let integrated = false;
        if (this.opts.integrate === 'ff' && commitSha) {
          integrated = await git.mergeFfOnly(this.repo, tempBranch);
          if (integrated) await git.deleteSelfBranch(this.repo, tempBranch);
        }
        if (item) await this.store.checkoutBacklogItem(item.id, 'done');
        this.bumpState(tokens, true);
        const note = commitSha
          ? (integrated ? `已提交并快进合并到 ${this.originalBranch}` : `已提交到 ${tempBranch}（未合并，等待审阅）`)
          : '闸门通过但无实质改动';
        return this.mkAttempt('committed', baseSha, tokens, steps, fixRounds, baselineOk, taskTitle, answer, note, durationMs, tempBranch, commitSha);
      }

      // 闸门仍失败，或模型什么都没改 → 回滚临时分支
      const outcome: AttemptOutcome = !changed ? 'idle' : (baselineOk ? 'rolled_back' : 'baseline_red_wait');
      const note = !changed
        ? '模型未做出任何改动'
        : `闸门${gate.ok ? '' : '未'}通过，已硬回滚到 ${baseSha.slice(0, 8)} 并删除临时分支`;
      await git.hardReset(this.repo, baseSha);
      // reset --hard 不删未跟踪文件：清掉本次尝试新建的文件（遵守 ignore，
      // 不碰 node_modules / .nano-self），保证回到尝试前的干净状态。
      await git.cleanUntracked(this.repo);
      await git.checkout(this.repo, this.originalBranch);
      await git.deleteSelfBranch(this.repo, tempBranch);
      this.bumpState(tokens, false);
      return this.mkAttempt(outcome, baseSha, tokens, steps, fixRounds, baselineOk, taskTitle, answer, note, durationMs, tempBranch);
    } catch (err) {
      // agent/闸门本身抛异常（不是测试失败，而是基础设施错误）：尽量回到干净状态
      const durationMs = Date.now() - started;
      try {
        if (await git.hasChanges(this.repo)) await git.hardReset(this.repo, baseSha);
        await git.cleanUntracked(this.repo);
        const cur = await git.currentBranch(this.repo);
        if (cur !== this.originalBranch) await git.checkout(this.repo, this.originalBranch);
        await git.deleteSelfBranch(this.repo, tempBranch);
      } catch { /* 回滚尽力而为 */ }
      this.bumpState(tokens, false);
      return this.mkAttempt('rolled_back', baseSha, tokens, steps, fixRounds, baselineOk, taskTitle, answer,
        `发生异常并已回滚：${(err as Error).message}`, durationMs, tempBranch);
    }
  }

  private mkAttempt(
    outcome: AttemptOutcome, baseSha: string, tokens: number, steps: number, fixRounds: number,
    baselineOk: boolean, taskTitle: string, answer: string, note: string, durationMs: number,
    tempBranch?: string, commitSha?: string,
  ): AttemptResult {
    const entry: JournalEntry = {
      ts: new Date().toISOString(), attempt: this.state.totalAttempts + 1, outcome,
      branch: this.originalBranch, baseSha, commitSha, tokens, steps, baselineOk, fixRounds,
      durationMs, taskTitle, note,
    };
    void this.store.appendJournal(entry);
    return {
      outcome, branch: this.originalBranch, tempBranch, baseSha, commitSha,
      tokens, steps, fixRounds, baselineOk, durationMs, taskTitle, answer, note,
    };
  }

  /** 更新累计统计：成功清零连续空闲计数，失败/空闲累加 */
  private bumpState(tokens: number, success: boolean): void {
    this.state.totalAttempts += 1;
    this.state.totalTokens += tokens;
    this.state.totalCommits += success ? 1 : 0;
    this.state.consecutiveIdle = success ? 0 : this.state.consecutiveIdle + 1;
    void this.store.writeState(this.state);
  }

  /** 可被 STOP 标记打断的睡眠；返回 false 表示被急停打断 */
  private async sleepInterruptible(ms: number): Promise<boolean> {
    const step = 500;
    let waited = 0;
    while (waited < ms) {
      await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      waited += step;
      if (await this.store.isStopRequested()) return false;
    }
    return true;
  }
}
