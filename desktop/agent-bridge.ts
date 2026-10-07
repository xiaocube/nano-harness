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

import { ipcMain, shell } from 'electron';
import { runAgentTurn, type AgentEvent } from '../dist/loop.js';
import type { ChatMessage } from '../dist/llm.js';
import { loadConfig, saveConfig, type HarnessConfig } from '../dist/config.js';
import { saveSession, listSessions, loadSession } from '../dist/session.js';
import { registerBuiltinTools, listTools } from '../dist/tools/index.js';
import { setConfirmHandler, type PermissionRequest } from '../dist/permission.js';
import {
  loadInstalledPlugins, fetchMarketplace, installFromEntry, uninstallPlugin,
  setPluginEnabled, listInstalled, PLUGINS_DIR,
} from '../dist/plugins.js';
import { CONFIG_FILE } from '../dist/config.js';
import { callChat } from '../dist/llm.js';

/** 广播函数类型：主进程 → 渲染层的事件通道 */
type Broadcast = (payload: AgentEvent | { type: 'permission_request'; id: number } & PermissionRequest) => void;

/** 内存中的对话历史（应用生命周期内共享；落盘交给 session.ts） */
let messages: ChatMessage[] = [];
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
  ipcMain.handle('agent:send', async (_e, task: string) => {
    if (running) return { ok: false, error: '已有任务在执行中，请等待完成或新建会话' };
    running = true;
    const cfg = await loadConfig();
    try {
      const result = await runAgentTurn(messages, task, {
        cfg,
        workspace: process.cwd(), // 桌面版工作区：应用启动目录（未来可在设置里换）
        yolo: cfg.yolo,
        onEvent: (evt) => broadcast(evt),
      });
      await saveSession(result.messages); // 每轮自动落盘
      return { ok: true, answer: result.answer };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      running = false;
    }
  });

  ipcMain.handle('chat:new', () => {
    messages = [];
    return { ok: true };
  });
  // 渲染层恢复视图用：返回当前内存里的对话（过滤 system 提示词这一实现细节）
  ipcMain.handle('chat:current', () => ({
    ok: true,
    messages: messages.filter((m) => m.role !== 'system'),
  }));

  /* ---------- 会话管理 ---------- */
  ipcMain.handle('session:list', () => listSessions());
  ipcMain.handle('session:load', async (_e, file: string) => {
    messages = await loadSession(file);
    // 返回渲染层可展示的历史（过滤掉 system 提示词，那是实现细节）
    return { ok: true, messages: messages.filter((m) => m.role !== 'system') };
  });

  /* ---------- 配置（设置页） ---------- */
  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:set', async (_e, partial: Partial<HarnessConfig>) => {
    const cfg = { ...(await loadConfig()), ...partial };
    await saveConfig(cfg);
    return { ok: true };
  });
  // 连接测试：用当前配置发一个极小请求，把成败翻译成人话
  ipcMain.handle('config:test', async () => {
    const cfg = await loadConfig();
    try {
      await callChat(cfg, [
        { role: 'system', content: '你是连接测试器，只回复 pong' },
        { role: 'user', content: 'ping' },
      ], []);
      return { ok: true, message: `连接成功（模型 ${cfg.model}）` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
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
  ipcMain.handle('app:info', () => ({ workspace: process.cwd(), version: '0.2.0' }));
  // 设置弹窗"打开配置文件"：在 Finder 中定位 config.json
  ipcMain.handle('config:reveal', () => {
    shell.showItemInFolder(CONFIG_FILE);
    return { ok: true };
  });
}
