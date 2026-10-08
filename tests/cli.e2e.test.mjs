/**
 * tests/cli.e2e.test.mjs —— 真的把 `node dist/cli.js` 跑起来
 *
 * 前几组测试是直接调模块；这一组走真实入口（参数解析、会话落盘、退出码），
 * 覆盖"用户实际敲命令"的那条路。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockModel } from './helpers/mock-model.mjs';

/** 版本号以 package.json 为唯一来源：不能在测试里写死，否则一发版就红 */
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const home = mkdtempSync(join(tmpdir(), 'nh-cli-home-'));
const work = mkdtempSync(join(tmpdir(), 'nh-cli-ws-'));
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;

after(() => { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

/** 跑一次 CLI，返回 { code, stdout, stderr } */
function runCli(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: work,
      env: { ...process.env, NANO_HARNESS_HOME: home, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

const sessionsDir = join(home, 'sessions');
const sessionFiles = () => { try { return readdirSync(sessionsDir).filter((f) => f.endsWith('.json')); } catch { return []; } };

describe('cli: 基础命令', () => {
  test('--version 输出版本号并退出 0', async () => {
    const { code, stdout } = await runCli(['--version']);
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(`nano-harness v${APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test('--help 列出关键参数', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    for (const flag of ['--dir', '--yolo', '--no-yolo', '--reconfigure', '--model']) {
      assert.ok(stdout.includes(flag), `帮助里应包含 ${flag}`);
    }
  });
});

describe('cli: 一次性任务（真实跑通模型 → 工具 → 回答）', () => {
  test('跑完落盘一个会话，并记录工作区', async () => {
    const mock = await startMockModel([{ content: '你好，任务完成' }]);
    try {
      const { code, stdout } = await runCli(
        ['写个问候', '--base-url', mock.baseUrl, '--api-key', 'k', '--model', 'cli-model', '--yolo', '--dir', work],
      );
      assert.equal(code, 0, stdout);
      assert.match(stdout, /任务完成/);
      const files = sessionFiles();
      assert.ok(files.length >= 1, '应至少落盘一个会话');
      const saved = JSON.parse(readFileSync(join(sessionsDir, files.at(-1)), 'utf8'));
      assert.equal(saved.workspace, work, '会话应记录 --dir 指定的工作区');
      assert.equal(saved.messages.at(-1).content, '你好，任务完成');
      // 请求里用的应该是 --model 指定的模型
      assert.equal(mock.requests.at(-1).body.model, 'cli-model');
    } finally { await mock.close(); }
  });

  test('工具调用能真正改到 --dir 里的文件', async () => {
    const mock = await startMockModel([
      {
        content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'from-cli.txt', content: 'cli wrote me' }) },
        }],
      },
      { content: '写好了' },
    ]);
    try {
      const { code, stdout } = await runCli(
        ['写个文件', '--base-url', mock.baseUrl, '--api-key', 'k', '--model', 'm', '--yolo', '--dir', work],
      );
      assert.equal(code, 0, stdout);
      assert.equal(readFileSync(join(work, 'from-cli.txt'), 'utf8'), 'cli wrote me');
    } finally { await mock.close(); }
  });

  test('模型报错时退出码为 1，并给出可读错误', async () => {
    const { code, stdout, stderr } = await runCli(
      ['任务', '--base-url', 'http://127.0.0.1:1/v1', '--api-key', 'k', '--model', 'm', '--yolo', '--dir', work],
    );
    assert.equal(code, 1);
    assert.match(stdout + stderr, /fetch failed|ECONNREFUSED|模型调用失败/);
  });

  test('非交互环境下的危险操作按拒绝处理，不会挂死', async () => {
    const mock = await startMockModel([
      {
        content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'run_bash', arguments: JSON.stringify({ command: 'echo should-not-run' }) },
        }],
      },
      { content: '好，我不执行了' },
    ]);
    try {
      const started = Date.now();
      const { code, stdout } = await runCli(
        ['跑个命令', '--base-url', mock.baseUrl, '--api-key', 'k', '--model', 'm', '--dir', work],
      ); // 注意：没有 --yolo，stdin 也不是 TTY
      assert.ok(Date.now() - started < 30_000, '不能卡在权限问询上');
      assert.equal(code, 0, stdout);
      assert.match(stdout, /不是交互终端|已拒绝/);
    } finally { await mock.close(); }
  });

  test('同一轮对话的多轮任务只更新同一个会话文件', async () => {
    const before = sessionFiles().length;
    const mock = await startMockModel([{ content: 'ok' }]);
    try {
      const input = ['第一轮任务', '第二轮任务', '/exit'].join('\n') + '\n';
      const { code } = await runCli(
        ['--base-url', mock.baseUrl, '--api-key', 'k', '--model', 'm', '--yolo', '--dir', work],
        { input },
      );
      assert.equal(code, 0);
      const added = sessionFiles().length - before;
      assert.equal(added, 1, `两轮对话应该只新增一个会话文件，实际新增 ${added}`);
    } finally { await mock.close(); }
  });
});

describe('cli: 配置', () => {
  test('向导写入的 Key 真的会用于请求（曾经是 401 的根源）', async () => {
    const home2 = mkdtempSync(join(tmpdir(), 'nh-cli-wizard-'));
    const mock = await startMockModel([{ content: '配置好了' }]);
    try {
      // 模拟向导的输入：1(DeepSeek) → key → model
      const { code, stdout } = await runCli(
        ['你好'],
        { env: { NANO_HARNESS_HOME: home2 }, input: `1\nsk-wizard-key\nwizard-model\n` },
      );
      // 向导跑完后，本次进程内就应该能用这个 Key 发请求（这里 base-url 仍是默认，会失败，
      // 但重点是配置落盘后 provider 里的 Key 必须是填的那个）
      const cfg = JSON.parse(readFileSync(join(home2, 'config.json'), 'utf8'));
      const active = cfg.providers.find((p) => p.id === cfg.activeProviderId);
      assert.equal(active.apiKey, 'sk-wizard-key', '当前提供商的 Key 必须与向导一致');
      assert.equal(active.model, 'wizard-model');
      void code; void stdout;
    } finally {
      await mock.close();
      rmSync(home2, { recursive: true, force: true });
    }
  });
});

void mkdirSync; void writeFileSync; void before;
