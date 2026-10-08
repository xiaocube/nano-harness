/**
 * src/ipc-validation.ts —— 跨宿主（Electron / Web）可复用的入参白名单校验
 *
 * 为什么放在 core 而不是 desktop：
 *   contextIsolation 只挡住"网页直接碰 Node"，挡不住被 XSS / 依赖投毒的渲染层。
 *   凡是"渲染层 → 主进程 → 落盘 / 影响 agent 行为"的数据，都必须在信任边界处
 *   （主进程 IPC handler）再校验一次形状。这些校验是纯数据逻辑、不依赖 Electron，
 *   放进 core 既能被桌面复用，也能被 node:test 直接覆盖。
 */

import type { HarnessConfig, ModelProvider } from './config.js';

/** Agent 预设三态；与 loop.ts 的 PRESET_DEFS 键保持一致 */
export const PRESET_VALUES = ['standard', 'minimal', 'creative'] as const;
export type ValidatedPreset = (typeof PRESET_VALUES)[number];

const APPEARANCE_VALUES = new Set(['system', 'light', 'dark']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验 Agent 预设；非法/缺省返回 undefined（由调用方回落到配置） */
export function asPreset(input: unknown): ValidatedPreset | undefined {
  return typeof input === 'string' && (PRESET_VALUES as readonly string[]).includes(input)
    ? (input as ValidatedPreset)
    : undefined;
}

/**
 * 白名单式清洗"设置页写配置"的补丁：只放行已知字段并校正类型，
 * 防止渲染层把未知键 / 错误类型（甚至原型污染字段）直接存进 config.json。
 * 注意：workspace / recentWorkspaces / providers 有各自的专用通道，不允许从这里改。
 */
export function sanitizeConfigPatch(input: unknown): Partial<HarnessConfig> | { error: string } {
  if (!isObject(input)) return { error: '配置内容必须是对象' };
  const out: Partial<HarnessConfig> = {};

  if ('yolo' in input) {
    if (typeof input.yolo !== 'boolean') return { error: 'yolo 必须是布尔值' };
    out.yolo = input.yolo;
  }
  if ('maxSteps' in input) {
    const n = Number(input.maxSteps);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { error: 'maxSteps 必须是 1-100 的整数' };
    out.maxSteps = n;
  }
  if ('contextChars' in input) {
    const n = Number(input.contextChars);
    if (!Number.isFinite(n) || n < 1000) return { error: 'contextChars 必须是不小于 1000 的数字' };
    out.contextChars = Math.floor(n);
  }
  if ('appearance' in input) {
    if (typeof input.appearance !== 'string' || !APPEARANCE_VALUES.has(input.appearance)) {
      return { error: 'appearance 只能是 system/light/dark' };
    }
    out.appearance = input.appearance as HarnessConfig['appearance'];
  }
  if ('activePreset' in input) {
    if (!asPreset(input.activePreset)) {
      return { error: 'activePreset 只能是 standard/minimal/creative' };
    }
    out.activePreset = input.activePreset as ValidatedPreset as HarnessConfig['activePreset'];
  }
  if ('plugins' in input) {
    if (!isObject(input.plugins)) return { error: 'plugins 必须是对象' };
    const cleaned: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(input.plugins)) {
      if (typeof v === 'boolean') cleaned[k] = v;
    }
    out.plugins = cleaned;
  }
  return out;
}

/**
 * 校验模型提供商表单：id/name/baseUrl/model 必须是字符串，关键三项不能为空。
 * id 限字符集（它会进入配置与查找，不能允许路径/空白等奇怪字符）。
 */
export function sanitizeProvider(input: unknown): ModelProvider | { error: string } {
  if (!isObject(input)) return { error: '提供商内容必须是对象' };
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!id) return { error: '缺少提供商 id' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    return { error: '提供商 id 只能含字母、数字、点、下划线、连字符' };
  }
  if (!baseUrl) return { error: '缺少 API base_url' };
  if (!model) return { error: '缺少模型名' };
  return {
    id,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id,
    baseUrl,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
    model,
  };
}

/** 校验一个普通字符串 ID（会话文件名之外的用途，如插件名/提供商 id 的存在性入口） */
export function asNonEmptyString(input: unknown, label = '参数'): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined;
}
