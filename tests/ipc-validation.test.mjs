/**
 * tests/ipc-validation.test.mjs —— IPC 入参白名单校验（渲染层不可信）
 *
 * 这些纯数据校验是桌面主进程信任边界的最后一道闸：被 XSS / 依赖投毒的渲染层
 * 可能发任意形状的 IPC。测试同时锁定"放行什么"和"拒绝/剥离什么"。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, cleanupHome } from './helpers/env.mjs';

const home = isolateHome('nh-ipc-');
const { asPreset, sanitizeConfigPatch, sanitizeProvider } = await import('../dist/ipc-validation.js');

after(() => cleanupHome(home));

describe('asPreset', () => {
  test('三态合法值原样返回', () => {
    assert.equal(asPreset('standard'), 'standard');
    assert.equal(asPreset('minimal'), 'minimal');
    assert.equal(asPreset('creative'), 'creative');
  });
  test('非法/缺失一律 undefined（调用方回落，不把脏值写进历史）', () => {
    for (const v of ['YOLO', '', 'standard ', 'MINIMAL', 1, null, undefined, {}, []]) {
      assert.equal(asPreset(v), undefined, `应拒绝 ${JSON.stringify(v)}`);
    }
  });
});

describe('sanitizeConfigPatch', () => {
  test('合法字段被保留并做类型校正', () => {
    const out = sanitizeConfigPatch({
      yolo: true, maxSteps: '12', contextChars: 20000.9,
      appearance: 'dark', activePreset: 'creative',
      plugins: { a: true, b: false, c: 'nope' },
    });
    assert.deepEqual(out, {
      yolo: true, maxSteps: 12, contextChars: 20000,
      appearance: 'dark', activePreset: 'creative',
      plugins: { a: true, b: false }, // 非布尔的 c 被剥离
    });
  });

  test('未知 / 敏感键一律剥离（workspace/providers/任意自定义键都不许从这里改）', () => {
    const out = sanitizeConfigPatch({
      yolo: false,
      workspace: '/etc',
      recentWorkspaces: ['/'],
      providers: [{ id: 'x' }],
      __proto__: { polluted: 1 },
      evil: 'x',
    });
    assert.deepEqual(out, { yolo: false });
    assert.equal(({}).polluted, undefined, '不得造成原型污染');
  });

  test('各种类型错误返回 error 而不是放行', () => {
    assert.equal('error' in sanitizeConfigPatch(null), true);
    assert.equal('error' in sanitizeConfigPatch([]), true);
    assert.equal('error' in sanitizeConfigPatch('yolo=true'), true);
    assert.equal('error' in sanitizeConfigPatch({ yolo: 'yes' }), true);
    assert.equal('error' in sanitizeConfigPatch({ maxSteps: 0 }), true);
    assert.equal('error' in sanitizeConfigPatch({ maxSteps: 101 }), true);
    assert.equal('error' in sanitizeConfigPatch({ maxSteps: 3.5 }), true);
    assert.equal('error' in sanitizeConfigPatch({ contextChars: 999 }), true);
    assert.equal('error' in sanitizeConfigPatch({ appearance: 'purple' }), true);
    assert.equal('error' in sanitizeConfigPatch({ activePreset: 'yolo' }), true);
    assert.equal('error' in sanitizeConfigPatch({ plugins: [] }), true);
  });
});

describe('sanitizeProvider', () => {
  test('合法提供商通过，name 缺省回落为 id、字段做 trim', () => {
    const p = sanitizeProvider({ id: ' ds ', baseUrl: ' https://x/v1 ', model: ' m ', apiKey: 'k'});
    assert.deepEqual(p, { id: 'ds', name: 'ds', baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' });

    const p2 = sanitizeProvider({ id: 'a', name: ' 名字 ', baseUrl: 'u', model: 'm' });
    assert.equal(p2.name, '名字');
    assert.equal(p2.apiKey, '');
  });

  test('缺关键项 / id 含非法字符被拒绝', () => {
    assert.equal('error' in sanitizeProvider({ baseUrl: 'u', model: 'm' }), true, '缺 id');
    assert.equal('error' in sanitizeProvider({ id: 'a', model: 'm' }), true, '缺 baseUrl');
    assert.equal('error' in sanitizeProvider({ id: 'a', baseUrl: 'u' }), true, '缺 model');
    assert.equal('error' in sanitizeProvider({ id: '../x', baseUrl: 'u', model: 'm' }), true, 'id 含路径段');
    assert.equal('error' in sanitizeProvider({ id: 'a b', baseUrl: 'u', model: 'm' }), true, 'id 含空格');
    assert.equal('error' in sanitizeProvider(null), true);
    assert.equal('error' in sanitizeProvider([]), true);
  });
});

void mkdtempSync; void rmSync; void tmpdir; void join;
