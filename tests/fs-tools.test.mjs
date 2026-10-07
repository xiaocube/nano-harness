/**
 * tests/fs-tools.test.mjs —— 文件工具的路径围栏与读写
 *
 * 这一组是**安全测试**：路径越界必须一律拒绝，否则模型可以读写用户
 * 工作区之外的任意文件（~/.ssh、/etc/passwd）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, cleanupHome } from './helpers/env.mjs';

const home = isolateHome('nh-fs-');
const { registerBuiltinTools, getTool, listTools } = await import('../dist/tools/index.js');

const work = mkdtempSync(join(tmpdir(), 'nh-ws-'));
const outside = mkdtempSync(join(tmpdir(), 'nh-outside-'));
const ctx = { workspace: work, cfg: { baseUrl: '', apiKey: '', model: 'm', maxSteps: 5, yolo: true, contextChars: 1000 } };

before(async () => { await registerBuiltinTools(); });
after(() => { cleanupHome(home); rmSync(work, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

const run = (name, args) => getTool(name).execute(args, ctx);

describe('tools: 注册表', () => {
  test('内置工具齐全且名字合法', () => {
    const names = listTools().map((t) => t.name).sort();
    assert.deepEqual(names, ['edit_file', 'list_dir', 'read_file', 'run_bash', 'write_file']);
    for (const t of listTools()) {
      assert.match(t.name, /^[a-z0-9_]+$/);
      assert.equal(typeof t.description, 'string');
      assert.ok(t.description.length > 10);
      assert.equal(typeof t.describe({}), 'string');
    }
  });

  test('写操作标记了需要权限，读操作没有', () => {
    assert.equal(getTool('write_file').needsPermission, true);
    assert.equal(getTool('edit_file').needsPermission, true);
    assert.equal(getTool('run_bash').needsPermission, true);
    assert.equal(getTool('read_file').needsPermission, false);
    assert.equal(getTool('list_dir').needsPermission, false);
  });
});

describe('tools: 路径围栏（安全）', () => {
  const escapes = [
    '../outside.txt',
    '../../etc/passwd',
    '/etc/passwd',
    'a/../../outside.txt',
    './../outside.txt',
  ];
  for (const bad of escapes) {
    test(`read_file 拒绝越界路径：${bad}`, async () => {
      await assert.rejects(() => run('read_file', { path: bad }), /超出工作区边界/);
    });
    test(`write_file 拒绝越界路径：${bad}`, async () => {
      await assert.rejects(() => run('write_file', { path: bad, content: 'x' }), /超出工作区边界/);
    });
  }

  test('前缀相似的兄弟目录不能伪装成工作区内部', async () => {
    // work = /tmp/nh-ws-xxx，兄弟目录 /tmp/nh-ws-xxx-evil
    const sibling = `${work}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'secret.txt'), 'top secret', 'utf8');
    try {
      await assert.rejects(() => run('read_file', { path: `${sibling}/secret.txt` }), /超出工作区边界/);
      await assert.rejects(() => run('read_file', { path: `../${sibling.split('/').pop()}/secret.txt` }), /超出工作区边界/);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('通过符号链接指向外部要被拦住（读写都拦）', async () => {
    writeFileSync(join(outside, 'target.txt'), 'outside content', 'utf8');
    const link = join(work, 'link-to-outside');
    try {
      symlinkSync(outside, link, 'dir');
    } catch {
      return; // 某些环境不允许建符号链接，跳过
    }
    try {
      // 读：不能把工作区外的文件读出来
      await assert.rejects(() => run('read_file', { path: 'link-to-outside/target.txt' }), /超出工作区边界/);
      // 写：不能通过链接把文件写到工作区外
      await assert.rejects(
        () => run('write_file', { path: 'link-to-outside/pwned.txt', content: 'x' }),
        /超出工作区边界/,
      );
      assert.equal(existsSync(join(outside, 'pwned.txt')), false);
      // 列目录同样要拦
      await assert.rejects(() => run('list_dir', { path: 'link-to-outside' }), /超出工作区边界/);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test('新建文件的父目录不存在时仍能通过校验（不能只 realpath 目标本身）', async () => {
    const out = await run('write_file', { path: 'brand/new/deep.txt', content: 'ok' });
    assert.match(out, /已写入/);
    assert.equal(readFileSync(join(work, 'brand/new/deep.txt'), 'utf8'), 'ok');
  });

  test('路径参数缺失时报错', async () => {
    await assert.rejects(() => run('read_file', {}), /路径参数缺失/);
  });
});

describe('tools: 读写与编辑', () => {
  test('write_file 自动建父目录并返回写入信息', async () => {
    const out = await run('write_file', { path: 'deep/nested/file.txt', content: '你好' });
    assert.match(out, /已写入/);
    assert.match(out, /2 字符/);
    assert.equal(readFileSync(join(work, 'deep/nested/file.txt'), 'utf8'), '你好');
  });

  test('read_file 读回内容', async () => {
    await run('write_file', { path: 'r.txt', content: 'line1\nline2' });
    assert.equal(await run('read_file', { path: 'r.txt' }), 'line1\nline2');
  });

  test('read_file 读不存在的文件会抛错', async () => {
    await assert.rejects(() => run('read_file', { path: 'nope.txt' }));
  });

  test('edit_file 精确替换一次', async () => {
    await run('write_file', { path: 'e.txt', content: 'hello world' });
    const out = await run('edit_file', { path: 'e.txt', old_string: 'world', new_string: 'nano' });
    assert.match(out, /已替换/);
    assert.equal(readFileSync(join(work, 'e.txt'), 'utf8'), 'hello nano');
  });

  test('edit_file 找不到原文时返回错误文本而不是抛错', async () => {
    await run('write_file', { path: 'e2.txt', content: 'abc' });
    const out = await run('edit_file', { path: 'e2.txt', old_string: 'zzz', new_string: 'y' });
    assert.match(out, /不存在/);
    assert.equal(readFileSync(join(work, 'e2.txt'), 'utf8'), 'abc');
  });

  test('edit_file 原文出现多次时拒绝执行（避免误伤）', async () => {
    await run('write_file', { path: 'e3.txt', content: 'aa bb aa' });
    const out = await run('edit_file', { path: 'e3.txt', old_string: 'aa', new_string: 'x' });
    assert.match(out, /出现了多次/);
    assert.equal(readFileSync(join(work, 'e3.txt'), 'utf8'), 'aa bb aa');
  });
});

describe('tools: list_dir', () => {
  test('目录排在文件前面，目录带 / 后缀', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nh-ls-'));
    const sub = { workspace: dir, cfg: ctx.cfg };
    mkdirSync(join(dir, 'bdir'));
    writeFileSync(join(dir, 'afile.txt'), 'x', 'utf8');
    try {
      const out = await getTool('list_dir').execute({}, sub);
      const lines = out.split('\n');
      assert.equal(lines[0], 'bdir/');
      assert.equal(lines[1], 'afile.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('空目录给出明确提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nh-empty-'));
    try {
      assert.equal(await getTool('list_dir').execute({}, { workspace: dir, cfg: ctx.cfg }), '(空目录)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('默认列出工作区根目录', async () => {
    await run('write_file', { path: 'root-marker.txt', content: 'x' });
    const out = await run('list_dir', {});
    assert.match(out, /root-marker\.txt/);
  });
});

describe('tools: 大文件分段读取', () => {
  test('超大文件读取会截断并告诉模型如何继续', async () => {
    const big = 'x'.repeat(50_000) + 'TAIL-MARKER';
    await run('write_file', { path: 'big.txt', content: big });
    const out = await run('read_file', { path: 'big.txt' });
    assert.ok(out.length < big.length);
    assert.match(out, /共 50011 字符/);
    assert.match(out, /offset=40000/);
  });

  test('用 offset 能读到文件尾部（以前尾部永远读不到）', async () => {
    const big = 'x'.repeat(50_000) + 'TAIL-MARKER';
    await run('write_file', { path: 'big2.txt', content: big });
    const tail = await run('read_file', { path: 'big2.txt', offset: 40_000 });
    assert.match(tail, /TAIL-MARKER/);
    assert.match(tail, /文件已读完/);
  });

  test('offset 超过文件长度时返回空片段而不是报错', async () => {
    await run('write_file', { path: 'small.txt', content: 'abc' });
    const out = await run('read_file', { path: 'small.txt', offset: 999 });
    assert.match(out, /文件已读完/);
  });

  test('小文件仍然原样返回（不加任何包装）', async () => {
    await run('write_file', { path: 'plain.txt', content: 'hello' });
    assert.equal(await run('read_file', { path: 'plain.txt' }), 'hello');
  });
});

describe('tools: 权限预览', () => {
  test('previewForPermission 最多展示 15 行并给出总数', async () => {
    const { previewForPermission } = await import('../dist/tools/fs-tools.js');
    const content = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
    const preview = await previewForPermission({ content });
    assert.match(preview, /共 40 行/);
    assert.ok(preview.split('\n').length <= 16);
  });
});

void existsSync;
