/**
 * tools/path-guard.ts —— 工作区路径安全守卫（文件工具与桌面预览共用）
 *
 * 所有"模型/界面给一个路径、harness 去读写文件"的地方都必须先过这道关：
 *   1. 相对路径以工作区为基准解析成绝对路径；
 *   2. 用**真实路径**（realpath）比对：工作区内的符号链接若指向工作区外，
 *      一律拒绝——只做字符串前缀判断的话，`ln -s /etc link` 就是越狱通道；
 *   3. 目标可能还不存在（新建文件），所以沿路径向上找到最近的已存在祖先再 realpath。
 *
 * 抽成独立模块是因为桌面端（agent-bridge 的文件浏览 / nh-file:// 预览协议）
 * 与内置文件工具需要同一套判定，不能一边防住了、一边还留着字符串前缀的旧实现。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * 把外部传入的路径解析为"确认位于工作区内"的绝对路径。
 *
 * @param workspace 工作区根目录（安全边界）
 * @param userPath  调用方给的路径（相对或绝对，允许指向尚不存在的文件）
 * @returns 校验通过后的绝对路径（保留原始大小写与写法，不做 realpath 替换）
 * @throws 路径缺失、无法解析或越出工作区时抛错（错误信息可直接回传给模型/界面）
 */
export async function resolveInside(workspace: string, userPath: unknown): Promise<string> {
  if (typeof userPath !== 'string' || !userPath) {
    throw new Error('路径参数缺失');
  }
  const abs = path.resolve(workspace, userPath); // 相对路径 → 以 workspace 为基准解析

  const root = await realRoot(workspace);
  let probe = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const full = tail.length ? path.join(real, ...tail.reverse()) : real;
      assertInside(full, root, userPath);
      return abs;
    } catch (err) {
      // 安全错误直接抛；ENOENT 说明这一段还不存在（新建文件场景），继续向上找祖先
      if ((err as Error).message.startsWith('安全限制')) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new Error(`安全限制：无法解析路径 "${userPath}"`);
      }
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** 工作区根目录的真实路径（工作区本身也可能是个符号链接） */
export async function realRoot(workspace: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(workspace));
  } catch {
    return path.resolve(workspace);
  }
}

/** 真实路径必须在工作区内：加分隔符后缀，防止 /workspace-evil 伪装成子目录 */
function assertInside(realPath: string, root: string, userPath: string): void {
  if (realPath === root || realPath.startsWith(root + path.sep)) return;
  throw new Error(
    `安全限制：路径 "${userPath}" 超出工作区边界。只能操作工作区内的文件（${root}）`,
  );
}
