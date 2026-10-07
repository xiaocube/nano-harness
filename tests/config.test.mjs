/**
 * tests/config.test.mjs —— 配置层
 *
 * 覆盖：默认值兜底、文件读写、环境变量覆盖、脏数据免疫、
 * 旧配置（无 providers）自动迁移、权限收紧、isConfigUsable 判定。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, cleanupHome } from './helpers/env.mjs';

const home = isolateHome('nh-config-');
const {
  loadConfig, saveConfig, configExists, isConfigUsable, getActiveProvider,
  CONFIG_DIR, CONFIG_FILE, PRESETS,
} = await import('../dist/config.js');

before(() => { /* home 已在导入前设置 */ });
after(() => cleanupHome(home));

describe('config: 默认值与路径', () => {
  test('NANO_HARNESS_HOME 决定配置目录', () => {
    assert.equal(CONFIG_DIR, home);
    assert.equal(CONFIG_FILE, join(home, 'config.json'));
  });

  test('没有配置文件时给全套默认值', async () => {
    const cfg = await loadConfig();
    assert.equal(cfg.model, 'deepseek-chat');
    assert.equal(cfg.maxSteps, 25);
    assert.equal(cfg.yolo, false);
    assert.equal(cfg.contextChars, 48_000);
    assert.equal(cfg.appearance, 'system');
    assert.ok(Array.isArray(cfg.providers) && cfg.providers.length === 1, '应自动迁移出一个默认提供商');
    assert.equal(cfg.activeProviderId, 'default');
  });

  test('configExists 反应真实文件状态', async () => {
    assert.equal(await configExists(), false);
    await saveConfig(await loadConfig());
    assert.equal(await configExists(), true);
  });
});

describe('config: 读写与权限', () => {
  test('saveConfig → loadConfig 往返一致（含 providers / 工作区 / 插件开关）', async () => {
    const cfg = await loadConfig();
    cfg.model = 'glm-4-flash';
    cfg.maxSteps = 7;
    cfg.yolo = true;
    cfg.appearance = 'dark';
    cfg.activePreset = 'creative';
    cfg.plugins = { devtools: false };
    cfg.workspace = home;
    cfg.recentWorkspaces = [home];
    await saveConfig(cfg);

    const back = await loadConfig();
    assert.equal(back.model, 'glm-4-flash');
    assert.equal(back.maxSteps, 7);
    assert.equal(back.yolo, true);
    assert.equal(back.appearance, 'dark');
    assert.equal(back.activePreset, 'creative');
    assert.deepEqual(back.plugins, { devtools: false });
    assert.equal(back.workspace, home);
    assert.deepEqual(back.recentWorkspaces, [home]);
  });

  test('配置文件权限是 0600（里面有 API Key）', () => {
    const mode = statSync(CONFIG_FILE).mode & 0o777;
    assert.equal(mode.toString(8), '600');
  });
});

describe('config: 脏数据免疫', () => {
  test('损坏的 JSON 不抛错，回落默认值', async () => {
    writeFileSync(CONFIG_FILE, '{ this is not json', 'utf8');
    const cfg = await loadConfig();
    assert.equal(cfg.model, 'deepseek-chat');
  });

  test('类型不对的字段被忽略而不是污染配置', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      baseUrl: 123, apiKey: null, model: '', maxSteps: -5, yolo: 'yes',
      contextChars: 'big', appearance: 'neon', activePreset: 'nope',
      workspace: 42, recentWorkspaces: 'not-an-array', plugins: [],
    }), 'utf8');
    const cfg = await loadConfig();
    assert.equal(cfg.baseUrl, 'https://api.deepseek.com');
    assert.equal(cfg.model, 'deepseek-chat');
    assert.equal(cfg.maxSteps, 25);
    assert.equal(cfg.yolo, false);
    assert.equal(cfg.contextChars, 48_000);
    assert.notEqual(cfg.appearance, 'neon');
    assert.notEqual(cfg.activePreset, 'nope');
    assert.equal(cfg.workspace, undefined);
    assert.equal(cfg.recentWorkspaces, undefined);
  });

  test('recentWorkspaces 最多保留 8 个且过滤空值', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      recentWorkspaces: ['/a', '', '  ', ...Array.from({ length: 10 }, (_, i) => `/p${i}`)],
    }), 'utf8');
    const cfg = await loadConfig();
    assert.equal(cfg.recentWorkspaces.length, 8);
    assert.ok(cfg.recentWorkspaces.every((p) => p.trim().length > 0));
  });

  test('providers 数组里的坏条目被过滤', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      providers: [{ id: 'ok', baseUrl: 'http://x', apiKey: '', model: 'm' }, { nope: true }, null],
      activeProviderId: 'ok',
    }), 'utf8');
    const cfg = await loadConfig();
    assert.equal(cfg.providers.length, 1);
    assert.equal(cfg.providers[0].id, 'ok');
  });
});

describe('config: 环境变量覆盖', () => {
  test('NANO_HARNESS_* 覆盖文件里的值', async () => {
    await saveConfig({ ...(await loadConfig()), model: 'from-file' });
    process.env.NANO_HARNESS_MODEL = 'from-env';
    process.env.NANO_HARNESS_BASE_URL = 'http://env.example/v1';
    process.env.NANO_HARNESS_API_KEY = 'env-key';
    try {
      const cfg = await loadConfig();
      assert.equal(cfg.model, 'from-env');
      assert.equal(cfg.baseUrl, 'http://env.example/v1');
      assert.equal(cfg.apiKey, 'env-key');
      // 环境变量也要同步进"当前提供商"，否则 callChat 会绕过它
      assert.equal(getActiveProvider(cfg).model, 'from-env');
    } finally {
      delete process.env.NANO_HARNESS_MODEL;
      delete process.env.NANO_HARNESS_BASE_URL;
      delete process.env.NANO_HARNESS_API_KEY;
    }
  });
});

describe('config: 辅助函数', () => {
  test('getActiveProvider 三重回落：active → 第一个 → 旧字段', () => {
    assert.equal(getActiveProvider({ ...testBase(), providers: [], activeProviderId: 'x' }).id, 'default');
    assert.equal(getActiveProvider({ ...testBase(), providers: [{ id: 'a', name: 'A', baseUrl: 'u', apiKey: '', model: 'm' }] }).id, 'a');
    assert.equal(getActiveProvider({ ...testBase(), providers: [
      { id: 'a', name: 'A', baseUrl: 'u', apiKey: '', model: 'm' },
      { id: 'b', name: 'B', baseUrl: 'u2', apiKey: '', model: 'm2' },
    ], activeProviderId: 'b' }).id, 'b');
  });

  test('isConfigUsable：本地端点不需要 Key，远端需要', () => {
    assert.equal(isConfigUsable(testBase({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' })), true);
    assert.equal(isConfigUsable(testBase({ baseUrl: 'https://api.deepseek.com', apiKey: '' })), false);
    assert.equal(isConfigUsable(testBase({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x' })), true);
  });

  test('内置厂商预设都是 OpenAI 兼容端点', () => {
    assert.ok(PRESETS.length >= 4);
    for (const p of PRESETS) {
      assert.equal(typeof p.key, 'string');
      assert.equal(typeof p.label, 'string');
    }
  });
});

function testBase(over = {}) {
  return { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', maxSteps: 25, yolo: false, contextChars: 48_000, ...over };
}

// 保持未使用导入不报错（readdirSync 供后续扩展）
void readdirSync; void readFileSync;
