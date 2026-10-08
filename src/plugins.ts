/**
 * plugins.ts —— 插件系统（市场 + 加载器）
 *
 * 设计哲学与 dsh 的"一切皆插件"同源：
 *   插件 = 一个文件夹 = plugin.json（说明书）+ tools.mjs（导出 Tool[]）。
 *   插件工具与内置工具**完全同构**——插件作者面对的就是 src/tools/index.ts 里的
 *   Tool 接口，所以"写一个插件"和"给 harness 内置一个工具"是同一件事，
 *   这就是可 DIY 的关键。
 *
 * 分发采用 GitHub 索引制（v1）：
 *   - 市场索引是主仓库里的 marketplace/index.json；
 *   - 安装 = 从索引条目指定的来源拉取文件，解压到 ~/.nano-harness/plugins/<name>/；
 *   - 上传 = 向索引提 PR（开源社区标准玩法，免自建服务器）。
 *   - 支持两种来源：bundled（随安装包内置，离线可用）/ github（仓库 tarball）。
 *
 * 启用/禁用：状态存于配置文件（cfg.plugins["名字"] = false 表示禁用），
 * 通过 setPluginEnabled 可以**不重启**实时生效——注册表按提供者归属，禁用即注销。
 *
 * ⚠ 安全须知（v1 如实声明）：插件代码在 harness 进程内运行，拥有与 harness
 * 相同的权限（可访问文件系统与网络）。安装第三方插件前请先看它的源码。
 * 沙箱化插件运行时（worker/子进程 + 权限声明）在路线图中。
 */

import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { registerTool, unregisterByOwner, listTools, type Tool } from './tools/index.js';
import { CONFIG_DIR, type HarnessConfig } from './config.js';

/** 插件安装目录 */
export const PLUGINS_DIR = path.join(CONFIG_DIR, 'plugins');

/**
 * 项目资源定位：marketplace/ 与 examples/ 随仓库分发。
 * 开发时用 cwd（= 仓库根）；打包成 .app 后 cwd 不再是仓库，
 * 所以按"本模块位置"向上推导（dist/plugins.js → 仓库根；asar 包内同理）。
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..');

function resourcePath(...segments: string[]): string {
  const bundled = path.join(PROJECT_ROOT, ...segments);
  if (fsSync.existsSync(bundled)) return bundled;
  return path.join(process.cwd(), ...segments); // 兜底：某些宿主从仓库根启动
}

/** 插件说明书（plugin.json） */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  /** 工具模块文件名，默认 tools.mjs */
  main?: string;
}

/** 磁盘上一个已安装插件的完整信息 */
export interface InstalledPlugin {
  manifest: PluginManifest;
  /** 插件安装目录绝对路径 */
  dir: string;
  /** 该插件提供的工具名 */
  toolNames: string[];
  /** 加载失败时的原因（正常安装为 null） */
  loadError: string | null;
  /** 当前是否启用（配置驱动） */
  enabled: boolean;
}

/** 市场索引条目（marketplace/index.json 里的一个插件） */
export interface MarketplaceEntry {
  name: string;
  title: string;
  description: string;
  author: string;
  version: string;
  keywords?: string[];
  source:
    | { type: 'bundled'; dir: string }                       // 随安装包内置的示例插件
    | { type: 'github'; repo: string; subdir?: string };     // GitHub 仓库（可指定子目录）
}

/** 市场索引文件结构 */
export interface MarketplaceIndex {
  version: number;
  plugins: MarketplaceEntry[];
}

/**
 * 插件名守卫：名字会参与文件路径、进程参数，甚至"删除目录"。
 * 允许字符限定在 [A-Za-z0-9._-]，且禁止 . / .. —— 否则
 * name = "../../sessions" 就能让安装流程 rm -rf 掉会话目录。
 */
const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function assertPluginName(name: unknown): string {
  if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name) || name === '.' || name === '..') {
    throw new Error(`非法的插件名：${String(name)}（只允许字母、数字、点、下划线、连字符）`);
  }
  if (name === 'builtin') {
    throw new Error('插件名 "builtin" 是保留名（内置工具的归属标记）');
  }
  return name;
}

/** 插件目录是否启用（缺省 = 启用） */
export function isEnabled(cfg: HarnessConfig | undefined, name: string): boolean {
  return cfg?.plugins?.[name] !== false;
}

