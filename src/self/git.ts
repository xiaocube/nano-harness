/**
 * self/git.ts —— 自改进守护进程专用的"只读 + 本地提交"git 包装
 *
 * 设计原则（对应"只本地提交，不外联"的授权边界）：
 *   1. 全部用 execFile 传 argv 数组，绝不经过 shell——模型/提交信息里的
 *      `$(...)`、`; rm -rf` 都只是普通字符串，无法注入执行。
 *   2. 只暴露少数白名单子命令；push/pull/fetch/clone 等会联网或改写远端的动词
 *      根本不实现，并在统一入口再拦一道（纵深防御）。
 *   3. 自动模式没有配置 user.name/user.email 也能提交：用 -c 注入仅本次生效的身份，
 *      不改用户的全局 git 配置。
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';

/** 允许出现的 git 子命令（其余一律拒绝） */
const ALLOWED_SUBCOMMANDS = new Set([
  'rev-parse', 'status', 'branch', 'checkout', 'add', 'commit', 'reset', 'log', 'merge',
]);

/** 明确禁止、见到即拒的子命令（联网 / 远端 / 不可逆历史改写） */
const FORBIDDEN_SUBCOMMANDS = new Set([
  'push', 'pull', 'fetch', 'clone', 'submodule', 'clean',
]);

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // 子命令是跳过前导全局选项后第一个普通参数。目前只会用 `-c key=value`
    //（自动提交用它注入一次性身份）；遇到 -c 要连它的值一起跳过，
    // 否则会把 'user.name=...' 误判成子命令而拒绝。
    let sub: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c') { i += 1; continue; }
      sub = args[i];
      break;
    }
    if (!sub) {
      reject(new Error('git 调用缺少子命令'));
      return;
    }
    if (FORBIDDEN_SUBCOMMANDS.has(sub)) {
      reject(new Error(`自改进模式禁止执行 git ${sub}（不允许联网或操作远端）`));
      return;
    }
    if (!ALLOWED_SUBCOMMANDS.has(sub)) {
      reject(new Error(`git ${sub} 不在自改进模式的白名单内`));
      return;
    }
    // 关闭凭据助手与交互提示：即便误传了需要网络的参数，也应直接失败而不是挂起等输入
    execFile(
      'git',
      ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd,
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: string | number; signal?: string }).code;
          if (typeof code === 'number') {
            // git 用非零退出码表达"无内容可提交/引用不存在"等正常分支：交回调用方判断
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
            return;
          }
          // 被信号杀死（超时）或根本没启动起来（ENOENT）才是真异常
          reject(new Error(`git ${sub} 执行失败：${err.message}${stderr ? `\n${stderr}` : ''}`));
          return;
        }
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** 自动提交用的一次性身份（仅对本次 git 进程生效，不写全局配置） */
const IDENTITY = ['-c', 'user.name=nano-harness[bot]', '-c', 'user.email=bot@nano-harness.local'];

/** 断言 cwd 位于一个 git 工作树内，返回仓库根（top-level）绝对路径 */
export async function repoRoot(cwd: string): Promise<string> {
  const r = await run(['rev-parse', '--show-toplevel'], cwd);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error('当前目录不是一个 git 仓库（自改进模式只在 git 仓库内工作）');
  }
  return path.resolve(r.stdout.trim());
}

/** 当前分支名（detached HEAD 时抛错——自改进不允许在 detached 状态下动手） */
export async function currentBranch(cwd: string): Promise<string> {
  const r = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const name = r.stdout.trim();
  if (r.code !== 0 || !name || name === 'HEAD') {
    throw new Error('当前处于 detached HEAD 状态，请先切到一个分支再运行自改进');
  }
  return name;
}

/** 当前完整提交 SHA */
export async function headSha(cwd: string): Promise<string> {
  const r = await run(['rev-parse', 'HEAD'], cwd);
  if (r.code !== 0) throw new Error('无法读取 HEAD（仓库是否还没有任何提交？）');
  return r.stdout.trim();
}

/** 工作树（含未跟踪文件、不含 ignored）是否有改动 */
export async function hasChanges(cwd: string): Promise<boolean> {
  const text = await runStatusPorcelain(cwd);
  return text.split('\n').some((l) => l.trim().length > 0);
}

/** `git status --porcelain` 原文（供只读 git_status 工具展示） */
export async function runStatusPorcelain(cwd: string): Promise<string> {
  const r = await run(['status', '--porcelain', '--untracked-files=all'], cwd);
  return r.stdout;
}

/** 分支是否存在 */
export async function branchExists(cwd: string, name: string): Promise<boolean> {
  const r = await run(['rev-parse', '--verify', '--quiet', name], cwd);
  return r.code === 0;
}

/** 切换到已存在的分支 */
export async function checkout(cwd: string, ref: string): Promise<void> {
  const r = await run(['checkout', ref], cwd);
  if (r.code !== 0) throw new Error(`切换到 ${ref} 失败：${r.stderr || r.stdout}`);
}

