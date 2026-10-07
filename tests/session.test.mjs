/**
 * tests/session.test.mjs —— 会话持久化
 *
 * 覆盖：保存/列出/加载/归档、workspace 归属（侧栏分组靠它）、
 * 损坏文件免疫、条数上限、同名更新保留 createdAt。
 *
 * 注意：CONFIG_DIR 在模块加载时就算好了，所以一个测试文件只能用**一个**
 * NANO_HARNESS_HOME（isolateHome 必须在首个 import 之前调用）。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, cleanupHome } from './helpers/env.mjs';

const home = isolateHome('nh-session-');
const { saveSession, listSessions, loadSession, setSessionArchived } = await import('../dist/session.js');
const { CONFIG_DIR } = await import('../dist/config.js');
const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');

after(() => cleanupHome(home));

const msgs = (text) => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: text },
  { role: 'assistant', content: `回复：${text}` },
];
const readSession = (file) => JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf8'));

describe('session: 保存与读取', () => {
  test('保存后能按文件名读回完整历史', async () => {
    const file = await saveSession(msgs('第一条'), undefined, '/tmp/proj');
    assert.match(file, /\.json$/);
    assert.deepEqual(await loadSession(file), msgs('第一条'));
  });

  test('同样的文件名再次保存会原地更新，并保留 createdAt / archived', async () => {
    const file = await saveSession(msgs('会话A'), undefined, '/tmp/proj');
    await setSessionArchived(file, true);
    const first = readSession(file);
    await new Promise((r) => setTimeout(r, 5));
    await saveSession([...msgs('会话A'), { role: 'user', content: '继续' }], file, '/tmp/proj');
    const second = readSession(file);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.archived, true, '归档状态不应被覆盖');
    assert.equal(second.messages.length, 4);
    assert.ok(second.updatedAt >= first.updatedAt);
    await setSessionArchived(file, false); // 复原，免得影响后面的筛选用例
  });

  test('标题取第一条用户消息并压缩空白', async () => {
    const file = await saveSession([{ role: 'user', content: '  多   空格\n换行  的标题  ' }], undefined, '/tmp/p');
    const info = (await listSessions(50, 'all')).find((s) => s.file === file);
    assert.equal(info.title, '多 空格 换行 的标题');
  });

  test('标题超长会被截断到 60 字符', async () => {
    const file = await saveSession([{ role: 'user', content: 'x'.repeat(200) }], undefined);
    const info = (await listSessions(50, 'all')).find((s) => s.file === file);
    assert.equal(info.title.length, 60);
  });

  test('没有用户消息时用兜底标题', async () => {
    const file = await saveSession([{ role: 'system', content: 'x' }], undefined);
    const info = (await listSessions(50, 'all')).find((s) => s.file === file);
    assert.equal(info.title, '未命名会话');
  });
});

describe('session: workspace 归属（侧栏分组依赖它）', () => {
  test('workspace 会写进文件并出现在列表里', async () => {
    const file = await saveSession(msgs('带工作区'), undefined, '/Users/x/proj-a');
    const info = (await listSessions(50, 'all')).find((s) => s.file === file);
    assert.equal(info.workspace, '/Users/x/proj-a');
  });

  test('后续保存不传 workspace 时保留原归属', async () => {
    const file = await saveSession(msgs('保留归属'), undefined, '/Users/x/proj-b');
    await saveSession(msgs('保留归属'), file); // 不传 workspace
    const info = (await listSessions(50, 'all')).find((s) => s.file === file);
    assert.equal(info.workspace, '/Users/x/proj-b');
  });

  test('老会话（没有 workspace 字段）不带 workspace，供 UI 归入"未记录文件夹"', async () => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(join(SESSIONS_DIR, 'legacy.json'), JSON.stringify({
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, title: '旧会话', messages: [],
    }), 'utf8');
    const info = (await listSessions(50, 'all')).find((s) => s.file === 'legacy.json');
    assert.equal(info.workspace, undefined);
  });
});

describe('session: 排序与筛选', () => {
  test('按 updatedAt 倒序：后保存的排前面', async () => {
    const older = await saveSession(msgs('早'), undefined, '/p');
    await new Promise((r) => setTimeout(r, 15));
    const newer = await saveSession(msgs('晚'), undefined, '/p');
    const list = await listSessions(50, 'all');
    assert.ok(list.findIndex((s) => s.file === newer) < list.findIndex((s) => s.file === older));
  });

  test('归档筛选三态：hide / all / only', async () => {
    const keep = await saveSession(msgs('活跃'), undefined, '/p');
    const arch = await saveSession(msgs('归档'), undefined, '/p');
    await setSessionArchived(arch, true);

    const hidden = await listSessions(50, 'hide');
    const all = await listSessions(50, 'all');
    const only = await listSessions(50, 'only');

    assert.ok(!hidden.some((s) => s.file === arch), 'hide 不应出现归档会话');
    assert.ok(hidden.some((s) => s.file === keep));
    assert.ok(all.some((s) => s.file === arch));
    assert.ok(only.every((s) => s.archived), 'only 只返回归档会话');
    assert.ok(only.some((s) => s.file === arch));
  });

  test('limit 生效', async () => {
    assert.ok((await listSessions(2, 'all')).length <= 2);
  });
});

describe('session: 脏数据免疫', () => {
  test('损坏的会话文件被跳过，不影响其它会话', async () => {
    writeFileSync(join(SESSIONS_DIR, 'broken.json'), '{ not json', 'utf8');
    const list = await listSessions(50, 'all');
    assert.ok(!list.some((s) => s.file === 'broken.json'));
    assert.ok(list.length > 0);
  });

  test('非 .json 文件不参与列表', async () => {
    writeFileSync(join(SESSIONS_DIR, 'notes.txt'), 'hello', 'utf8');
    const list = await listSessions(50, 'all');
    assert.ok(!list.some((s) => s.file === 'notes.txt'));
  });

  test('加载不存在的会话会抛错（调用方需要处理）', async () => {
    await assert.rejects(() => loadSession('does-not-exist.json'));
  });
});