/** 动态 import 插件模块并校验 Tool[] 形状；不负责注册 */
async function importPluginTools(dir: string, manifest: PluginManifest): Promise<Tool[]> {
  const mainFile = path.join(dir, manifest.main ?? 'tools.mjs');
  const mod = await import(pathToFileURL(mainFile).href) as {
    tools?: unknown;
    default?: { tools?: unknown };
  };
  // 约定：命名导出 tools 或默认导出 { tools } 均可
  const tools = mod.tools ?? mod.default?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('插件模块必须导出 tools 数组（命名导出或默认导出均可）');
  }
  // 形状校验：
  //   - name/execute/description 必须合规（坏工具会让每次模型请求 400，拖垮整个 harness）；
  //   - 工具名必须匹配 OpenAI function calling 允许的字符集；
  //   - describe 缺失时补一个：loop 会调用它生成摘要，缺了会抛异常并把
  //     未闭合的 tool_calls 留在历史里（协议非法，之后每次请求都 400）。
  const valid: Tool[] = [];
  const rejected: string[] = [];
  for (const raw of tools) {
    const t = raw as Partial<Tool> | null;
    if (!t || typeof t !== 'object') { rejected.push(String(t)); continue; }
    if (typeof t.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/.test(t.name) || t.name.includes('..')) {
      rejected.push(typeof t.name === 'string' ? t.name : '(无名)');
      continue;
    }
    if (typeof t.execute !== 'function' || typeof t.description !== 'string') {
      rejected.push(t.name);
      continue;
    }
    valid.push({
      ...(t as Tool),
      // 缺 parameters 时给空 schema：OpenAI 协议要求该字段存在，undefined 会让端点 400
      parameters: (t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} }) as Tool['parameters'],
      needsPermission: t.needsPermission !== false, // 没显式声明为 false 时，按危险工具处理（默认安全）
      describe: typeof t.describe === 'function' ? t.describe : () => t.name as string,
    });
  }
  if (valid.length === 0) {
    throw new Error(`插件没有提供任何合法工具（被拒绝的工具：${rejected.join(', ') || '空数组'}）。工具名须以字母或数字开头，只能含字母、数字、点、下划线、连字符，且不超过 64 个字符`);
  }
  return valid;
}

/** 读取插件目录（不注册），返回清单 + 工具名 + 启用状态 */
async function inspectPluginDir(dir: string, cfg: HarnessConfig | undefined): Promise<InstalledPlugin> {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8')) as PluginManifest;
  } catch (err) {
    return {
      manifest: { name: path.basename(dir), version: '?', description: '', author: '?' },
      dir, toolNames: [],
      loadError: `plugin.json 读取失败：${(err as Error).message}`,
      enabled: false,
    };
  }
  const enabled = isEnabled(cfg, manifest.name);
  // 禁用的插件**绝不 import**：import 会执行模块顶层代码（可能联网/读文件），
  // 只在"注册工具"这一步拦是拦不住的——那等于禁用了个寂寞。
  if (!enabled) {
    return { manifest, dir, toolNames: [], loadError: null, enabled: false };
  }
  try {
    const tools = await importPluginTools(dir, manifest);
    return { manifest, dir, toolNames: tools.map((t) => t.name), loadError: null, enabled };
  } catch (err) {
    return { manifest, dir, toolNames: [], loadError: `工具加载失败：${(err as Error).message}`, enabled };
  }
}

/** 扫描插件目录，注册所有"已启用"插件的工具（宿主启动时调用一次） */
export async function loadInstalledPlugins(cfg: HarnessConfig | undefined, register = true): Promise<InstalledPlugin[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(PLUGINS_DIR);
  } catch {
    return []; // 目录不存在 = 没装过插件
  }
  const results: InstalledPlugin[] = [];
  for (const name of names.filter((n) => !n.startsWith('.') && PLUGIN_NAME_RE.test(n))) {
    const dir = path.join(PLUGINS_DIR, name);
    // 目录里可能有断链符号链接（或被并发删掉）：stat 失败就跳过这一个，
    // 不能让一个坏条目把整个启动流程搞崩（原来的行为是 main() reject + exit 1）。
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const info = await inspectPluginDir(dir, cfg);
    // 启用且加载成功才注册；注册时打上归属标记（插件名），禁用时可成批注销
    if (register && info.enabled && !info.loadError) {
      const tools = await importPluginTools(dir, info.manifest);
      for (const tool of tools) {
        if (!listTools().some((t) => t.name === tool.name)) {
          registerTool(tool, pluginOwner(info.manifest.name));
        }
      }
    }
    results.push(info);
  }
  return results;
}

