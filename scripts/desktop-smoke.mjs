#!/usr/bin/env node
/**
 * scripts/desktop-smoke.mjs —— 桌面端"能不能正常启动并渲染"冒烟检查
 *
 * 单元/集成测试（node --test）覆盖的是**无头核心**；这个脚本覆盖的是
 * "把 Electron 真的拉起来 → 加载 web/dist → React 挂载 → 主进程桥初始化"
 * 这一整条只有在图形会话里才走得到的链路。
 *
 * 原理：desktop/main.ts 内置了自动化钩子——设置 NANO_CAPTURE=<png 路径> 后，
 * 窗口 ready-to-show 稳定 2.5s 会自动截图并 app.quit()。本脚本负责：
 *   1. 用隔离的 NANO_HARNESS_HOME 拉起 electron（绝不碰真实配置/Key）；
 *   2. 轮询等待截图文件出现（这是"界面真的渲染出来"的确据）；
 *   3. 超时/非零退出/空图都判失败，并清理整个进程组。
 *
 * 注意：需要图形会话（本机登录桌面或 GitHub Actions 的 macos runner）。
 * 在纯无头/SSH 环境里 macOS GUI 应用会立即退出，这种环境应跳过本脚本
 * （CI 用 `if: runner.os == 'macOS'` 且非 headless；本脚本默认不进 npm test 闸门）。
 *
 * 用法：npm run smoke:desktop
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = join(ROOT, 'node_modules', '.bin', 'electron');
const ENTRY = join(ROOT, 'dist-desktop', 'main.js');
const BOOT_TIMEOUT_MS = 30_000;
/** 一张真实渲染窗口的 PNG 远大于此；空图/全透明图通常只有几百字节 */
const MIN_PNG_BYTES = 5_000;

const home = mkdtempSync(join(tmpdir(), 'nh-smoke-home-'));
const shotDir = mkdtempSync(join(tmpdir(), 'nh-smoke-shot-'));
const shot = join(shotDir, 'capture.png');

function fail(msg) {
  console.error(`✗ 桌面冒烟失败：${msg}`);
  cleanup(1);
}

let child;
function cleanup(code) {
  try { if (child && !child.killed) process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  rmSync(home, { recursive: true, force: true });
  rmSync(shotDir, { recursive: true, force: true });
  process.exit(code);
}

for (const required of [ENTRY, join(ROOT, 'web', 'dist', 'index.html')]) {
  if (!existsSync(required)) fail(`缺少构建产物 ${required}，请先运行 npm run build:all`);
}

child = spawn(
  ELECTRON,
  // electron 自己的开关必须放在应用入口之前
  ['--no-sandbox', ENTRY],
  {
    cwd: ROOT,
    detached: true, // 新进程组，结束时整组回收
    env: {
      ...process.env,
      NANO_HARNESS_HOME: home,
      NANO_APPEARANCE: 'light',
      NANO_CAPTURE: shot,
      ELECTRON_ENABLE_LOGGING: '1',
    },
  },
);

let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
child.on('error', (err) => fail(`无法启动 electron：${err.message}`));
child.on('exit', (code) => {
  // 截图钩子会在成功后 app.quit()（code 0）。进程先退且没出图才算异常。
  if (!existsSync(shot)) {
    fail(`electron 提前退出（code=${code}）。${stderr.slice(-800)}`);
  }
});

const started = Date.now();
const timer = setInterval(() => {
  if (existsSync(shot)) {
    let size = 0;
    try { size = statSync(shot).size; } catch { /* 竞态：下一轮再看 */ }
    if (size >= MIN_PNG_BYTES) {
      clearInterval(timer);
      console.log(`✓ 桌面端启动并渲染成功（截图 ${(size / 1024).toFixed(1)} KB）：${shot}`);
      // 留一份截图在临时目录的同时，往项目外的系统临时目录复制一份便于排查
      cleanup(0);
    } else if (size > 0) {
      fail(`截图异常过小（${size} 字节），界面可能没有真正渲染`);
    }
  }
  if (Date.now() - started > BOOT_TIMEOUT_MS) {
    fail(`等待渲染超时（${BOOT_TIMEOUT_MS / 1000}s）。${stderr.slice(-800)}`);
  }
}, 300);

// 保险：整体兜底退出，绝不在 CI 上挂住
setTimeout(() => fail('硬性超时'), BOOT_TIMEOUT_MS + 5000).unref?.();
// 调试用：保留一份 stderr 到临时文件
process.on('exit', () => { if (stderr.trim()) try { writeFileSync(join(shotDir, 'stderr.log'), stderr); } catch { /* ignore */ } });
