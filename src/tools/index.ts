/**
 * tools/index.ts —— 工具注册表
 *
 * "工具"是模型的手脚：模型本体只会生成文字，它能"读文件"、"跑命令"，
 * 是因为 harness 在这里登记了这些能力，并把说明书（description + JSON Schema）
 * 发给模型；模型按说明书生成"调用意图"，harness 替它真正执行。
 *
 * 模块化设计：新增一个工具 = 新写一个 Tool 对象 + registerTool() 一行。
 * 对 harness 其余部分零侵入——这就是插件化架构的最小形态。
 */

import type { OpenAITool } from '../llm.js';
import type { HarnessConfig } from '../config.js';

/** 工具执行时能拿到的环境上下文 */
export interface ToolContext {
  /** 工作区根目录：所有文件操作都被限制在这个目录内（安全边界） */
  workspace: string;
  /** 当前配置 */
  cfg: HarnessConfig;
}

/** 一个工具 = 说明书（给模型）+ 执行器（给 harness）+ 权限标记（给用户） */
export interface Tool {
  /** 工具名：模型按名字调用，需符合 ^[a-z0-9_]+$ */
  name: string;
  /** 给模型看的功能描述——写得越清楚，模型用得越准（上下文工程的第一战场） */
  description: string;
  /** 参数的 JSON Schema：约束模型生成的调用参数格式 */
  parameters: Record<string, unknown>;
  /** true = 执行前必须征得用户同意（危险操作） */
  needsPermission: boolean;
  /** 生成一行人类可读的参数摘要，用于终端展示和权限确认框 */
  describe: (args: Record<string, unknown>) => string;
  /** 真正的执行逻辑：入参是模型给的参数（已解析），返回文本结果回填给模型 */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

/** 注册表本体：工具名 → 工具对象 */
const registry = new Map<string, Tool>();

/** 登记一个工具 */
export function registerTool(tool: Tool): void {
  if (registry.has(tool.name)) {
    throw new Error(`工具重名：${tool.name}`);
  }
  registry.set(tool.name, tool);
}

/** 按名取工具（模型调用了不存在的工具时返回 undefined，由 loop 层兜底报错） */
export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

/** 列出所有工具（/tools 命令用） */
export function listTools(): Tool[] {
  return [...registry.values()];
}

/** 把注册表翻译成 OpenAI function calling 格式，随每次请求发给模型 */
export function toOpenAITools(): OpenAITool[] {
  return listTools().map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * 一次性注册本项目全部内置工具。
 * cli.ts 启动时调用一次。以后你想加"网页抓取"、"数据库查询"等工具，
 * 只需新建文件实现 Tool 接口，然后在这里 import 并 registerTool。
 */
export async function registerBuiltinTools(): Promise<void> {
  const { registerFsTools } = await import('./fs-tools.js');
  const { registerBashTool } = await import('./bash-tool.js');
  registerFsTools();
  registerBashTool();
}
