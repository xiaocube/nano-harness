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

import { ipcMain, shell, dialog } from 'electron';
import { runAgentTurn, type AgentEvent } from '../dist/loop.js';
import type { ChatMessage } from '../dist/llm.js';
import { loadConfig, saveConfig, getActiveProvider, CONFIG_FILE, type HarnessConfig, type ModelProvider, type AgentPreset } from '../dist/config.js';
import { saveSession, listSessions, loadSession, setSessionArchived } from '../dist/session.js';
import { registerBuiltinTools, listTools } from '../dist/tools/index.js';
import { setConfirmHandler, type PermissionRequest } from '../dist/permission.js';
import {
  loadInstalledPlugins, fetchMarketplace, installFromEntry, uninstallPlugin,
  setPluginEnabled, listInstalled, PLUGINS_DIR,
} from '../dist/plugins.js';
import { callChat } from '../dist/llm.js';

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
let permissionSeq = 1;

export function createAgentBridge(broadcast: Broadcast): void {
  /* ---------- 启动准备：内置工具 + 插件 ---------- */
  void (async () => {
    await registerBuiltinTools();
    const cfg = await loadConfig();
    for (const p of await loadInstalledPlugins(cfg, true)) {
      if (p.loadError) broadcast({ type: 'tool_result', name: 'plugin', preview: `插件 ${p.manifest.name} 加载失败：${p.loadError}` });
    }
  })();

  /* ---------- 权限闸门：loop 的 confirm → UI 弹窗 ---------- */
  setConfirmHandler(async (req: PermissionRequest) => {
    const id = permissionSeq++;
    broadcast({ type: 'permission_request', id, ...req });
    return new Promise<boolean>((resolve) => {
      pendingPermissions.set(id, resolve);
    });
  });
  ipcMain.on('agent:permission:reply', (_e, reply: { id: number; allowed: boolean }) => {
    pendingPermissions.get(reply.id)?.(reply.allowed);
    pendingPermissions.delete(reply.id);
  });

  /* ---------- 对话 ---------- */
  ipcMain.handle('agent:send', async (_e, task: string, opts?: { workspace?: string; preset?: AgentPreset }) => {
    if (running) return { ok: false, error: '已有任务在执行中，请等待完成或新建会话' };
    running = true;
    const cfg = await loadConfig();
    try {
      const result = await runAgentTurn(messages, task, {
        cfg,
        workspace: opts?.workspace ?? process.cwd(), // composer 的工作区 pill 可覆盖
        preset: opts?.preset ?? cfg.activePreset,    // composer 的预设 pill 可覆盖
        yolo: cfg.yolo,
        onEvent: (evt) => broadcast(evt),
      });
      currentSessionFile = await saveSession(result.messages, currentSessionFile);
      return { ok: true, answer: result.answer };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      running = false;
    }
  });

  ipcMain.handle('chat:new', () => {
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
    messages = await loadSession(file);
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
  // 原生目录选择框：composer 的工作区 pill
  ipcMain.handle('workspace:choose', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作区目录',
      defaultPath: process.cwd(),
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
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
  ipcMain.handle('plugin:reveal', () => {
    void shell.openPath(PLUGINS_DIR);
    return { ok: true };
  });
  // 应用信息（侧栏展示工作区名）
  ipcMain.handle('app:info', () => ({ workspace: process.cwd(), version: '0.3.0' }));
  // 设置弹窗"打开配置文件"：在 Finder 中定位 config.json
  ipcMain.handle('config:reveal', () => {
    shell.showItemInFolder(CONFIG_FILE);
    return { ok: true };
  });
}
