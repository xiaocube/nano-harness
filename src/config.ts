/**
 * config.ts —— 配置层
 *
 * harness 要做到"傻瓜式"，配置必须分层且永远有一个兜底值。优先级从高到低：
 *   1. 命令行参数（cli.ts 传入后覆盖）
 *   2. 环境变量（NANO_HARNESS_*，适合 CI/服务器场景）
 *   3. 配置文件（~/.nano-harness/config.json，首启向导写入，长期生效）
 *   4. 代码内默认值
 *
 * 核心设计：模型接入走 OpenAI 兼容协议（chat/completions），
 * 所以"换厂商"只是换 base_url + model 两个字符串，harness 其余代码零改动。
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** harness 运行所需的全部配置 */
export interface HarnessConfig {
  /** OpenAI 兼容 API 的根地址（不含 /chat/completions，llm.ts 会自动拼接） */
  baseUrl: string;
  /** API Key；Ollama 本地模型可以留空 */
  apiKey: string;
  /** 模型名，如 deepseek-chat / glm-4-flash / qwen3:8b */
  model: string;
  /** Agent Loop 最大步数（防止模型无限循环烧 token） */
  maxSteps: number;
  /** YOLO 模式：true 时跳过所有危险操作确认（仅建议在容器/沙箱里开） */
  yolo: boolean;
  /** 触发上下文压缩的字符数阈值（粗略对应 ~20k token） */
  contextChars: number;
  /** 桌面版外观：跟随系统/浅色/深色（CLI 忽略此项） */
  appearance?: 'system' | 'light' | 'dark';
}

/** 配置目录：~/.nano-harness/（配置文件、会话记录都放这里） */
export const CONFIG_DIR = join(homedir(), '.nano-harness');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * 内置厂商预设——"傻瓜式"的体现：用户只需选个数字、粘个 Key。
 * 全部走 OpenAI 兼容协议，选谁都是同一套代码。
 */
export const PRESETS = [
  {
    key: 'deepseek',
    label: 'DeepSeek（便宜、国内直连）',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    needsKey: true,
    keyHint: '在 https://platform.deepseek.com 注册并创建 API Key',
  },
  {
    key: 'zhipu',
    label: '智谱 GLM（有免费额度、国内直连）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    needsKey: true,
    keyHint: '在 https://open.bigmodel.cn 注册后于"API Keys"页面创建',
  },
  {
    key: 'ollama',
    label: 'Ollama 本地模型（完全免费、离线）',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen3:8b',
    needsKey: false,
    keyHint: '无需 Key，但需先安装 Ollama 并 ollama pull 一个模型',
  },
  {
    key: 'custom',
    label: '自定义（任何 OpenAI 兼容端点）',
    baseUrl: '',
    defaultModel: '',
    needsKey: false,
    keyHint: '填入你的 base_url / api_key / 模型名',
  },
] as const;

/** 代码内默认值（最低优先级的兜底） */
const DEFAULTS: HarnessConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  maxSteps: 25,
  yolo: false,
  contextChars: 48_000,
  appearance: 'system',
};

/** 配置文件是否已存在（用于判断要不要跑首启向导） */
export async function configExists(): Promise<boolean> {
  try {
    await fs.access(CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 加载配置：文件 → 环境变量覆盖 → 默认值兜底。
 * 注意顺序：先拿默认值，再叠文件，再叠环境变量，最后由 cli.ts 叠命令行参数。
 */
export async function loadConfig(): Promise<HarnessConfig> {
  const cfg: HarnessConfig = { ...DEFAULTS };
  // ① 尝试读配置文件（不存在/损坏则静默跳过，回落到默认值）
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')) as Partial<HarnessConfig>;
    if (typeof raw.baseUrl === 'string' && raw.baseUrl) cfg.baseUrl = raw.baseUrl;
    if (typeof raw.apiKey === 'string') cfg.apiKey = raw.apiKey;
    if (typeof raw.model === 'string' && raw.model) cfg.model = raw.model;
    if (typeof raw.maxSteps === 'number' && raw.maxSteps > 0) cfg.maxSteps = raw.maxSteps;
    if (typeof raw.yolo === 'boolean') cfg.yolo = raw.yolo;
    if (typeof raw.contextChars === 'number' && raw.contextChars > 0) cfg.contextChars = raw.contextChars;
    if (raw.appearance === 'system' || raw.appearance === 'light' || raw.appearance === 'dark') {
      cfg.appearance = raw.appearance;
    }
  } catch {
    // 首次运行或文件损坏：用默认值，不报错
  }
  // ② 环境变量覆盖（CI/服务器常用，避免把密钥写进文件）
  if (process.env.NANO_HARNESS_BASE_URL) cfg.baseUrl = process.env.NANO_HARNESS_BASE_URL;
  if (process.env.NANO_HARNESS_API_KEY) cfg.apiKey = process.env.NANO_HARNESS_API_KEY;
  if (process.env.NANO_HARNESS_MODEL) cfg.model = process.env.NANO_HARNESS_MODEL;
  return cfg;
}

/** 保存配置（首启向导、/model 命令都会调用） */
export async function saveConfig(cfg: HarnessConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * 判断当前配置是否"可用"：有 base_url + model，且（不需要 key 或已填 key）。
 * cli.ts 用它决定要不要先跑首启向导。
 */
export function isConfigUsable(cfg: HarnessConfig): boolean {
  const local = cfg.baseUrl.includes('localhost') || cfg.baseUrl.includes('127.0.0.');
  return Boolean(cfg.baseUrl && cfg.model && (cfg.apiKey || local));
}
