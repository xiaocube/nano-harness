/**
 * desktop/agent-bridge.ts —— 业务 IPC 桥
 *
 * 这是"界面 ↔ harness 核心"的总机：把渲染进程发来的每类请求，
 * 路由到对应的核心模块（loop / session / config / plugins）。
 * 渲染进程永远不直接碰 Node——所有能力都经由这里暴露的窄接口。
 *
 * 权限确认的往返设计（UI 版"y/N"）：
 *   loop 需要 confirm → bridge 生成 request id，弹窗事件推给 UI →
 *   UI 用户点击 → ipc 回复 { id, allowed } → resolve 对应的 Promise →
 *   loop 拿到放行/拒绝继续执行。Promise 挂起期间 loop 自然"暂停"。
 */

import { ipcMain, shell, dialog, BrowserWindow, app, protocol } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentTurn, type AgentEvent } from '../dist/loop.js';
import type { ChatMessage } from '../dist/llm.js';
import { homedir } from 'node:os';
import { loadConfig, saveConfig, getActiveProvider, CONFIG_FILE, type HarnessConfig, type ModelProvider, type AgentPreset } from '../dist/config.js';
import { saveSession, listSessions, loadSession, setSessionArchived } from '../dist/session.js';
import { registerBuiltinTools, listTools } from '../dist/tools/index.js';
import { setConfirmHandler, type PermissionRequest } from '../dist/permission.js';
import {
  loadInstalledPlugins, fetchMarketplace, installFromEntry, uninstallPlugin,
  setPluginEnabled, listInstalled, PLUGINS_DIR,
} from '../dist/plugins.js';
import { callChat } from '../dist/llm.js';

/**
 * 默认工作区：从 Finder/Dock 启动时 process.cwd() 是 "/"，
 * 把它当工作区既难看（侧栏显示 /）又危险（bash 会在根目录执行命令），
 * 所以这种情况回落到用户主目录。
 */
const FALLBACK_WORKSPACE = process.cwd() === '/' ? homedir() : process.cwd();

/** 广播函数类型：主进程 → 渲染层的事件通道 */
type Broadcast = (payload: AgentEvent | { type: 'permission_request'; id: number } & PermissionRequest) => void;

/** 内存中的对话历史（应用生命周期内共享；落盘交给 session.ts） */
let messages: ChatMessage[] = [];
/** 当前会话文件名：首轮保存后固定，后续轮次更新同一文件（updatedAt 语义才正确） */
let currentSessionFile: string | undefined;
/** agent 是否正在跑（防止并发任务把历史搅乱） */
let running = false;
/** 权限请求挂起表：id → resolve 函数 */
const pendingPermissions = new Map<number, (allowed: boolean) => void>();
/** 还没被回答的权限请求（含内容）：窗口重载/切页面后要能重新弹出来 */
const pendingPayloads = new Map<number, PermissionRequest & { id: number }>();
let permissionSeq = 1;
/** 权限请求最长等待时间：超过就按拒绝处理，绝不把 agent 永久挂住 */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 当前工作区（绝对路径）。这是文本工具的活动边界，也是 agent 系统提示词里的"当前目录"。
 * 渲染层只负责"选"，真正的边界永远由主进程持有——渲染层传来的路径一律要重新校验。
 */
let workspace = FALLBACK_WORKSPACE;
/** 最近使用的工作区（最新的在前，最多 8 个） */
let recentWorkspaces: string[] = [];
/** 启动准备（注册工具 / 恢复工作区）完成的信号，见 createAgentBridge 里的注释 */
let ready: Promise<void> = Promise.resolve();
/** 启动准备失败时的原因（界面可以据此提示用户） */
let startupError: string | null = null;

/** 路径是否是"存在的目录"（选择/切换工作区时的唯一准入条件） */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 应用版本号。开发模式（electron dist-desktop/main.js）下 app.getVersion()
 * 返回的是 Electron 自己的版本（如 44.6.0），会把侧栏显示成 "v44.6.0"，
 * 所以优先直接读项目 package.json，读不到才回落到 Electron 的接口。
 */
function projectVersion(): string {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string }).version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
}

/** 把任意输入规整成一个可用的工作区绝对路径（不存在则回落到当前/默认） */
function normalizeWorkspace(input: unknown): string {
  if (typeof input === 'string' && input.trim() && isDirectory(input.trim())) {
    return input.trim();
  }
  return isDirectory(workspace) ? workspace : FALLBACK_WORKSPACE;
}

