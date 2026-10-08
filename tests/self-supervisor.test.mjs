/**
 * tests/self-supervisor.test.mjs —— 自改进守护进程编排与安全
 *
 * 不接真实模型/网络：注入脚本化的"假回合运行器"（直接调用受限工具写文件，
 * 连受限工具集一并验证）与"假闸门"（按调用次序脚本化通过/失败）。
 * 所有操作都在临时 git 仓库里进行，验证：提交到 nano/self/*、失败硬回滚、
 * 快进合并、无改动空闲、预算/急停/脏工作树收工、禁写 .git / node_modules。
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, cleanupHome } from './helpers/env.mjs';

const home = isolateHome('nh-self-');
const { SelfSupervisor } = await import('../dist/self/supervisor.js');
const { buildSelfTools } = await import('../dist/self/self-tools.js');
const { SelfStore, STOP_FILE } = await import('../dist/self/store.js');
const gitSafe = await import('../dist/self/git.js');

const CFG = { baseUrl: '', apiKey: '', model: 'm', maxSteps: 5, contextChars: 1000, yolo: true };
const dirs = [];

after(() => {
  cleanupHome(home);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 在临时目录建一个带初始提交的 git 仓库（默认分支 main） */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'nh-self-repo-'));
  dirs.push(dir);
  const g = (args) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  g(['init', '-q']);
  g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return { dir, g };
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}
function branches(dir) {
  return git(dir, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean);
}
function countCommits(dir, ref) {
  return git(dir, ['rev-list', '--count', ref]);
}

/**
 * 造一个假回合运行器。
 * @param behavior 'change' 每次回合都写一个文件；'fix' 首回合写坏、之后写修；
 *                 'idle' 什么都不改
 */
function fakeTurn(behavior, { tokensPerTurn = 100 } = {}) {
  let call = 0;
  return async ({ tools, workspace, cfg }) => {
    call += 1;
    const write = tools.find((t) => t.name === 'write_file');
    const ctx = { workspace, cfg };
    if (behavior === 'change') {
      await write.execute({ path: `improve-${call}.txt`, content: `improvement round ${call}` }, ctx);
    } else if (behavior === 'fix') {
      if (call === 1) await write.execute({ path: 'work.txt', content: 'first cut' }, ctx);
      else await write.execute({ path: 'work.txt', content: 'fixed cut' }, ctx);
    }
    // idle：不动文件
    return { answer: behavior === 'idle' ? 'NO_SAFE_CHANGE' : '增加了一个改进文件并补了说明', tokens: tokensPerTurn, steps: 3, messages: [] };
  };
}

/** 按调用次序返回闸门结果的假闸门（true=通过） */
function scriptedGate(seq) {
  let i = 0;
  return async () => {
    const ok = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return { ok, results: [{ id: 'check', label: 'fake', ok, code: ok ? 0 : 1, timedOut: false, durationMs: 1, output: ok ? 'ok' : 'FAILURE-DETAIL' }] };
  };
}

function runOn(dir, opts) {
  return new SelfSupervisor({
    workspace: dir, cfg: CFG,
    maxAttempts: 1, maxFixRounds: 2, maxTotalTokens: 1_000_000,
    maxConsecutiveIdle: 5, turnMaxSteps: 5, integrate: 'branch', intervalMs: 0,
    ...opts,
  }).run();
}

