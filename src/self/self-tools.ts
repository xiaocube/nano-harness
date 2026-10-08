/**
 * self/self-tools.ts —— 自改进模式的受限工具集
 *
 * 与标准模式的差别是"能力最小化"：
 *   - 保留 read_file / list_dir / write_file / edit_file（复用同一套实现，
 *     但换上更严格的路径守卫，连读都不许进 .git / node_modules / 构建产物）；
 *   - 新增 run_check：跑主管写死的质量闸门（模型不能指定命令）；
 *   - 新增 git_status：只读查看分支/改动/最近提交；
 *   - **没有 run_bash、没有联网、没有安装依赖、没有提交工具**——
 *     提交与否由 supervisor 在闸门通过后代劳。
 */

import * as path from 'node:path';
import type { Tool } from '../tools/index.js';
import { buildFsTools } from '../tools/fs-tools.js';
import { resolveInside } from '../tools/path-guard.js';

/** 自改进模式禁止触碰的路径前缀（相对仓库根，用 '/' 分隔比较） */
const FORBIDDEN_PREFIXES = [
  '.git',
  '.nano-self',
  'node_modules',
  'dist',
  'dist-desktop',
  'release',
  'web/dist',
];

/** 更严格的工作区守卫：先过通用围栏，再拒绝产物/元数据目录 */
async function selfGuard(workspace: string, userPath: unknown): Promise<string> {
  const abs = await resolveInside(workspace, userPath);
  const rel = path.relative(workspace, abs).split(path.sep).join('/');
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (rel === prefix || rel.startsWith(prefix + '/')) {
      throw new Error(`安全限制：自改进模式不允许读写 ${prefix} 目录（${userPath}）`);
    }
  }
  return abs;
}

export interface SelfToolDeps {
  /** 运行质量闸门（主管注入；命令固定，工具参数无法影响要跑什么） */
  runCheck: () => Promise<{ ok: boolean; text: string }>;
  /** 只读 git 状态 */
  gitStatus: () => Promise<string>;
}

/** 构造自改进回合要用的全部工具（作为 runAgentTurn 的 opts.tools 注入） */
export function buildSelfTools(deps: SelfToolDeps): Tool[] {
  const fsTools = buildFsTools(selfGuard);

  const runCheck: Tool = {
    name: 'run_check',
    description:
      '运行本项目的质量闸门（类型检查 + 构建 + 全部自动化测试，约几秒到几十秒），' +
      '返回完整结果；退出码 0 表示通过，非 0 时输出里含失败原因。' +
      '动手改代码前后都应运行：先了解基线，改完确认没有改坏。命令由系统固定，你不能指定其它命令。',
    parameters: { type: 'object', properties: {}, required: [] },
    needsPermission: false, // 跑的是只读/构建型固定检查，自改进模式下自动执行
    describe: () => '运行质量闸门 npm run check',
    execute: async () => {
      const r = await deps.runCheck();
      return `${r.text}\n[结论：${r.ok ? '闸门通过 ✅' : '闸门失败 ❌（请据此修复）'}]`;
    },
  };

  const gitStatus: Tool = {
    name: 'git_status',
    description:
      '查看当前 git 状态：所在分支、相对上次提交的改动清单（含未跟踪文件）、最近 5 条提交。' +
      '只读，不会改动任何东西。用来确认你的修改范围，以及是否还有没处理的改动。',
    parameters: { type: 'object', properties: {}, required: [] },
    needsPermission: false,
    describe: () => '查看 git 状态（只读）',
    execute: async () => deps.gitStatus(),
  };

  // 文件工具在自改进模式下同样自动放行（整个进程本就是无人值守、且只能动仓库内文件）
  for (const t of fsTools) t.needsPermission = false;

  return [...fsTools, runCheck, gitStatus];
}