/**
 * 工作区内的路径守卫：相对路径 → 绝对路径，并强制留在工作区内。
 * 与 tools/fs-tools.ts 的 guardPath 同源——文件浏览、预览、nh-file 协议都走它。
 */
function safeWorkspacePath(rel: unknown): string {
  const input = typeof rel === 'string' && rel ? rel : '.';
  const abs = path.resolve(workspace, input);
  const root = path.resolve(workspace);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径超出工作区：${input}`);
  }
  return abs;
}

/** 预览时按什么渲染一个文件 */
type FileKind = 'html' | 'markdown' | 'image' | 'text' | 'binary' | 'dir';

/** 按扩展名判断怎么渲染 */
function kindOf(file: string): FileKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) return 'image';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.py', '.sh', '.yml', '.yaml',
    '.txt', '.log', '.toml', '.ini', '.xml', '.csv', '.sql', '.go', '.rs', '.java', '.c', '.h', '.rb'].includes(ext)) return 'text';
  return 'binary';
}

/** 预览协议返回内容时的 content-type（含相对资源引用需要的几种） */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

/** 单次预览的体积上限：太大就别塞进 iframe 了，直接请用户用浏览器打开 */
const PREVIEW_MAX = 1_500_000;

/** 把工作区相对路径编码成 nh-file:// URL（每段单独编码，中文/空格都安全） */
function previewUrl(rel: string): string {
  return `nh-file://local/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 工作区快照：当前路径 + 最近打开的文件夹 + 每个文件夹的**修改时间**。
 *
 * 为什么要带 mtime：侧栏的文件夹列表要"始终按修改时间排序"（点谁都不会跳位），
 * 而一个刚打开、还没有任何对话的文件夹只能用它自己的文件系统修改时间参与排序。
 */
function workspaceSnapshot(): {
  workspace: string;
  recent: string[];
  mtimes: Record<string, number>;
  fallback: string;
} {
  const recent = recentWorkspaces.filter(isDirectory);
  if (isDirectory(workspace) && !recent.includes(workspace)) recent.unshift(workspace);
  const mtimes: Record<string, number> = {};
  for (const p of recent) {
    try {
      mtimes[p] = fs.statSync(p).mtimeMs;
    } catch { /* 刚被删掉的就不给了 */ }
  }
  return { workspace, recent, mtimes, fallback: FALLBACK_WORKSPACE };
}

/** 工作区变化广播：侧栏、composer、会话器都要立刻同步 */
function broadcastWorkspace(): void {
  const payload = workspaceSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('workspace:changed', payload);
  }
}

/**
 * 切换工作区：写内存 → 记入最近列表 → 先广播（UI 立刻一致）→ 再落盘。
 * 即使写配置失败也返回 ok：内存状态已经生效，只是提示里带上警告——
 * 反过来（先落盘、失败就 return）会让用户觉得"点了没反应"。
 */
async function applyWorkspace(next: string): Promise<{ ok: boolean; message: string }> {
  workspace = next;
  recentWorkspaces = [next, ...recentWorkspaces.filter((p) => p !== next)].slice(0, 8);
  broadcastWorkspace();
  try {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, workspace, recentWorkspaces });
    return { ok: true, message: `工作区已切换到 ${next}` };
  } catch (err) {
    return { ok: true, message: `工作区已切换到 ${next}（配置写入失败：${(err as Error).message}）` };
  }
}