describe('self: 成功路径', () => {
  test('基线绿→改动→闸门通过：提交到 nano/self/*，main 不动，工作树干净', async () => {
    const { dir } = makeRepo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const s = await runOn(dir, { runTurn: fakeTurn('change'), runGate: scriptedGate([true, true]) });
    assert.equal(s.attempts, 1);
    assert.equal(s.committed, 1);
    assert.equal(s.rolledBack, 0);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, '默认 integrate=branch：main 不应前进');
    const selfBranches = branches(dir).filter((b) => b.startsWith('nano/self/'));
    assert.equal(selfBranches.length, 1);
    assert.equal(countCommits(dir, selfBranches[0]), '2', '临时分支上应有 init + 自动提交');
    assert.equal(git(dir, ['status', '--porcelain']), '', '工作树必须干净（状态目录已本地忽略）');
    assert.match(git(dir, ['log', '-1', '--format=%s', selfBranches[0]]), /^chore\(self\):/);
  });

  test('integrate=ff：自动提交快进进 main，临时分支删除', async () => {
    const { dir } = makeRepo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const s = await runOn(dir, { integrate: 'ff', runTurn: fakeTurn('change'), runGate: scriptedGate([true, true]) });
    assert.equal(s.committed, 1);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), base, 'main 应快进到新提交');
    assert.equal(branches(dir).filter((b) => b.startsWith('nano/self/')).length, 0, '临时分支已删除');
    assert.equal(countCommits(dir, 'main'), '2');
  });

  test('失败后在限额内修绿：记为 committed，fixRounds=1', async () => {
    const { dir } = makeRepo();
    // 序列：基线 true，首改后 false，第1轮修复后 true
    const s = await runOn(dir, {
      maxFixRounds: 2,
      runTurn: fakeTurn('fix'),
      runGate: scriptedGate([true, false, true]),
    });
    assert.equal(s.committed, 1);
    assert.equal(s.rolledBack, 0);
  });
});

describe('self: 回滚与空闲', () => {
  test('闸门一直失败 → 硬回滚、删临时分支、无新提交', async () => {
    const { dir } = makeRepo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const s = await runOn(dir, { maxFixRounds: 1, runTurn: fakeTurn('fix'), runGate: scriptedGate([true, false, false]) });
    assert.equal(s.committed, 0);
    assert.equal(s.rolledBack, 1);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'main 必须回到原提交');
    assert.equal(branches(dir).filter((b) => b.startsWith('nano/self/')).length, 0);
    assert.equal(countCommits(dir, 'main'), '1');
    assert.equal(git(dir, ['status', '--porcelain']), '', '回滚后工作树必须干净');
  });

  test('模型什么都没改 → idle，不提交不回滚，main 不动', async () => {
    const { dir } = makeRepo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const s = await runOn(dir, { runTurn: fakeTurn('idle'), runGate: scriptedGate([true, true]) });
    assert.equal(s.idle, 1);
    assert.equal(s.committed, 0);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base);
    assert.equal(branches(dir).filter((b) => b.startsWith('nano/self/')).length, 0);
  });

  test('基线红且修不好 → baseline_red_wait 并回滚', async () => {
    const { dir } = makeRepo();
    const s = await runOn(dir, { maxFixRounds: 1, runTurn: fakeTurn('fix'), runGate: scriptedGate([false, false, false]) });
    assert.equal(s.attempts, 1);
    // 基线红失败计入 rolledBack 桶（summary），但 outcome 是更具体的 baseline_red_wait
    assert.equal(s.rolledBack, 1);
  });
});