/** 已安装插件列表（不注册工具，仅供 UI 展示） */
export async function listInstalled(cfg: HarnessConfig | undefined): Promise<InstalledPlugin[]> {
  return loadInstalledPlugins(cfg, false);
}

/**
 * 切换插件启用状态（实时生效，无需重启）：
 * 启用 = 加载其模块并把工具注册进注册表；禁用 = 按归属批量注销工具。
 */
export async function setPluginEnabled(
  name: string,
  enabled: boolean,
  cfg: HarnessConfig,
): Promise<{ ok: boolean; message: string }> {
  try {
    assertPluginName(name);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  const dir = path.join(PLUGINS_DIR, name);
  if (!fsSync.existsSync(path.join(dir, 'plugin.json'))) {
    return { ok: false, message: `未找到插件 ${name}` };
  }
  if (enabled) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8')) as PluginManifest;
      const tools = await importPluginTools(dir, manifest);
      let registered = 0;
      for (const tool of tools) {
        if (!listTools().some((t) => t.name === tool.name)) {
          registerTool(tool, pluginOwner(name));
          registered++;
        }
      }
      return { ok: true, message: `已启用 ${name}（注册 ${registered} 个工具）` };
    } catch (err) {
      return { ok: false, message: `启用失败：${(err as Error).message}` };
    }
  }
  const removed = unregisterByOwner(pluginOwner(name));
  return { ok: true, message: `已禁用 ${name}（移除 ${removed} 个工具）` };
}

/** 卸载插件：先注销其工具，再删除目录 */
export async function uninstallPlugin(name: string): Promise<void> {
  assertPluginName(name);
  unregisterByOwner(pluginOwner(name));
  await fs.rm(path.join(PLUGINS_DIR, assertPluginName(name)), { recursive: true, force: true });
}

/**
 * 从市场条目安装插件到 ~/.nano-harness/plugins/<name>/。
 * bundled 来源 = 复制包内示例（离线可用）；github 来源 = 下载仓库 tarball 解压。
 */