export function createAgentBridge(broadcast: Broadcast): void {
  /* ---------- 启动准备：内置工具 + 插件 + 恢复上次的工作区 ---------- */
  // ready 这个 Promise 是给 workspace:get 用的：渲染层可能在内置工具还没注册完
  // （也就还没从配置里恢复工作区）时就来问"当前工作区是谁"，必须等它落定再回答，
  // 否则侧栏会先显示默认目录、且再也不会自我纠正。
  ready = (async () => {
    await registerBuiltinTools();
    const cfg = await loadConfig();
    // 恢复上次的工作区：配置里的路径可能已被删除/移动，所以要重新校验
    if (cfg.workspace && isDirectory(cfg.workspace)) {
      workspace = cfg.workspace;
      // 当前工作区一定要在"最近打开"里，否则侧栏拿不到它的修改时间
      recentWorkspaces = [workspace, ...(cfg.recentWorkspaces ?? []).filter((p) => p && p !== workspace)]
        .filter(isDirectory)
        .slice(0, 8);
    } else {
      recentWorkspaces = (cfg.recentWorkspaces ?? []).filter(isDirectory).slice(0, 8);
    }
    for (const p of await loadInstalledPlugins(cfg, true)) {
      if (p.loadError) broadcast({ type: 'tool_result', name: 'plugin', preview: `插件 ${p.manifest.name} 加载失败：${p.loadError}` });
    }
    // 恢复完成后再广播一次：早于此刻挂载的界面也能拿到正确的工作区
    broadcastWorkspace();
  })().catch((err) => {
    // 启动准备失败（比如插件目录里有个读不了的条目）不能变成"静默不可用"：
    // 记下来并广播给界面，同时保证 ready 永远是 resolved，后续 IPC 照常工作。
    startupError = (err as Error).message;
    broadcast({ type: 'tool_result', name: 'startup', preview: `启动准备失败：${startupError}` });
  });

  /* ---------- 权限闸门：loop 的 confirm → UI 弹窗 ---------- */
  /**
   * 权限请求的唯一出口。这里有三个必须做对的地方（都是真实事故点）：
   *   1. 用户切到别的页面时弹窗会被卸载 —— 所以要把"待回答的请求"存下来，
   *      界面回来时能重新问（pendingPayloads + permission:pending）；
   *   2. 用户可能永远不回答（关窗/重载/走开）—— 超时按拒绝处理，
   *      否则 runAgentTurn 的 promise 永远不 resolve，running 锁死；
   *   3. 新建会话要能取消掉旧的待答请求，不然旧弹窗会卡住新流程。
   */
  const settlePermission = (id: number, allowed: boolean) => {
    const resolve = pendingPermissions.get(id);
    pendingPermissions.delete(id);
    pendingPayloads.delete(id);
    resolve?.(allowed);
  };

  setConfirmHandler(async (req: PermissionRequest) => {
    const id = permissionSeq++;
    const payload = { id, ...req };
    pendingPermissions.set(id, () => {});
    pendingPayloads.set(id, payload);
    // 先占位再设真正的 resolve，保证超时/取消时一定能拿到同一个函数
    return new Promise<boolean>((resolve) => {
      pendingPermissions.set(id, resolve);
      broadcast({ type: 'permission_request', id, ...req });
      setTimeout(() => {
        if (pendingPermissions.has(id)) {
          settlePermission(id, false);
          broadcast({ type: 'tool_denied', name: req.title });
        }
      }, PERMISSION_TIMEOUT_MS).unref?.();
    });
  });
  ipcMain.on('agent:permission:reply', (_e, reply: { id: number; allowed: boolean }) => {
    settlePermission(reply.id, reply.allowed);
  });
  /** 界面重新挂载（切页面回来 / Cmd+R）后主动来取还没回答的请求 */
  ipcMain.handle('permission:pending', () => [...pendingPayloads.values()]);

  /* ---------- 对话 ---------- */
  ipcMain.handle('agent:send', async (_e, task: string, opts?: { workspace?: string; preset?: AgentPreset }) => {
    if (running) return { ok: false, error: '已有任务在执行中，请等待完成或新建会话' };
    running = true;
    // 注意 try 必须从 running = true 之后立刻开始：await ready / loadConfig 也可能抛
    // （比如插件目录里有坏条目），那时若不在 finally 里，running 会永久为 true，
    // 之后每一次发送都被"已有任务在执行中"拒绝，只能重启。
    try {
      await ready;            // 确保工作区已经从配置里恢复，别把任务跑到默认目录去
      const cfg = await loadConfig();
      // 本轮的工作区：渲染层可以带一个（composer 选择过的），但必须重新校验；
      // 校验不过就用主进程持有的当前工作区——渲染层永远不能直接决定路径边界。
      const turnWorkspace = normalizeWorkspace(opts?.workspace ?? workspace);
      const result = await runAgentTurn(messages, task, {
        cfg,
        workspace: turnWorkspace,
        preset: opts?.preset ?? cfg.activePreset,    // composer 的预设 pill 可覆盖
        yolo: cfg.yolo,
        onEvent: (evt) => broadcast(evt),
      });
      currentSessionFile = await saveSession(result.messages, currentSessionFile, turnWorkspace);
      return { ok: true, answer: result.answer };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      running = false;
    }
  });

  ipcMain.handle('chat:new', () => {
    // 任务执行中不允许清空历史：loop 正持有同一个 messages 数组，
    // 中途换掉引用会让这一轮的对话"凭空消失"。
    if (running) return { ok: false, error: '当前任务还在执行，请等它结束再新建会话' };
    // 取消所有还没回答的权限请求，免得旧弹窗把新流程卡住
    for (const id of [...pendingPermissions.keys()]) settlePermission(id, false);
    messages = [];
    currentSessionFile = undefined; // 新对话 = 下轮保存为新文件
    return { ok: true };
  });
  // 渲染层恢复视图用：返回当前内存里的对话（过滤 system 提示词这一实现细节）
  ipcMain.handle('chat:current', () => ({
    ok: true,
    messages: messages.filter((m) => m.role !== 'system'),
  }));

  /* ---------- 会话管理 ---------- */
  ipcMain.handle('session:list', (_e, archiveFilter?: 'hide' | 'all' | 'only') => listSessions(50, archiveFilter));
  ipcMain.handle('session:load', async (_e, file: string) => {
    // 任务跑着的时候绝不能切换当前会话：loop 持有的是旧的 messages 数组，
    // 这一轮结束时会把它的历史写进"刚加载的那个文件"，把别人的会话覆盖掉。
    if (running) return { ok: false, error: '任务执行中，无法切换会话' };
    const loaded = await loadSession(file); // loadSession 内部已校验文件名与载荷
    messages = loaded;
    currentSessionFile = file; // 继续这个会话：后续轮次更新同一文件
    // 返回渲染层可展示的历史（过滤掉 system 提示词，那是实现细节）
    return { ok: true, messages: messages.filter((m) => m.role !== 'system') };
  });
  ipcMain.handle('session:archive', async (_e, file: string, archived: boolean) => {
    await setSessionArchived(file, archived);
    return { ok: true };
  });

  /* ---------- 配置（设置页） ---------- */
  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:set', async (_e, partial: Partial<HarnessConfig>) => {
    const cfg = { ...(await loadConfig()), ...partial };
    await saveConfig(cfg);
    return { ok: true };
  });
  // 连接测试：按指定提供商（缺省当前激活的）发一个极小请求
  ipcMain.handle('config:test', async (_e, providerId?: string) => {
    const cfg = await loadConfig();
    const target = providerId ? { ...cfg, activeProviderId: providerId } : cfg;
    try {
      await callChat(target, [
        { role: 'system', content: '你是连接测试器，只回复 pong' },
        { role: 'user', content: 'ping' },
      ], []);
      const p = getActiveProvider(target);
      return { ok: true, message: `连接成功（${p.name} · ${p.model}）` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  /* ---------- 模型提供商（多提供商管理） ---------- */
  // 新增或更新（带 id 即更新）；成功后自动切为激活
  ipcMain.handle('provider:save', async (_e, provider: ModelProvider) => {
    const cfg = await loadConfig();
    const list = [...(cfg.providers ?? [])];
    const idx = list.findIndex((p) => p.id === provider.id);
    if (idx >= 0) list[idx] = provider; else list.push(provider);
    await saveConfig({
      ...cfg,
      providers: list,
      // 同步镜像字段，CLI 旧读取路径兼容
      baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model,
      activeProviderId: provider.id,
    });
    return { ok: true, message: `已保存「${provider.name}」并设为当前` };
  });
  ipcMain.handle('provider:delete', async (_e, id: string) => {
    const cfg = await loadConfig();
    const list = (cfg.providers ?? []).filter((p) => p.id !== id);
    if (list.length === 0) return { ok: false, message: '至少保留一个提供商' };
    await saveConfig({
      ...cfg,
      providers: list,
      activeProviderId: cfg.activeProviderId === id ? list[0].id : cfg.activeProviderId,
    });
    return { ok: true, message: '已删除' };
  });
  ipcMain.handle('provider:set-active', async (_e, id: string) => {
    const cfg = await loadConfig();
    const p = (cfg.providers ?? []).find((x) => x.id === id);
    if (!p) return { ok: false, message: '提供商不存在' };
    await saveConfig({ ...cfg, activeProviderId: id, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model });
    return { ok: true, message: `已切换到「${p.name}」` };
  });
  // 账号余额：DeepSeek 官方支持 GET /user/balance；其他厂商暂不支持
  ipcMain.handle('provider:balance', async (_e, id: string) => {
    const cfg = await loadConfig();
    const p = (cfg.providers ?? []).find((x) => x.id === id) ?? getActiveProvider(cfg);
    if (!p.baseUrl.includes('deepseek')) {
      return { ok: false, message: '该提供商暂不支持余额查询（目前仅 DeepSeek）' };
    }
    try {
      const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/user/balance`, {
        headers: { Authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, message: `查询失败：HTTP ${res.status}` };
      const data = await res.json() as {
        is_available?: boolean;
        balance_infos?: { currency: string; total_balance: string }[];
      };
      const info = data.balance_infos?.[0];
      if (!info) return { ok: false, message: '未返回余额信息' };
      return { ok: true, message: `余额 ¥${info.total_balance} ${info.currency}${data.is_available === false ? '（已欠费停机）' : ''}` };
    } catch (err) {
      return { ok: false, message: `查询失败：${(err as Error).message}` };
    }
  });

  /* ---------- Agent 预设与工作区 ---------- */
  ipcMain.handle('preset:set', async (_e, preset: AgentPreset) => {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, activePreset: preset });
    return { ok: true, message: '预设已切换（对新任务生效）' };
  });

  /** 当前工作区 + 最近使用（含修改时间）；等启动恢复完成再回答，避免显示到默认目录 */
  ipcMain.handle('workspace:get', async () => {
    await ready;
    return workspaceSnapshot();
  });

  /**
   * 原生目录选择框。挂在主窗口上 → macOS 表现为贴着窗口的 sheet（更不容易"找不到"），
   * 并带 createDirectory：用户可以在选择框里直接新建文件夹。
   */
  ipcMain.handle('workspace:choose', async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: '打开文件夹作为工作区',
      defaultPath: isDirectory(workspace) ? workspace : FALLBACK_WORKSPACE,
      buttonLabel: '打开',
    };
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
    await applyWorkspace(res.filePaths[0]);
    return { ok: true, path: workspace };
  });

  /** 从侧栏列表 /"最近使用"里切换（或渲染层直接给一个路径） */
  ipcMain.handle('workspace:set', async (_e, path: string) => {
    if (!isDirectory(path)) return { ok: false, message: `文件夹不存在：${path}` };
    return applyWorkspace(path);
  });

  /** 在访达中打开当前工作区（openPath 的错误字符串不能吞掉，否则按钮像没反应） */
  ipcMain.handle('workspace:reveal', async () => {
    const msg = await shell.openPath(workspace);
    return msg ? { ok: false, message: msg } : { ok: true };
  });

  /* ---------- 成果预览（文件浏览 + 在客户端里渲染） ---------- */

  /**
   * nh-file:// 协议：把工作区内的文件按原样喂给预览 iframe。
   * 关键点是它**不是** data:/blob:，所以被预览页面不继承应用页面的 CSP——
   * 页面里的内联 <script> 能跑；相对路径的 CSS/JS 也会回到这个协议上取，天然可用。
   * 路径同样受工作区边界保护。
   */
  protocol.handle('nh-file', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = url.pathname.split('/').map(decodeURIComponent).join('/').replace(/^\/+/, '');
      const abs = safeWorkspacePath(rel);
      const data = await fs.promises.readFile(abs);
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
          // 预览的 HTML 能跑脚本（否则小游戏/交互页面没法用），但必须掐死"外联"：
          // 没有这条 CSP 时，被预览的页面可以 fetch 工作区里的其它文件
          // （同一 nh-file:// 来源，同源请求会成功）再把内容 POST 到外部服务器。
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; " +
            "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; " +
            "connect-src 'none'; form-action 'none'; base-uri 'none'",
        },
      });
    } catch (err) {
      return new Response(`预览失败：${(err as Error).message}`, {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  });

  /** 列出工作区内某个目录（目录在前、按名字排序；跳过隐藏文件与 node_modules） */
  ipcMain.handle('file:list', async (_e, rel?: string) => {
    const abs = safeWorkspacePath(rel);
    const root = path.resolve(workspace);
    const dirs = await fs.promises.readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(dirs
      .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(async (d) => {
        const full = path.join(abs, d.name);
        let size = 0;
        let mtime = 0;
        try {
          const st = await fs.promises.stat(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* 断链符号链接之类，忽略 */ }
        return {
          name: d.name,
          rel: path.relative(root, full),
          type: d.isDirectory() ? 'dir' as const : 'file' as const,
          size,
          mtime,
          kind: d.isDirectory() ? 'dir' as const : kindOf(full),
        };
      }));
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const relDir = path.relative(root, abs) || '.';
    return {
      ok: true,
      workspace,
      rel: relDir,
      parent: relDir === '.' ? null : (path.dirname(relDir) === '.' ? '.' : path.dirname(relDir)),
      entries: entries.slice(0, 500),
    };
  });

  /**
   * 读一个文件交给界面渲染。HTML/图片转成 data: URL（用 iframe/img 直接显示），
   * 文本类返回纯文本（markdown 在界面里渲染成排版，代码用等宽字体展示）。
   */
  ipcMain.handle('file:preview', async (_e, rel: string) => {
    let abs: string;
    try {
      abs = safeWorkspacePath(rel);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return { ok: false, message: '这不是一个文件' };
      const kind = kindOf(abs);
      const base = {
        ok: true as const,
        name: path.basename(abs),
        rel: path.relative(path.resolve(workspace), abs),
        absPath: abs,
        size: st.size,
        mtime: st.mtimeMs,
        kind,
      };
      if (st.size > PREVIEW_MAX) {
        return { ...base, kind: 'binary' as FileKind, message: `文件 ${(st.size / 1024 / 1024).toFixed(1)}MB，太大，请用浏览器或系统应用打开` };
      }
      if (kind === 'image') {
        const buf = await fs.promises.readFile(abs);
        const mime = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
        return { ...base, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
      }
      if (kind === 'html') {
        // 用自定义协议暴露：内联脚本能跑，相对资源也能取到（见上面的 protocol.handle）
        return { ...base, url: previewUrl(base.rel) };
      }
      if (kind === 'binary') {
        return { ...base, message: '这个格式没法在客户端里预览，可以用「打开方式」交给系统应用' };
      }
      return { ...base, text: await fs.promises.readFile(abs, 'utf8') };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  /** 在访达里定位文件 */
  ipcMain.handle('file:reveal', (_e, rel: string) => {
    try {
      shell.showItemInFolder(safeWorkspacePath(rel));
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  /** 交给系统默认应用（HTML 就是默认浏览器）打开 */
  ipcMain.handle('file:openExternal', async (_e, rel: string) => {
    const msg = await shell.openPath(safeWorkspacePath(rel));
    return { ok: !msg, message: msg };
  });

  /* ---------- 工具与插件（插件市场页） ---------- */
  ipcMain.handle('tools:list', () => listTools().map((t) => ({
    name: t.name, description: t.description, needsPermission: t.needsPermission,
  })));

  ipcMain.handle('plugin:installed', async () => listInstalled(await loadConfig()));
  ipcMain.handle('marketplace:list', () => fetchMarketplace());
  ipcMain.handle('plugin:install', async (_e, name: string) => {
    const index = await fetchMarketplace();
    const entry = index.plugins.find((p) => p.name === name);
    if (!entry) return { ok: false, message: `市场里没有叫 ${name} 的插件` };
    const result = await installFromEntry(entry);
    if (result.ok) await loadInstalledPlugins(await loadConfig(), true); // 装完立刻注册进工具表
    return result;
  });
  // 启用/禁用开关：实时生效（注册/注销工具）+ 状态写入配置持久化
  ipcMain.handle('plugin:toggle', async (_e, name: string, enabled: boolean) => {
    const cfg = await loadConfig();
    const result = await setPluginEnabled(name, enabled, cfg);
    if (result.ok) {
      await saveConfig({ ...cfg, plugins: { ...(cfg.plugins ?? {}), [name]: enabled } });
    }
    return result;
  });
  ipcMain.handle('plugin:uninstall', async (_e, name: string) => {
    await uninstallPlugin(name);
    return { ok: true, message: `已卸载 ${name}` };
  });
  // 在 Finder 里打开插件目录（"添加插件"手动安装入口）
  ipcMain.handle('plugin:reveal', async () => {
    const msg = await shell.openPath(PLUGINS_DIR);
    return msg ? { ok: false, message: msg } : { ok: true };
  });
  // 应用信息（侧栏展示工作区名与版本号；版本号直接读 package.json，避免各处写死后不一致）
  ipcMain.handle('app:info', async () => {
    await ready;
    return { workspace, version: projectVersion(), startupError };
  });
  // 设置弹窗"打开配置文件"：在 Finder 中定位 config.json
  ipcMain.handle('config:reveal', () => {
    shell.showItemInFolder(CONFIG_FILE);
    return { ok: true };
  });
}
