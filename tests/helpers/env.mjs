/**
 * tests/helpers/env.mjs —— 测试环境准备
 *
 * 每个测试文件在 import 被测模块**之前**调用 isolateHome()：
 * 把 NANO_HARNESS_HOME 指向一个临时目录，测试永远不会碰到
 * 用户真实的 ~/.nano-harness/config.json（里面有 API Key）。
 *
 * 为什么必须"先设置再 import"：src/config.ts 在模块加载时就计算了
 * CONFIG_DIR/CONFIG_FILE，所以被测模块一律用动态 import()。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 造一个隔离的配置目录，返回它的路径 */
export function isolateHome(prefix = 'nh-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.NANO_HARNESS_HOME = dir;
  return dir;
}

/** 清理测试目录 */
export function cleanupHome(dir) {
  rmSync(dir, { recursive: true, force: true });
}
