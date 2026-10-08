/**
 * version.ts —— 应用版本号的唯一来源
 *
 * 以前版本号在 cli.ts / ui.ts / 桌面 mock 里各写死一份，
 * 每次发版要改四处，漏改一处就出现"--version 显示 0.4.0、关于页显示 0.4.1"。
 * 统一从 package.json 读取：
 *   - 开发/CLI：dist/version.js → 上一级 package.json；
 *   - 打包后：app.asar/dist/version.js → app.asar/package.json（electron-builder 会打入）。
 * 读不到（极端的文件丢失）时回落到底部常量，保证任何路径都有版本可显示。
 */

import { createRequire } from 'node:module';

/** 兜底版本：仅在 package.json 不可读时使用，发版前与 package.json 保持一致 */
const FALLBACK_VERSION = '0.5.0';

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // 落到兜底值
  }
  return FALLBACK_VERSION;
}

export const APP_VERSION = readVersion();
