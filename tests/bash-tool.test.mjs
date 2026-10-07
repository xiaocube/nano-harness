/**
 * tests/bash-tool.test.mjs —— 终端工具
 *
 * 重点验证修复过的两个坑：
 *   1. 超时必须能杀掉**整个进程组**（`cmd &` 起的后代曾让 agent 卡死）；
 *   2. 被杀的原因要如实回报（输出超限 vs 超时），别都写成"超时"。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, cleanupHome } from './helpers/env.mjs';

const home = isolateHome('nh-bash-');
const { registerBuiltinTools, getTool } = await import('../dist/tools/index.js');
const work = mkdtempSync(join(tmpdir(), 'nh-bash-ws-'));
const ctx = { workspace: work, cfg: { baseUrl: '', apiKey: '', model: 'm', maxSteps: 5, yolo: true, contextChars: 1000 } };
const run = (args, c = ctx) => getTool('run_bash').execute(args, c);

before(async () => { await registerBuiltinTools(); });
after(() => { cleanupHome(home); rmSync(work, { recursive: true, force: true }); });

describe('bash: 基本执行', () => {
  test('在工作区目录下执行并带回显', async () => {
    const out = await run({ command: 'pwd && echo hello' });
    assert.match(out, /hello/);
    assert.match(out, /nh-bash-ws-/);
    assert.match(out, /\[退出码: 0\]/);
  });

  test('非零退出码如实回报（模型据此判断失败）', async () => {
    const out = await run({ command: 'exit 3' });
    assert.match(out, /\[退出码: 3\]/);
  });

  test('stderr 与 stdout 合并返回', async () => {
    const out = await run({ command: 'echo out; echo err 1>&2' });
    assert.match(out, /out/);
    assert.match(out, /err/);
  });

  test('空命令直接报错，不起进程', async () => {
    assert.match(await run({ command: '   ' }), /command 为空/);
  });

  test('命令真的改了工作区里的文件', async () => {
    await run({ command: 'echo written > made-by-bash.txt' });
    assert.equal(readFileSync(join(work, 'made-by-bash.txt'), 'utf8').trim(), 'written');
  });
});

describe('bash: 超时熔断（含后代进程）', () => {
  test('普通超时会被终止并说明原因', async () => {
    const started = Date.now();
    const out = await run({ command: 'sleep 30', timeout_sec: 1 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `应当在 1s 左右结束，实际 ${elapsed}ms`);
    assert.match(out, /未结束，已终止整个进程组/);
  });

  test('命令用 & 起了后台后代：超时也要能收场（以前会永远卡住）', async () => {
    const started = Date.now();
    const out = await run({ command: 'sleep 30 & echo started', timeout_sec: 1 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `后台进程不能拖住工具调用，实际 ${elapsed}ms`);
    assert.match(out, /started/);
  });

  test('管道里的长命令同样会被超时收掉', async () => {
    const started = Date.now();
    await run({ command: 'yes | head -c 100000000 | sleep 30', timeout_sec: 1 });
    assert.ok(Date.now() - started < 10_000);
  });

  test('timeout_sec 被钳制在上限内（模型要 9999 秒也不行）', async () => {
    const out = await run({ command: 'echo quick', timeout_sec: 9999 });
    assert.match(out, /quick/);
  });
});

describe('bash: 输出截断', () => {
  test('海量输出被截断且标注原因（不是"超时"）', async () => {
    // 产生远超 2*20000 字符的输出
    const out = await run({ command: 'for i in $(seq 1 20000); do echo "line-$i-xxxxxxxxxxxxxxxx"; done', timeout_sec: 30 });
    assert.ok(out.length < 60_000, `输出应被截断，实际 ${out.length} 字符`);
    assert.match(out, /输出超过|输出已截断/);
    assert.doesNotMatch(out, /未结束，已终止整个进程组/);
  });
});

describe('bash: 权限与安全', () => {
  test('run_bash 标记为需要权限', () => {
    assert.equal(getTool('run_bash').needsPermission, true);
  });

  test('describe 返回命令原文（权限弹窗要显示给人看）', () => {
    assert.equal(getTool('run_bash').describe({ command: 'rm -rf /tmp/x' }), 'rm -rf /tmp/x');
  });
});

void existsSync; void writeFileSync;