/** 创建并切换到新分支（基于当前 HEAD） */
export async function checkoutNewBranch(cwd: string, name: string): Promise<void> {
  const r = await run(['checkout', '-b', name], cwd);
  if (r.code !== 0) throw new Error(`创建分支 ${name} 失败：${r.stderr || r.stdout}`);
}

/** 暂存工作树内全部改动（含新增；不含 ignored） */
export async function addAll(cwd: string): Promise<void> {
  const r = await run(['add', '-A', '--', '.'], cwd);
  if (r.code !== 0) throw new Error(`git add 失败：${r.stderr || r.stdout}`);
}

/** 已暂存内容是否为空（用于区分"模型其实什么都没改"） */
export async function hasStagedChanges(cwd: string): Promise<boolean> {
  const r = await run(['status', '--porcelain', '--untracked-files=all'], cwd);
  // 已 git add 的条目状态码以 A/M/D/R/C 起头（第一列非空且非空格/??）
  return r.stdout.split('\n').some((l) => l.length > 0 && l[0] !== ' ' && l[0] !== '?' && l[0] !== '!');
}

/** 用机器人身份提交已暂存内容；无暂存内容时返回 false */
export async function commit(cwd: string, message: string, amend = false): Promise<boolean> {
  const args = [...IDENTITY, 'commit'];
  if (amend) args.push('--amend');
  args.push('-m', message);
  const r = await run(args, cwd);
  if (r.code !== 0) {
    const combined = r.stdout + r.stderr;
    if (/nothing to commit|no changes added/i.test(combined)) return false;
    throw new Error(`git commit 失败：${r.stderr || r.stdout}`);
  }
  return true;
}

/** 硬重置到指定提交（回滚一次失败尝试：该提交带入的改动与新增文件一并还原） */
export async function hardReset(cwd: string, ref: string): Promise<void> {
  const r = await run(['reset', '--hard', ref], cwd);
  if (r.code !== 0) throw new Error(`回滚到 ${ref} 失败：${r.stderr || r.stdout}`);
}

/**
 * 删除未跟踪的文件/目录（回滚流程专用）。
 *
 * 为什么需要它：`git reset --hard` 只还原"被跟踪"文件，agent 新建的文件是未跟踪的，
 * 重置后仍然残留在工作树里，下一轮会被误当成"已有改动"或被 add 进别的提交。
 *
 * 安全约束：
 *   - argv 固定，调用方无法附加任意 clean 标志；
 *   - 不加 -x/-X：严格遵守 .gitignore 与 .git/info/exclude，因此 node_modules、
 *     .nano-self 等被忽略的目录绝不会被删；
 *   - 用 `-- .` 把范围限定在仓库根；
 *   - 仅在"该尝试开始时工作树已被断言为干净"的回滚路径调用，故清掉的只能是本次产物。
 */
export async function cleanUntracked(cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      'git',
      ['clean', '-f', '-d', '-e', '.nano-self/', '--', '.'],
      { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err) => {
        if (err && typeof (err as NodeJS.ErrnoException & { code?: string | number }).code !== 'number') {
          reject(new Error(`清理未跟踪文件失败：${err.message}`));
          return;
        }
        resolve(); // 非零（例如没有可清理内容）不视为错误
      },
    );
  });
}

/**
 * 删除一个自改进临时分支（强删）。仅允许删除 nano/self/ 前缀的分支，
 * 避免 supervisor 的逻辑错误或模型影响误删用户分支；删除前应已 reset/checkout。
 */
export async function deleteSelfBranch(cwd: string, name: string): Promise<void> {
  if (!name.startsWith('nano/self/')) {
    throw new Error(`拒绝删除非自改进临时分支：${name}`);
  }
  const r = await run(['branch', '-D', name], cwd);
  if (r.code !== 0) throw new Error(`删除临时分支 ${name} 失败：${r.stderr || r.stdout}`);
}

/** 快进合并自改进分支到当前分支（只允许 --ff-only，绝不产生合并提交或改写历史） */
export async function mergeFfOnly(cwd: string, branch: string): Promise<boolean> {
  const r = await run(['merge', '--ff-only', '--no-edit', branch], cwd);
  if (r.code !== 0) return false; // 非快进（例如中途有别的提交）→ 不强行合并，交回人工
  return true;
}

/** 最近若干条提交的单行摘要（供 status/日志展示） */
export async function recentLog(cwd: string, n: number): Promise<string> {
  const r = await run(['log', `-${String(n)}`, '--oneline', '--no-decorate'], cwd);
  return r.stdout.trim();
}

/** 把若干路径加入本地 .git/info/exclude（不改被版本管理的 .gitignore） */
export async function excludeLocally(cwd: string, entries: string[]): Promise<void> {
  const fs = await import('node:fs/promises');
  const root = await repoRoot(cwd);
  const excludeFile = path.join(root, '.git', 'info', 'exclude');
  let current = '';
  try { current = await fs.readFile(excludeFile, 'utf8'); } catch { /* 尚不存在 */ }
  const have = new Set(current.split('\n'));
  const add = entries.filter((e) => !have.has(e));
  if (add.length === 0) return;
  const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  await fs.appendFile(excludeFile, `${prefix}${add.join('\n')}\n`, 'utf8');
}
