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

import { app, BrowserWindow, Menu, nativeTheme, ipcMain, protocol, dialog, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgentBridge } from './agent-bridge.js';
import { loadConfig } from '../dist/config.js';

/**
 * 成果预览用的自定义协议。必须在 app ready **之前**声明特权。
 * 有了它，被预览的 HTML 就是"另一个真实 URL"——不继承应用页面的 CSP，
 * 页面里的内联 <script> 能正常跑（data: URL 做不到：实测会被 default-src 'self' 拦掉），
 * 同时相对路径引用的 CSS/JS/图片也能顺着同一个协议取到。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nh-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

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

  // 生产模式加载构建产物；开发模式加载 vite 热更新服务。
  // 加载失败必须让人看见（以前是 void + 未处理拒绝 → 白屏没提示）。
  const load = DEV_SERVER_URL
    ? mainWindow.loadURL(DEV_SERVER_URL)
    : mainWindow.loadFile(path.join(dirname, '../web/dist/index.html'));
  void load.catch((err) => {
    dialog.showErrorBox('界面加载失败', `${(err as Error).message}\n\n请先执行 npm run build:ui 生成 web/dist。`);
    app.quit();
  });

  // ---- 导航加固：渲染层里跑着强大的 preload，绝不能让窗口跳到别的文档 ----
  // 否则把一个下载来的 evil.html 拖进窗口，它就能调用 window.nanoharness
  // （读配置里的 API Key、读工作区文件）。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  // 链接（助手回答里的 http 链接）一律交给系统浏览器，不开 Electron 子窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // 自动化验收钩子：设置 NANO_CAPTURE=path 时，稳定后截图并退出（CI/回归用）
    const capturePath = process.env.NANO_CAPTURE;
    if (process.env.NANO_CAPTURE_SCRIPT) {
      void runCaptureScript(mainWindow!, process.env.NANO_CAPTURE_SCRIPT);
    } else if (capturePath) {
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

/**
 * 多页自动截图钩子（仅当设置了 NANO_CAPTURE_SCRIPT=<json 路径> 时启用）。
 *
 * 这是给 README / 发布物料准备截图用的"无人值守导游"：按脚本顺序在渲染层里
 * 点击导航、加载示例会话、逐页 capturePage，最后退出。它【只在该环境变量存在时运行】，
 * 正常启动完全不受影响。
 *
 * 脚本是一个步骤数组，每步形如：
 *   { "op": "wait", "ms": 600 }
 *   { "op": "clickText", "text": "插件市场" }   // 点击文本精确匹配的可点元素
 *   { "op": "loadSession", "file": "xxx.json" } // 经 IPC 加载示例会话并通知界面刷新
 *   { "op": "shot", "path": "/abs/xx.png" }
 *   { "op": "js", "code": "..." }               // 在渲染层执行任意表达式（高级用法）
 */
type CaptureStep =
  | { op: 'wait'; ms?: number }
  | { op: 'clickText'; text: string }
  | { op: 'loadSession'; file: string }
  | { op: 'shot'; path: string }
  | { op: 'js'; code: string };

async function runCaptureScript(win: BrowserWindow, scriptPath: string): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const steps = JSON.parse(fs.readFileSync(scriptPath, 'utf8')) as CaptureStep[];
    await sleep(1800); // 首屏 React 挂载 + 字体稳定
    for (const step of steps) {
      try {
        await performCaptureStep(win, step, sleep);
      } catch (err) {
        // 单步失败不连累其余截图：记录后继续
        console.warn(`[capture] 步骤失败（${step.op}）：`, (err as Error).message);
        await sleep(300);
      }
    }
  } catch (err) {
    console.error('[capture] 截图脚本执行失败：', err);
  } finally {
    app.quit();
  }
}

async function performCaptureStep(
  win: BrowserWindow,
  step: CaptureStep,
  sleep: (ms: number) => Promise<unknown>,
): Promise<void> {
  switch (step.op) {
    case 'wait':
      await sleep(step.ms ?? 500);
      break;
    case 'clickText': {
      const status = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
            const want = norm(${JSON.stringify(step.text)});
            const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, li, div, span'))
              .filter((n) => n instanceof HTMLElement);
            let el = nodes.find((n) => norm(n.textContent) === want)
                   || nodes.find((n) => norm(n.textContent).startsWith(want));
            if (!el) return 'NOTFOUND';
            const clickable = el.closest('button, [role="button"], a, li') || el;
            (clickable as HTMLElement).click();
            return 'OK';
          } catch (e) { return 'THROW:' + (e && e.message); }
        })()
      `) as string;
      if (status !== 'OK') console.warn(`[capture] 点击「${step.text}」失败：${status}`);
      await sleep(800);
      break;
    }
    case 'loadSession':
      await win.webContents.executeJavaScript(`
        (async () => {
          const r = await window.nanoharness.loadSession(${JSON.stringify(step.file)});
          window.dispatchEvent(new Event('session-loaded'));
          return r.ok;
        })()
      `);
      await sleep(700);
      break;
    case 'js': {
      const r = await win.webContents.executeJavaScript(step.code);
      console.log('[capture:js]', typeof r === 'string' ? r : JSON.stringify(r));
      await sleep(500);
      break;
    }
    case 'shot': {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(step.path), { recursive: true });
      fs.writeFileSync(step.path, img.toPNG());
      await sleep(300);
      break;
    }
  }
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
  ipcMain.handle('theme:set', (_e, mode: unknown) => {
    if (mode !== 'system' && mode !== 'light' && mode !== 'dark') {
      return { dark: nativeTheme.shouldUseDarkColors };
    }
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
