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
 * ⚠ 安全须知（v1 如实声明）：插件代码在 harness 进程内运行，拥有与 harness
 * 相同的权限（可访问文件系统与网络）。安装第三方插件前请先看它的源码。
 * 沙箱化插件运行时（worker/子进程 + 权限声明）在路线图中。
 */

import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { exec as execCb } from 'node:child_process';
import { registerTool, listTools, type Tool } from './tools/index.js';
import { CONFIG_DIR } from './config.js';

/** 插件安装目录 */
export const PLUGINS_DIR = path.join(CONFIG_DIR, 'plugins');

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
  /** 该插件注册的工具名 */
  toolNames: string[];
  /** 加载失败时的原因（正常安装为 null） */
  loadError: string | null;
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

/** 随包分发的内置市场索引（仓库根 marketplace/index.json） */
const BUNDLED_INDEX_PATH = path.resolve(process.cwd(), 'marketplace/index.json');

/**
 * 加载单个插件目录：读 plugin.json → 动态 import 工具模块 → 校验 Tool[] 形状。
 * 注意用 .mjs：插件目录没有 package.json，.js 会被 Node 当 CommonJS 处理。
 */
async function loadPluginDir(dir: string, register: boolean): Promise<InstalledPlugin> {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8')) as PluginManifest;
  } catch (err) {
    return {
      manifest: { name: path.basename(dir), version: '?', description: '', author: '?' },
      dir, toolNames: [],
      loadError: `plugin.json 读取失败：${(err as Error).message}`,
    };
  }

  const before = new Set(listTools().map((t) => t.name));
  try {
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
    // 形状校验：像 Tool 的才收——防御插件写错导致 harness 崩溃。
    // register=false 时只统计不注册（供 UI 展示已装列表用）
    const toolNames: string[] = [];
    for (const tool of tools as Tool[]) {
      if (typeof tool?.name === 'string' && typeof tool?.execute === 'function') {
        toolNames.push(tool.name);
        if (register && !before.has(tool.name)) {
          registerTool(tool);
        }
      }
    }
    return { manifest, dir, toolNames, loadError: null };
  } catch (err) {
    return { manifest, dir, toolNames: [], loadError: `工具加载失败：${(err as Error).message}` };
  }
}

/** 扫描并加载插件目录下的所有插件（宿主启动时调用一次） */
export async function loadInstalledPlugins(register = true): Promise<InstalledPlugin[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(PLUGINS_DIR);
  } catch {
    return []; // 目录不存在 = 没装过插件
  }
  const results: InstalledPlugin[] = [];
  for (const name of names.filter((n) => !n.startsWith('.'))) {
    const dir = path.join(PLUGINS_DIR, name);
    if ((await fs.stat(dir)).isDirectory()) {
      results.push(await loadPluginDir(dir, register));
    }
  }
  return results;
}

/** 已安装插件列表（不重复注册工具，仅供 UI 展示） */
export async function listInstalled(): Promise<InstalledPlugin[]> {
  return loadInstalledPlugins(false);
}

/** 卸载插件：直接删除其目录 */
export async function uninstallPlugin(name: string): Promise<void> {
  const dir = path.join(PLUGINS_DIR, name);
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * 从市场条目安装插件到 ~/.nano-harness/plugins/<name>/。
 * bundled 来源 = 复制包内示例（离线可用）；github 来源 = 下载仓库 tarball 解压。
 */
export async function installFromEntry(entry: MarketplaceEntry): Promise<{ ok: boolean; message: string }> {
  const dest = path.join(PLUGINS_DIR, entry.name);
  try {
    if (entry.source.type === 'bundled') {
      // 内置示例：直接复制（Node 没有内置 cp -r，手动递归）
      const src = path.resolve(process.cwd(), entry.source.dir);
      await copyDir(src, dest);
      return { ok: true, message: `已安装内置插件 ${entry.name}` };
    }

    // github 来源：走 api.github.com 的 tarball 接口（对国内网络友好）
    const { repo, subdir } = entry.source;
    const res = await fetch(`https://api.github.com/repos/${repo}/tarball`, {
      signal: AbortSignal.timeout(60_000),
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, message: `下载失败：HTTP ${res.status}` };
    const tarball = path.join(os.tmpdir(), `nano-plugin-${entry.name}-${Date.now()}.tar.gz`);
    await fs.writeFile(tarball, Buffer.from(await res.arrayBuffer()));

    // 解压到临时目录，再从里面把插件子目录拷出来
    const extractTo = path.join(os.tmpdir(), `nano-plugin-${entry.name}-${Date.now()}`);
    await fs.mkdir(extractTo, { recursive: true });
    await execTar(`-xzf ${JSON.stringify(tarball)} -C ${JSON.stringify(extractTo)}`);
    const root = (await fs.readdir(extractTo))[0];
    if (!root) return { ok: false, message: '压缩包为空' };
    const pluginDir = path.join(extractTo, root, subdir ?? '');
    // 找到含 plugin.json 的那一层（兼容插件在仓库根或子目录两种发布方式）
    const manifestDir = await findManifestDir(pluginDir);
    if (!manifestDir) return { ok: false, message: '包内未找到 plugin.json，确认这是一个 nano-harness 插件' };
    await fs.mkdir(PLUGINS_DIR, { recursive: true });
    await fs.rm(dest, { recursive: true, force: true });
    await copyDir(manifestDir, dest);
    // 清理临时文件
    await fs.rm(tarball, { force: true });
    await fs.rm(extractTo, { recursive: true, force: true });
    return { ok: true, message: `已从 GitHub 安装 ${entry.name}` };
  } catch (err) {
    return { ok: false, message: `安装失败：${(err as Error).message}` };
  }
}

/** 读取市场索引：优先包内 bundled 索引（离线可用），失败给空索引 */
export async function fetchMarketplace(): Promise<MarketplaceIndex> {
  try {
    const raw = await fs.readFile(BUNDLED_INDEX_PATH, 'utf8');
    return JSON.parse(raw) as MarketplaceIndex;
  } catch {
    return { version: 1, plugins: [] };
  }
}

/* ---------------- 内部工具函数 ---------------- */

/** 递归复制目录（Node 内置 fs 没有 cp -r 的承诺版封装，手写一个） */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

/** 调用系统 tar 命令（macOS/Linux 自带；Windows 用户暂不支持 github 来源安装） */
function execTar(args: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execCb(`tar ${args}`, { timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
  });
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
