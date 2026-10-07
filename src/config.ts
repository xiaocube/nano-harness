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
import { join, resolve as resolvePath } from 'node:path';

/** 一个模型提供商（OpenAI 兼容端点 + 凭据 + 默认模型） */
export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Agent 预设：决定系统提示词与可用工具白名单 */
export type AgentPreset = 'standard' | 'minimal' | 'creative';

/** harness 运行所需的全部配置 */
export interface HarnessConfig {
  /** OpenAI 兼容 API 的根地址（不含 /chat/completions，llm.ts 会自动拼接） */
  baseUrl: string;
  /** API Key；Ollama 本地模型可以留空 */
  apiKey: string;
  /** 模型名，如 deepseek-chat / glm-4-flash / qwen3:8b */
  model: string;
  /**
   * 模型提供商列表（v0.3 起）。为空时由 baseUrl/apiKey/model 自动迁移生成，
   * 这三个旧字段保留为"第一个提供商"的镜像，旧配置无缝升级。
   */
  providers?: ModelProvider[];
  /** 当前使用的提供商 id */
  activeProviderId?: string;
  /** 当前 Agent 预设（默认 standard） */
  activePreset?: AgentPreset;
  /** Agent Loop 最大步数（防止模型无限循环烧 token） */
  maxSteps: number;
  /** YOLO 模式：true 时跳过所有危险操作确认（仅建议在容器/沙箱里开） */
  yolo: boolean;
  /** 触发上下文压缩的字符数阈值（粗略对应 ~20k token） */
  contextChars: number;
  /** 桌面版外观：跟随系统/浅色/深色（CLI 忽略此项） */
  appearance?: 'system' | 'light' | 'dark';
  /** 插件启用状态表：缺省视为启用，{ "名字": false } 表示禁用 */
  plugins?: Record<string, boolean>;
  /**
   * 上次使用的**工作区绝对路径**（桌面端）。
   * 所有文件工具的路径边界就是它——不持久化的话，用户每次打开 App
   * 都得重新选一遍文件夹（v0.3.1 修复）。
   */
  workspace?: string;
  /** 最近打开过的工作区（最多 8 个，供"最近使用"快捷切换） */
  recentWorkspaces?: string[];
}

/** 取当前生效的提供商（找不到 active 时回落第一个，再回落旧字段） */
export function getActiveProvider(cfg: HarnessConfig): ModelProvider {
  const list = cfg.providers ?? [];
  const active = list.find((p) => p.id === cfg.activeProviderId) ?? list[0];
  if (active) return active;
  return { id: 'default', name: '默认提供商', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model };
}

/**
 * 配置目录：默认 ~/.nano-harness/（配置文件、会话记录都放这里）。
 * 可用环境变量 NANO_HARNESS_HOME 整体搬走——自动化测试要隔离，
 * 想做成"绿色版"（配置跟着项目走、不碰用户家目录）的用户也用得上。
 */
export const CONFIG_DIR = process.env.NANO_HARNESS_HOME
  ? resolvePath(process.env.NANO_HARNESS_HOME)
  : join(homedir(), '.nano-harness');
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
    if (raw.plugins && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins)) {
      cfg.plugins = raw.plugins;
    }
    // 工作区（桌面端）：只接受绝对路径字符串，脏数据直接忽略
    if (typeof raw.workspace === 'string' && raw.workspace.trim()) {
      cfg.workspace = raw.workspace.trim();
    }
    if (Array.isArray(raw.recentWorkspaces)) {
      cfg.recentWorkspaces = raw.recentWorkspaces
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .slice(0, 8);
    }
    // 提供商列表与激活项（v0.3 多提供商）
    if (Array.isArray(raw.providers) && raw.providers.length > 0) {
      cfg.providers = raw.providers.filter(
        (p) => p && typeof p.id === 'string' && typeof p.baseUrl === 'string',
      );
      cfg.activeProviderId =
        typeof raw.activeProviderId === 'string' ? raw.activeProviderId : cfg.providers[0]?.id;
    }
    if (raw.activePreset === 'standard' || raw.activePreset === 'minimal' || raw.activePreset === 'creative') {
      cfg.activePreset = raw.activePreset;
    }
  } catch {
    // 首次运行或文件损坏：用默认值，不报错
  }
  // ② 环境变量覆盖（CI/服务器常用，避免把密钥写进文件）
    const envBase = process.env.NANO_HARNESS_BASE_URL;
    const envKey = process.env.NANO_HARNESS_API_KEY;
    const envModel = process.env.NANO_HARNESS_MODEL;
    if (envBase) cfg.baseUrl = envBase;
    if (envKey) cfg.apiKey = envKey;
    if (envModel) cfg.model = envModel;

    if (!cfg.providers || cfg.providers.length === 0) {
      // 旧配置自动迁移：把 baseUrl/apiKey/model 打包成第一个提供商
      cfg.providers = [{ id: 'default', name: '默认提供商', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model }];
      cfg.activeProviderId = 'default';
    } else if (envBase || envKey || envModel) {
      // 已有提供商列表时，环境变量还必须覆盖进**当前提供商**：
      // callChat 读的是 getActiveProvider(cfg)，只改顶层字段等于没改（真实 bug）。
      const active = getActiveProvider(cfg);
      const merged: ModelProvider = {
        ...active,
        ...(envBase ? { baseUrl: envBase } : {}),
        ...(envKey ? { apiKey: envKey } : {}),
        ...(envModel ? { model: envModel } : {}),
      };
      cfg.providers = cfg.providers.map((p) => (p.id === active.id ? merged : p));
      cfg.activeProviderId = active.id;
      cfg.baseUrl = merged.baseUrl;
      cfg.apiKey = merged.apiKey;
      cfg.model = merged.model;
    }
    return cfg;
  }

/** 保存配置（首启向导、/model 命令都会调用） */
export async function saveConfig(cfg: HarnessConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(cfg, null, 2) + '\n';
  // 配置里有 API Key：权限收紧到 0600；且用"临时文件 + rename"原子替换，
  // 避免写到一半被打断后留下半截 JSON（那会让用户莫名其妙回到默认配置）。
  const tmp = `${CONFIG_FILE}.tmp`;
  await fs.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, CONFIG_FILE);
  // writeFile 的 mode 只在新建文件时生效，覆盖已有文件要显式改权限
  await fs.chmod(CONFIG_FILE, 0o600).catch(() => { /* Windows 等不支持的环境忽略 */ });
}

/**
 * 判断当前配置是否"可用"：有 base_url + model，且（不需要 key 或已填 key）。
 * cli.ts 用它决定要不要先跑首启向导。
 */
export function isConfigUsable(cfg: HarnessConfig): boolean {
  // 必须看**当前提供商**：顶层的 baseUrl/apiKey/model 只是旧字段的镜像，
  // 真正发请求用的是 getActiveProvider(cfg)。
  const p = getActiveProvider(cfg);
  const local = p.baseUrl.includes('localhost') || p.baseUrl.includes('127.0.0.');
  return Boolean(p.baseUrl && p.model && (p.apiKey || local));
}
