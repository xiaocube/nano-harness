/**
 * tools/fs-tools.ts —— 文件类工具
 *
 * 提供 read_file / write_file / edit_file / list_dir 四个工具。
 *
 * 安全设计（harness 的护栏之一）：
 *   1. 路径越界防护——所有路径必须落在工作区内。模型偶尔会"异想天开"去读写
 *      /etc/passwd 或 ~/.ssh，guardPath() 会直接拒绝。
 *   2. 输出截断——大文件只返回前 N 字符，防止撑爆上下文窗口（token 是钱）。
 *   3. 写操作标记 needsPermission——真正执行前由 permission 层向用户确认。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { registerTool } from './index.js';
import type { Tool, ToolContext } from './index.js';
import { resolveInside as guardPath } from './path-guard.js';

/** 单次返回给模型的最大字符数（约 10k token，够用又不烧钱） */
const MAX_OUTPUT = 40_000;
/** 目录列表最多条目数 */
const MAX_ENTRIES = 500;

/**
 * 构造四个文件工具。默认注册时用工作区路径守卫 guardPath；
 * 自改进守护进程（src/self）会传入"额外禁止写 .git / 自身状态目录"的更严格守卫，
 * 复用同一套实现而不复制逻辑。
 *
 * @param guard 路径解析+安全边界校验函数（默认 = resolveInside 工作区围栏）
 */
export function buildFsTools(guard: (workspace: string, userPath: unknown) => Promise<string>): Tool[] {
  /* ---------- read_file ---------- */
  const readFile: Tool = {
    name: 'read_file',
    description:
      '读取工作区内一个文本文件的内容。返回文件全文（超长会被截断）。' +
      '修改文件前应先用它查看现状。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于工作区或工作区内的绝对路径' },
        offset: { type: 'number', description: '从第几个字符开始读（默认 0）。被截断后用它继续读后续部分' },
        limit: { type: 'number', description: '最多读多少个字符（默认 40000，上限 40000）' },
      },
      required: ['path'],
    },
    needsPermission: false, // 只读不危险
    describe: (args) => String(args.path ?? ''),
    execute: async (args, ctx) => {
      const abs = await guard(ctx.workspace, args.path);
      const content = await fs.readFile(abs, 'utf8');
      // offset/limit 让模型能分段读完大文件（否则尾部永远读不到）
      const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
      const limit = Math.min(MAX_OUTPUT, Math.max(1, Math.floor(Number(args.limit ?? MAX_OUTPUT)) || MAX_OUTPUT));
      if (offset === 0 && content.length <= limit) return content;
      const slice = content.slice(offset, offset + limit);
      const next = offset + slice.length;
      const more = next < content.length
        ? `\n\n[已读 ${offset}-${next} / 共 ${content.length} 字符，继续读请用 offset=${next}]`
        : `\n\n[已读 ${offset}-${next} / 共 ${content.length} 字符，文件已读完]`;
      return slice + more;
    },
  };

  /* ---------- write_file ---------- */
  const writeFile: Tool = {
    name: 'write_file',
    description:
      '把内容写入工作区内的文件（整个文件被覆盖；父目录不存在会自动创建）。' +
      '属于破坏性操作，执行前会征求用户同意。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
    needsPermission: true, // 覆盖文件 = 破坏性操作
    describe: (args) => `${args.path}（${String(args.content ?? '').length} 字符）`,
    execute: async (args, ctx) => {
      const abs = await guard(ctx.workspace, args.path);
      const content = String(args.content ?? '');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return `已写入 ${abs}，共 ${content.length} 字符。`;
    },
  };

  /* ---------- edit_file ---------- */
  const editFile: Tool = {
    name: 'edit_file',
    description:
      '精确替换文件中的一段文本：在文件中查找 old_string（必须恰好出现一次），' +
      '替换为 new_string。适合小改动；大范围改写请用 write_file。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径' },
        old_string: { type: 'string', description: '要被替换的原文片段，必须与文件内容逐字符一致，且在全文中唯一' },
        new_string: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    needsPermission: true,
    describe: (args) => `${args.path}（替换 ${String(args.old_string ?? '').length} 字符片段）`,
    execute: async (args, ctx) => {
      const abs = await guard(ctx.workspace, args.path);
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) {
        return '错误：old_string 不能为空。新建文件请用 write_file。';
      }
      const content = await fs.readFile(abs, 'utf8');
      // 唯一性校验：出现 0 次说明模型记错了原文；出现多次则替换会误伤，都拒绝执行
      const first = content.indexOf(oldStr);
      if (first === -1) {
        return `错误：old_string 在文件中不存在。请先用 read_file 确认原文（注意空格与缩进）。`;
      }
      if (content.indexOf(oldStr, first + 1) !== -1) {
        return `错误：old_string 在文件中出现了多次，为避免误伤已取消。请提供更长、唯一的片段。`;
      }
      const updated = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
      await fs.writeFile(abs, updated, 'utf8');
      return `已替换 ${abs} 中的片段（${oldStr.length} → ${newStr.length} 字符）。`;
    },
  };

  /* ---------- list_dir ---------- */
  const listDir: Tool = {
    name: 'list_dir',
    description: '列出工作区内某个目录的内容（目录以 / 结尾标记）。了解项目结构时使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认为工作区根目录' },
      },
      required: [],
    },
    needsPermission: false,
    describe: (args) => String(args.path ?? '.'),
    execute: async (args, ctx) => {
      const abs = await guard(ctx.workspace, args.path ?? '.');
      const entries = await fs.readdir(abs, { withFileTypes: true });
      if (entries.length === 0) return '(空目录)';
      // 目录排前、文件排后，各按名称排序，模型读起来更省 token
      const sorted = entries.sort((a, b) => {
        const dirDiff = Number(b.isDirectory()) - Number(a.isDirectory());
        return dirDiff !== 0 ? dirDiff : a.name.localeCompare(b.name);
      });
      const lines = sorted.slice(0, MAX_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      const suffix = sorted.length > MAX_ENTRIES ? `\n[仅显示前 ${MAX_ENTRIES} 项]` : '';
      return lines.join('\n') + suffix;
    },
  };

  // 返回四个工具（顺序稳定，测试与受限工具集依赖它）
  return [readFile, writeFile, editFile, listDir];
}

/** 四个文件工具的统一注册入口（由 tools/index.ts 调用），使用默认工作区围栏 */
export function registerFsTools(): void {
  // 注意不能用 forEach(registerTool)，会把索引误当 owner
  for (const tool of buildFsTools(guardPath)) {
    registerTool(tool);
  }
}

/** 供 loop 层在权限确认框里展示写操作内容预览 */
export async function previewForPermission(args: Record<string, unknown>): Promise<string> {
  const clip = (text: string, maxLines = 15): string => {
    const lines = text.split('\n');
    const head = lines.slice(0, maxLines).join('\n');
    return lines.length > maxLines ? `${head}\n…（共 ${lines.length} 行）` : head;
  };
  // edit_file 的参数是 old/new 两段文本：不预览的话用户是在"批准一次看不见的改动"
  if ('old_string' in args || 'new_string' in args) {
    const del = clip(String(args.old_string ?? ''), 8);
    const add = clip(String(args.new_string ?? ''), 8);
    return `将要删除的片段：\n${del}\n\n将要替换为：\n${add}`;
  }
  return clip(String(args.content ?? ''));
}
