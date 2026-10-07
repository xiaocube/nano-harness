/**
 * desktop/main.ts —— Electron 主进程
 *
 * 职责（对比 CLI 的 cli.ts，这里是"桌面版的外壳"）：
 *   1. 创建 macOS 风格原生窗口：hiddenInset（红绿灯内嵌悬浮在内容上）
 *      + vibrancy: sidebar（侧栏毛玻璃，系统的 NSVisualEffectView）
 *   2. 原生应用菜单（关于/编辑/窗口，标准 role，Command+C/V 等快捷键开箱即用）
 *   3. 主题中枢：nativeTheme 跟随系统深浅色，变化时经 IPC 推送给渲染层
 *   4. 把 agent-bridge（业务 IPC）接上，加载前端页面
 *
 * 核心要点：harness 的"大脑"（agent loop、工具、模型调用）全在这个主进程——
 * 也就是真实的 Node 环境里跑，拥有完整文件系统与终端能力；
 * 渲染进程（React 界面）只是"眼睛和嘴"，被 contextIsolation 隔离。
 */

import { app, BrowserWindow, Menu, nativeTheme, ipcMain } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgentBridge } from './agent-bridge.js';
import { loadConfig } from '../dist/config.js';

// ESM 下没有 __dirname，用 import.meta 推导
const dirname = path.dirname(fileURLToPath(import.meta.url));
// 开发模式：环境变量指向 vite dev server；生产模式：加载构建产物
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/** 当前主窗口引用（防 GC + 供广播用） */
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    show: false, // 准备好再显示，避免白屏闪烁
    // ---- macOS 原生质感三件套 ----
    titleBarStyle: 'hiddenInset',                                    // 红绿灯内嵌，由前端画顶栏
    trafficLightPosition: { x: 16, y: 18 },                          // 红绿灯位置（与顶栏对齐）
    vibrancy: 'sidebar',                                             // 系统级毛玻璃材质
    visualEffectState: 'active',                                     // 失焦也保持毛玻璃效果
    backgroundColor: '#00000000',                                    // 透明底，让 vibrancy 透出来
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,  // 渲染层与 Node 完全隔离（Electron 安全铁律）
      nodeIntegration: false,  // 渲染层拿不到 Node 能力
    },
  });

  // 生产模式加载构建产物；开发模式加载 vite 热更新服务
  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(dirname, '../web/dist/index.html'));
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // 自动化验收钩子：设置 NANO_CAPTURE=path 时，稳定后截图并退出（CI/回归用）
    const capturePath = process.env.NANO_CAPTURE;
    if (capturePath) {
      setTimeout(() => {
        void mainWindow?.webContents.capturePage().then((image) => {
          fs.writeFileSync(capturePath, image.toPNG());
          app.quit();
        });
      }, 2500);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** 原生应用菜单：用标准 role 换来 macOS 用户习惯的全套行为与快捷键 */
function setupMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },                    // 关于 nano-harness
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },                     // 编辑（复制/粘贴/撤销，含全部快捷键）
    { role: 'viewMenu' },                     // 视图（重载/缩放/开发者工具）
    { role: 'windowMenu' },                   // 窗口（最小化/平铺）
  ]));
}

/** 主题中枢：系统外观变化 → 广播给渲染层 */
function setupThemeBridge(): void {
  const broadcast = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:changed', { dark: nativeTheme.shouldUseDarkColors });
    }
  };
  nativeTheme.on('updated', broadcast);
  // 设置页里用户切换"跟随系统/浅色/深色"时改 themeSource，同样广播生效
  ipcMain.handle('theme:get', () => ({ dark: nativeTheme.shouldUseDarkColors }));
  ipcMain.handle('theme:set', (_e, mode: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = mode;
    return { dark: nativeTheme.shouldUseDarkColors };
  });
}

app.whenReady().then(async () => {
  setupMenu();
  setupThemeBridge();
  createAgentBridge((payload) => mainWindow?.webContents.send('agent:event', payload));

  // 启动时应用外观偏好（默认跟随系统；NANO_APPEARANCE 供自动化测试强制指定）
  try {
    const cfg = await loadConfig();
    const forced = process.env.NANO_APPEARANCE as 'system' | 'light' | 'dark' | undefined;
    nativeTheme.themeSource = forced ?? cfg.appearance ?? 'system';
  } catch {
    nativeTheme.themeSource = 'system';
  }

  createWindow();

  // macOS 惯例：点 Dock 图标时若无窗口则重建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 全平台惯例：关掉所有窗口即退出（Linux/Windows）；macOS 保持常驻由菜单退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
