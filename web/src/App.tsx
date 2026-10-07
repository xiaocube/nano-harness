/**
 * App.tsx —— 界面壳：主题中枢 + 页面切换 + 设置弹窗
 *
 * 主题：挂载时从主进程取系统外观并监听变化（macOS 深浅色切换实时跟随），
 * 写到 <html data-theme> 驱动 tokens.css 的全部变量切换。
 * 设置不是独立页面而是覆盖弹窗（dsh 风格），关闭后回到原页面。
 */

import { useEffect, useState } from 'react';
import { api, isMock } from './api.js';
import Sidebar from './components/Sidebar.js';
import ChatPage from './components/ChatPage.js';
import PluginsPage from './components/PluginsPage.js';
import SettingsModal from './components/SettingsModal.js';

type Page = 'chat' | 'plugins';

export default function App() {
  const [page, setPage] = useState<Page>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 侧栏会话列表刷新令牌：聊天页跑完一轮后 +1，侧栏据此重新拉取 */
  const [sessionTick, setSessionTick] = useState(0);

  // 主题：跟随系统 + 监听变化（在设置里也可手动三态覆盖）
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void api.getTheme().then(({ dark }) => {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    });
    cleanup = api.onThemeChanged(({ dark }) => {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    });
    return cleanup;
  }, []);

  return (
    <div className="app">
      <Sidebar
        page={page}
        settingsOpen={settingsOpen}
        onNavigate={setPage}
        onOpenSettings={() => setSettingsOpen(true)}
        sessionTick={sessionTick}
        onOpenSession={() => setPage('chat')}
      />
      <main className="content">
        <div className="titlebar-drag" />
        {page === 'chat' && <ChatPage onTurnDone={() => setSessionTick((t) => t + 1)} />}
        {page === 'plugins' && <PluginsPage />}
      </main>
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onGoPlugins={() => setPage('plugins')}
        />
      )}
      {isMock && <div className="mock-badge">浏览器 Mock 模式（桌面功能完整版请运行 npm run desktop）</div>}
    </div>
  );
}