describe('self: 前置条件与熔断', () => {
  test('工作树脏 → 直接收工，attempts=0，不动 git', async () => {
    const { dir } = makeRepo();
    writeFileSync(join(dir, 'wip.txt'), 'uncommitted');
    const s = await runOn(dir, { runTurn: fakeTurn('change'), runGate: scriptedGate([true]) });
    assert.equal(s.attempts, 0);
    assert.match(s.stopReason, /未提交改动/);
    assert.equal(branches(dir).filter((b) => b.startsWith('nano/self/')).length, 0);
  });

  test('存在 STOP 急停标记 → 不开始', async () => {
    const { dir } = makeRepo();
    const store = new SelfStore(dir);
    await store.ensure();
    await store.setStop(true);
    const s = await runOn(dir, { runTurn: fakeTurn('change'), runGate: scriptedGate([true]) });
    assert.equal(s.attempts, 0);
    assert.match(s.stopReason, /急停/);
    // resume 解除后可正常跑
    await store.setStop(false);
    const s2 = await runOn(dir, { runTurn: fakeTurn('change'), runGate: scriptedGate([true, true]) });
    assert.equal(s2.attempts, 1);
    assert.equal(s2.committed, 1);
    assert.equal(STOP_FILE, 'STOP');
  });

  test('token 预算：累计达到上限后不再开始下一次尝试', async () => {
    const { dir } = makeRepo();
    // 每轮 100，预算 150：第 1 轮后累计 100<150 会进第 2 轮；第 2 轮后 200≥150，
    // 但要等到第 3 轮循环开头才检测到——用 maxAttempts 控制总轮数并验证提前于 5 次停止。
    const s = await runOn(dir, {
      maxAttempts: 5, maxTotalTokens: 150,
      runTurn: fakeTurn('change', { tokensPerTurn: 100 }), runGate: scriptedGate([true, true]),
    });
    assert.ok(s.attempts < 5, '预算耗尽后必须提前收工');
    assert.ok(s.tokens >= 150);
    assert.match(s.stopReason, /token 预算/);
  });

  test('连续空闲达阈值 → 自动收工', async () => {
    const { dir } = makeRepo();
    const s = await runOn(dir, {
      maxAttempts: 5, maxConsecutiveIdle: 2,
      runTurn: fakeTurn('idle'), runGate: scriptedGate([true, true]),
    });
    assert.equal(s.attempts, 2, '连续 2 次空闲即停，不必跑满 5 次');
    assert.match(s.stopReason, /无有效改进/);
  });
});

describe('self: 受限工具集守卫', () => {
  const deps = { runCheck: async () => ({ ok: true, text: 'ok' }), gitStatus: async () => 'status' };
  const { dir } = makeRepo();
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });

  test('禁止写 .git / node_modules / 构建产物', async () => {
    const tools = buildSelfTools(deps);
    const ctx = { workspace: dir, cfg: CFG };
    const write = tools.find((t) => t.name === 'write_file');
    await assert.rejects(() => write.execute({ path: '.git/config', content: 'x' }, ctx), /不允许/);
    await assert.rejects(() => write.execute({ path: 'node_modules/pkg/evil.js', content: 'x' }, ctx), /不允许/);
    await assert.rejects(() => write.execute({ path: 'dist/x.js', content: 'x' }, ctx), /不允许/);
  });

  test('正常源码文件仍可读写，且工具表里没有 run_bash', async () => {
    const tools = buildSelfTools(deps);
    const ctx = { workspace: dir, cfg: CFG };
    const write = tools.find((t) => t.name === 'write_file');
    await write.execute({ path: 'src.txt', content: 'hello' }, ctx);
    const read = tools.find((t) => t.name === 'read_file');
    assert.equal(await read.execute({ path: 'src.txt' }, ctx), 'hello');
    assert.equal(tools.find((t) => t.name === 'run_bash'), undefined, '自改进工具集绝不能包含 run_bash');
    assert.ok(tools.find((t) => t.name === 'run_check'));
    assert.ok(tools.find((t) => t.name === 'git_status'));
  });
});

describe('self: git 安全包装', () => {
  test('拒绝删除非 nano/self/ 前缀的分支', async () => {
    const { dir } = makeRepo();
    await assert.rejects(() => gitSafe.deleteSelfBranch(dir, 'main'), /非自改进临时分支/);
  });

  test('分叉时 --ff-only 返回 false 而不是强行合并', async () => {
    const { dir, g } = makeRepo();
    g(['checkout', '-q', '-b', 'nano/self/x']);
    writeFileSync(join(dir, 'a.txt'), 'a'); g(['add', '-A']); g(['commit', '-q', '-m', 'on-temp']);
    g(['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'b.txt'), 'b'); g(['add', '-A']); g(['commit', '-q', '-m', 'on-main-diverged']);
    const ok = await gitSafe.mergeFfOnly(dir, 'nano/self/x');
    assert.equal(ok, false);
    assert.equal(git(dir, ['rev-list', '--count', 'main']), '2', 'main 历史不被改动');
  });
});

void before; void beforeEach;
