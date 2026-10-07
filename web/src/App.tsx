/**
 * App.tsx —— 界面壳：主题中枢 + 三页导航
 *
 * 主题：挂载时从主进程取系统外观并监听变化（macOS 深浅色切换实时跟随），
 * 写到 <html data-theme> 驱动 tokens.css 的全部变量切换。
 */

import { useEffect, useState } from 'react';
import { api, isMock } from './api.js';
import Sidebar from './components/Sidebar.js';
import ChatPage from './components/ChatPage.js';
import PluginsPage from './components/PluginsPage.js';
import SettingsPage from './components/SettingsPage.js';

type Page = 'chat' | 'plugins' | 'settings';

export default function App() {
  const [page, setPage] = useState<Page>('chat');
  /** 侧栏会话列表刷新令牌：聊天页跑完一轮后 +1，侧栏据此重新拉取 */
  const [sessionTick, setSessionTick] = useState(0);

  // 主题：跟随系统 + 监听变化（在设置页也可手动三态覆盖）
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
        onNavigate={setPage}
        sessionTick={sessionTick}
        onOpenSession={() => setPage('chat')}
      />
      <main className="content">
        <div className="titlebar-drag" />
        {page === 'chat' && <ChatPage onTurnDone={() => setSessionTick((t) => t + 1)} />}
        {page === 'plugins' && <PluginsPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
      {isMock && <div className="mock-badge">浏览器 Mock 模式（桌面功能完整版请运行 npm run desktop）</div>}
    </div>
  );
}