export async function installFromEntry(entry: MarketplaceEntry): Promise<{ ok: boolean; message: string }> {
  let name: string;
  try {
    name = assertPluginName(entry.name);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  const dest = path.join(PLUGINS_DIR, name);
  let tarball: string | null = null;
  let extractTo: string | null = null;
  try {
    if (entry.source.type === 'bundled') {
      // 内置示例：直接复制。dir 来自市场索引，仍禁止绝对路径与 ".."，避免越界复制
      const dir = entry.source.dir;
      if (path.isAbsolute(dir) || dir.split(/[\\/]+/).includes('..')) {
        return { ok: false, message: `非法的内置插件路径：${dir}` };
      }
      const src = resourcePath(dir);
      await copyDir(src, dest);
      return { ok: true, message: `已安装内置插件 ${entry.name}` };
    }

    // github 来源：走 api.github.com 的 tarball 接口（对国内网络友好）
    const { repo, subdir } = entry.source;
    // 仓库名来自市场索引，仍校验形状：防止奇怪的路径段/查询串把请求带到非预期端点
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { ok: false, message: `非法的 GitHub 仓库标识：${repo}` };
    }
    if (subdir !== undefined) {
      // 与 bundled 来源同一套路径守卫：旧正则 [\w./-]+ 会放行 ".." 段，
      // subdir = "../../.." 能让后面的 path.join 逃出解压临时目录（Zip Slip 的同类问题），
      // 进而把工作区外任意含 plugin.json 的目录拷进插件目录。
      if (path.isAbsolute(subdir) || subdir.split(/[\\/]+/).includes('..') || !/^[\w./-]+$/.test(subdir)) {
        return { ok: false, message: `非法的插件子目录：${subdir}` };
      }
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/tarball`, {
      signal: AbortSignal.timeout(60_000),
      redirect: 'follow',
      // GitHub API 强制要求 User-Agent，缺失会直接回 403，表现为"所有插件都装不上"
      headers: { 'User-Agent': 'nano-harness-plugin-installer', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { ok: false, message: `下载失败：HTTP ${res.status}` };
    tarball = path.join(os.tmpdir(), `nano-plugin-${name}-${Date.now()}.tar.gz`);
    await fs.writeFile(tarball, Buffer.from(await res.arrayBuffer()));

    // 解压到临时目录，再从里面把插件子目录拷出来
    extractTo = path.join(os.tmpdir(), `nano-plugin-${name}-${Date.now()}`);
    await fs.mkdir(extractTo, { recursive: true });
    // 安全：先只列条目名，拒绝绝对路径与 "../" 穿越（Zip Slip），再真正解压。
    // execFile 直接 execve，不经过 shell：名字里的 $(...) / 反引号无法再被解释
    const listing = await execTarCapture(['-tzf', tarball]);
    for (const member of listing.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const normalized = member.replace(/\\/g, '/');
      if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
        return { ok: false, message: `压缩包包含不安全的路径条目，已拒绝安装：${member}` };
      }
    }
    try {
      await execTar(['-xzf', tarball, '-C', extractTo, '--no-same-owner']);
    } catch {
      // 个别系统的 tar 不认长参数，退回最基础的解压（前面已做条目安全检查）
      await execTar(['-xzf', tarball, '-C', extractTo]);
    }
    const root = (await fs.readdir(extractTo))[0];
    if (!root) return { ok: false, message: '压缩包为空' };
    const pluginDir = path.join(extractTo, root, subdir ?? '');
    // 找到含 plugin.json 的那一层（兼容插件在仓库根或子目录两种发布方式）
    const manifestDir = await findManifestDir(pluginDir);
    if (!manifestDir) return { ok: false, message: '包内未找到 plugin.json，确认这是一个 nano-harness 插件' };
    await fs.mkdir(PLUGINS_DIR, { recursive: true });
    await fs.rm(dest, { recursive: true, force: true });
    await copyDir(manifestDir, dest);
    return { ok: true, message: `已从 GitHub 安装 ${name}` };
  } catch (err) {
    return { ok: false, message: `安装失败：${(err as Error).message}` };
  } finally {
    // 无论成功失败都清干净，别把 tarball 和解压目录留在 ~/tmp
    if (tarball) await fs.rm(tarball, { force: true }).catch(() => {});
    if (extractTo) await fs.rm(extractTo, { recursive: true, force: true }).catch(() => {});
  }
}

/** 读取市场索引：优先包内 bundled 索引（离线可用），失败给空索引 */
export async function fetchMarketplace(): Promise<MarketplaceIndex> {
  try {
    const raw = await fs.readFile(resourcePath('marketplace', 'index.json'), 'utf8');
    return JSON.parse(raw) as MarketplaceIndex;
  } catch {
    return { version: 1, plugins: [] };
  }
}

/* ---------------- 内部工具函数 ---------------- */

/**
 * 递归复制目录（Node 内置 fs 没有 cp -r 的承诺版封装，手写一个）。
 * 安全：源目录里的符号链接一律跳过，不跟随——解压来的第三方插件若带
 * `link -> /etc` 之类的条目，跟随复制会把工作区外的内容带进插件目录。
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue; // 不复制任何符号链接
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await fs.copyFile(s, d);
  }
}

/** 调用系统 tar（macOS/Linux 自带；Windows 暂不支持 github 来源安装） */
function execTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileCb('tar', args, { timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** 调用系统 tar 并取回 stdout（用于解压前列出条目做安全检查） */
function execTarCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb('tar', args, { timeout: 60_000, maxBuffer: 10_000_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/** 工具归属：插件一律加 plugin: 前缀，避免插件名叫 builtin 时误注销内置工具 */
function pluginOwner(name: string): string {
  return `plugin:${name}`;
}

/** 向下查找包含 plugin.json 的目录（最多三层） */
async function findManifestDir(start: string): Promise<string | null> {
  let current = start;
  for (let depth = 0; depth < 3; depth++) {
    if (fsSync.existsSync(path.join(current, 'plugin.json'))) return current;
    const children = (await fs.readdir(current, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory());
    if (children.length === 1) current = path.join(current, children[0].name);
    else break;
  }
  return null;
}
