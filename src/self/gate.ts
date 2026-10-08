/**
 * self/gate.ts —— 质量闸门运行器
 *
 * "闸门"是自改进循环的唯一验收标准：一次改动只有让项目的自动化质量检查保持/恢复
 * 通过，才允许被保留并提交。关键约束：
 *   - 闸门命令是**主管（supervisor）配置里写死的 argv**，模型只能读到结果、
 *     不能指定要跑什么命令——所以它无法借"跑测试"之名执行任意 shell。
 *   - 默认闸门 `npm run check` = 三端类型检查 + 构建 + 全部 node:test 用例。
 *   - 用 execFile 直接跑可执行文件（不过 shell），带超时与输出上限。
 *   - 不跑 `npm install`：默认闸门不需要联网，从根上排除"自改进时装进来历不明依赖"。
 */

import { execFile } from 'node:child_process';

export interface GateStep {
  id: string;
  label: string;
  /** argv 形式的固定命令，例如 ['npm','run','check'] */
  argv: string[];
  timeoutMs: number;
}

export interface GateResult {
  id: string;
  label: string;
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** 合并后的输出（已截断），回传给模型用于定位失败 */
  output: string;
}

/** 单次闸门输出给模型的最大字符数（失败堆栈可能很长，避免撑爆上下文） */
const MAX_GATE_OUTPUT = 30_000;

/** 跨平台选择 npm 可执行文件名 */
function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** 默认闸门：与项目发布前手动跑的 `npm run check` 完全一致 */
export function defaultGates(timeoutMs = 300_000): GateStep[] {
  return [
    { id: 'check', label: 'npm run check（类型检查 + 构建 + 全部测试）', argv: [npmBin(), 'run', 'check'], timeoutMs },
  ];
}

function runOne(step: Step, cwd: string): Promise<GateResult> {
  const [bin, ...args] = step.argv;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        cwd,
        timeout: step.timeoutMs,
        // 闸门需要 PATH（找 node/npm/tsc）；关掉交互式 git 凭据提示
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: process.env.CI ?? '1', FORCE_COLOR: '0' },
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const raw = `${stdout ?? ''}${stderr ?? ''}`;
        const output = raw.length > MAX_GATE_OUTPUT
          ? raw.slice(0, MAX_GATE_OUTPUT) + `\n[闸门输出过长，已截断：原文共 ${raw.length} 字符]`
          : raw;
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string } | null;
        const timedOut = Boolean(e && (e.killed || e.signal === 'SIGTERM' || /ETIMEDOUT|timed out/i.test(e.message)));
        const code = typeof e?.code === 'number' ? e.code : (e ? null : 0);
        resolve({
          id: step.id, label: step.label,
          ok: !err, code, timedOut, durationMs,
          output: timedOut ? `${output}\n[闸门超时（${step.timeoutMs}ms），已终止]` : output,
        });
      },
    );
    child.on('error', () => { /* execFile 回调仍会触发，避免重复 resolve */ });
  });
}

type Step = GateStep;

/**
 * 依次运行闸门；任一步失败即短路返回（后续步骤不再跑）。
 * 全部通过返回最后一步结果（ok=true）。
 */
export async function runGates(steps: GateStep[], cwd: string): Promise<{ ok: boolean; results: GateResult[] }> {
  const results: GateResult[] = [];
  for (const step of steps) {
    const r = await runOne(step, cwd);
    results.push(r);
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}
