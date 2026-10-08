/**
 * tests/plugins.test.mjs —— 插件系统（含安全用例）
 *
 * 这一组守的是"插件 = 用户自己写的代码"这条路：
 *   - 插件名会被拼进路径、传给 tar、甚至用于 rm -rf → 必须白名单校验；
 *   - "禁用"必须是真禁用（连 import 都不做），否则禁用只是个摆设。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, cleanupHome } from './helpers/env.mjs';

const home = isolateHome('nh-plugin-');
const {
  loadInstalledPlugins, listInstalled, installFromEntry, setPluginEnabled,
  uninstallPlugin, fetchMarketplace, PLUGINS_DIR,
} = await import('../dist/plugins.js');
const { listTools, registerBuiltinTools } = await import('../dist/tools/index.js');
const { CONFIG_DIR } = await import('../dist/config.js');

await registerBuiltinTools(); // 本文件要断言"内置工具不受插件影响"，得先有内置工具

after(() => cleanupHome(home));

/** 往插件目录里造一个插件 */
function makePlugin(name, { manifest = {}, code } = {}) {
  const dir = join(PLUGINS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    name, version: '1.0.0', description: '测试插件', author: 'tester', ...manifest,
  }), 'utf8');
  writeFileSync(join(dir, 'tools.mjs'), code ?? `
    export const tools = [{
      name: '${name}_hello',
      description: '打个招呼',
      parameters: { type: 'object', properties: {} },
      needsPermission: false,
      describe: () => '${name}',
      execute: async () => 'hi from ${name}',
    }];
  `, 'utf8');
  return dir;
}

const cfgWith = (plugins) => ({ baseUrl: 'http://x', apiKey: '', model: 'm', maxSteps: 5, yolo: true, contextChars: 1000, plugins });

describe('plugins: 安装与加载', () => {
  test('内置示例插件可以安装并加载', async () => {
    const index = await fetchMarketplace();
    const bundled = index.plugins.find((p) => p.source.type === 'bundled');
    assert.ok(bundled, '市场索引里应至少有一个 bundled 示例插件');
    const res = await installFromEntry(bundled);
    assert.equal(res.ok, true, res.message);
    const installed = await listInstalled(cfgWith({}));
    assert.ok(installed.some((p) => p.manifest.name === bundled.name));
  });

  test('启用时注册工具，禁用时注销（实时生效）', async () => {
    makePlugin('toggle-me');
    await loadInstalledPlugins(cfgWith({}), false); // 只扫描不注册
    assert.ok(!listTools().some((t) => t.name === 'toggle-me_hello'), '未启用前不应在工具表里');

    const on = await setPluginEnabled('toggle-me', true, cfgWith({}));
    assert.equal(on.ok, true, on.message);
    assert.ok(listTools().some((t) => t.name === 'toggle-me_hello'), '启用后应注册');

    const off = await setPluginEnabled('toggle-me', false, cfgWith({}));
    assert.equal(off.ok, true, off.message);
    assert.ok(!listTools().some((t) => t.name === 'toggle-me_hello'), '禁用后应注销');
  });

  test('禁用状态下的插件不会被 import（代码根本不执行）', async () => {
    const marker = join(home, 'side-effect.txt');
    makePlugin('sneaky', {
      code: `import { writeFileSync } from 'node:fs';
             writeFileSync(${JSON.stringify(marker)}, 'executed');
             export const tools = [];`,
    });
    const list = await loadInstalledPlugins(cfgWith({ sneaky: false }), true);
    const info = list.find((p) => p.manifest.name === 'sneaky');
    assert.equal(info.enabled, false);
    assert.equal(existsSync(marker), false, '被禁用的插件不该有机会执行顶层代码');
  });

  test('启用状态下的插件顶层代码会执行（对照组）', async () => {
    const marker = join(home, 'side-effect-on.txt');
    makePlugin('eager', {
      code: `import { writeFileSync } from 'node:fs';
             writeFileSync(${JSON.stringify(marker)}, 'executed');
             export const tools = [];`,
    });
    await loadInstalledPlugins(cfgWith({}), true);
    assert.equal(existsSync(marker), true);
  });

  test('缺少 describe 的工具会被补一个兜底实现（否则整个回合会崩）', async () => {
    const dir = join(PLUGINS_DIR, 'nodescribe');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'nodescribe', version: '1', description: '', author: '' }), 'utf8');
    writeFileSync(join(dir, 'tools.mjs'), `
      export const tools = [{ name: 'nodescribe_x', description: 'd', parameters: {}, needsPermission: false, execute: async () => 'ok' }];
    `, 'utf8');
    await loadInstalledPlugins(cfgWith({}), true);
    const { getTool } = await import('../dist/tools/index.js');
    assert.equal(typeof getTool('nodescribe_x').describe, 'function');
  });

  test('plugin.json 坏掉时给出 loadError 而不是崩掉', async () => {
    const dir = join(PLUGINS_DIR, 'badmanifest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), '{ not json', 'utf8');
    const list = await loadInstalledPlugins(cfgWith({}), true);
    const info = list.find((p) => p.manifest.name === 'badmanifest');
    assert.ok(info.loadError, '应带上错误原因');
    assert.equal(info.enabled, false);
  });

  test('插件目录里的断链符号链接不会让整个加载流程崩掉', async () => {
    try {
      symlinkSync('/definitely/not/exist', join(PLUGINS_DIR, 'broken-link'), 'dir');
    } catch {
      return; // 环境不支持符号链接则跳过
    }
    // 修复前：fs.stat 抛 ENOENT → 整个 loadInstalledPlugins reject → CLI 启动即 exit 1
    const list = await loadInstalledPlugins(cfgWith({}), true);
    assert.ok(Array.isArray(list));
  });
});

