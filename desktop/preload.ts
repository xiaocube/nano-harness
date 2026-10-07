/**
 * desktop/preload.ts —— 预加载桥（渲染层与主进程之间唯一的合法通道）
 *
 * Electron 安全模型：渲染进程（React）被隔离在沙箱里，碰不到 Node。
 * 预加载脚本运行在一个"半特权"环境，用 contextBridge 把**白名单 API**
 * 挂到 window.nanoharness 上——React 只能调用这些函数，别无他法。
 *
 * 构建方式特殊：预加载脚本必须以 CommonJS 格式运行（沙箱限制），
 * 所以用 esbuild 单独打包成 preload.cjs（见 package.json 的 build:preload）。
 */

import { contextBridge, ipcRenderer } from 'electron';

/** 订阅推送事件的通用封装：返回退订函数，React 组件卸载时调用防泄漏 */
function subscribe(channel: string, callback: (payload: unknown) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('nanoharness', {
  /* ---------- 对话 ---------- */
  send: (task: string) => ipcRenderer.invoke('agent:send', task),
  newChat: () => ipcRenderer.invoke('chat:new'),
  currentMessages: () => ipcRenderer.invoke('chat:current'),
  replyPermission: (id: number, allowed: boolean) =>
    ipcRenderer.send('agent:permission:reply', { id, allowed }),
  onAgentEvent: (callback: (payload: unknown) => void) => subscribe('agent:event', callback),

  /* ---------- 会话 ---------- */
  listSessions: (archiveFilter?: 'hide' | 'all' | 'only') => ipcRenderer.invoke('session:list', archiveFilter),
  loadSession: (file: string) => ipcRenderer.invoke('session:load', file),
  archiveSession: (file: string, archived: boolean) => ipcRenderer.invoke('session:archive', file, archived),

  /* ---------- 配置 ---------- */
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial: Record<string, unknown>) => ipcRenderer.invoke('config:set', partial),
  testConnection: (providerId?: string) => ipcRenderer.invoke('config:test', providerId),
  revealConfigFile: () => ipcRenderer.invoke('config:reveal'),

  /* ---------- 模型提供商 ---------- */
  saveProvider: (provider: unknown) => ipcRenderer.invoke('provider:save', provider),
  deleteProvider: (id: string) => ipcRenderer.invoke('provider:delete', id),
  setActiveProvider: (id: string) => ipcRenderer.invoke('provider:set-active', id),
  queryBalance: (id: string) => ipcRenderer.invoke('provider:balance', id),

  /* ---------- 预设与工作区 ---------- */
  setPreset: (preset: string) => ipcRenderer.invoke('preset:set', preset),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),

  /* ---------- 主题 ---------- */
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (mode: 'system' | 'light' | 'dark') => ipcRenderer.invoke('theme:set', mode),
  onThemeChanged: (callback: (payload: unknown) => void) => subscribe('theme:changed', callback),

  /* ---------- 工具与插件 ---------- */
  listTools: () => ipcRenderer.invoke('tools:list'),
  listInstalledPlugins: () => ipcRenderer.invoke('plugin:installed'),
  listMarketplace: () => ipcRenderer.invoke('marketplace:list'),
  installPlugin: (name: string) => ipcRenderer.invoke('plugin:install', name),
  uninstallPlugin: (name: string) => ipcRenderer.invoke('plugin:uninstall', name),
  togglePlugin: (name: string, enabled: boolean) => ipcRenderer.invoke('plugin:toggle', name, enabled),
  revealPluginsDir: () => ipcRenderer.invoke('plugin:reveal'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
});