describe('plugins: 名字安全（注入 / 越界删除）', () => {
  const badNames = [
    '../sessions',
    '../../..',
    'a/b',
    '/etc/passwd',
    '$(echo pwned)',
    '`whoami`',
    'name; rm -rf /',
    '..',
    '',
    'x'.repeat(100),
  ];
  for (const name of badNames) {
    test(`拒绝非法插件名：${JSON.stringify(name)}`, async () => {
      const res = await installFromEntry({
        name, title: name, description: '', author: '', version: '1',
        source: { type: 'bundled', dir: 'examples/plugins/devtools' },
      });
      assert.equal(res.ok, false, `不该安装成功：${name}`);
      assert.match(res.message, /非法|保留/);
    });

    test(`setPluginEnabled 拒绝非法插件名：${JSON.stringify(name)}`, async () => {
      const res = await setPluginEnabled(name, false, cfgWith({}));
      assert.equal(res.ok, false);
    });
  }

  test('uninstallPlugin 拒绝越界名字（不会 rm -rf 掉会话目录）', async () => {
    const sessions = join(CONFIG_DIR, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'keep.json'), '{"messages":[]}', 'utf8');
    await assert.rejects(() => uninstallPlugin('../sessions'), /非法|保留/);
    assert.equal(existsSync(join(sessions, 'keep.json')), true, '会话文件必须还在');
  });

  test('保留名 builtin 被拒绝（否则能把内置工具全注销）', async () => {
    const res = await setPluginEnabled('builtin', false, cfgWith({}));
    assert.equal(res.ok, false);
    assert.match(res.message, /保留/);
  });

  test('合法名字可以正常启用', async () => {
    makePlugin('ok-name_1.2');
    const res = await setPluginEnabled('ok-name_1.2', true, cfgWith({}));
    assert.equal(res.ok, true, res.message);
  });
});

describe('plugins: 工具归属', () => {
  test('插件工具带上 plugin: 前缀归属，禁用只影响自己', async () => {
    makePlugin('owner-a');
    makePlugin('owner-b');
    await setPluginEnabled('owner-a', true, cfgWith({}));
    await setPluginEnabled('owner-b', true, cfgWith({}));
    assert.ok(listTools().some((t) => t.name === 'owner-a_hello'));
    assert.ok(listTools().some((t) => t.name === 'owner-b_hello'));

    await setPluginEnabled('owner-a', false, cfgWith({}));
    assert.ok(!listTools().some((t) => t.name === 'owner-a_hello'), 'a 应被注销');
    assert.ok(listTools().some((t) => t.name === 'owner-b_hello'), 'b 不该被牵连');
    assert.ok(listTools().some((t) => t.name === 'read_file'), '内置工具更不该被牵连');
  });
});

describe('plugins: GitHub 来源路径守卫', () => {
  test('subdir 含 ".." 段时拒绝（在发网络请求之前）', async () => {
    const res = await installFromEntry({
      name: 'trav', title: 't', description: '', author: '', version: '1',
      source: { type: 'github', repo: 'some/repo', subdir: '../../..' },
    });
    assert.equal(res.ok, false);
    assert.match(res.message, /子目录/);
  });

  test('subdir 为绝对路径时拒绝', async () => {
    const res = await installFromEntry({
      name: 'trav2', title: 't', description: '', author: '', version: '1',
      source: { type: 'github', repo: 'some/repo', subdir: '/etc' },
    });
    assert.equal(res.ok, false);
  });
});

void readFileSync;
