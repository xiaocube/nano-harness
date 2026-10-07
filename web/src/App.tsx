/**
 * App.tsx —— 界面壳：主题中枢 + 页面切换 + 右侧预览面板 + 设置弹窗
 *
 * 布局：侧栏 | 内容区（对话/文件/插件） | 右侧预览面板（可拖拽调宽，带标签页）
 * 预览面板的状态（开了哪些标签、当前哪个）在这一层，因为对话页和文件页都要往里塞文件。
 *
 * 主题：挂载时从主进程取系统外观并监听变化（macOS 深浅色切换实时跟随），
 * 写到 <html data-theme> 驱动 tokens.css 的全部变量切换。
 */

import { useEffect, useState } from 'react';
import { api, isMock } from './api.js';
import { useWorkspace } from './useWorkspace.js';
import Sidebar from './components/Sidebar.js';
import ChatPage from './components/ChatPage.js';
import PluginsPage from './components/PluginsPage.js';
import FilesPage from './components/FilesPage.js';
import SettingsModal from './components/SettingsModal.js';
import PreviewPane, { type PreviewTab } from './components/PreviewPane.js';
import PermissionGate from './components/PermissionGate.js';

type Page = 'chat' | 'plugins' | 'files';

export default function App() {
  const [page, setPage] = useState<Page>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 侧栏会话列表刷新令牌：聊天页跑完一轮后 +1，侧栏据此重新拉取 */
  const [sessionTick, setSessionTick] = useState(0);
  /** 右侧预览面板：标签 + 当前选中 */
  const [tabs, setTabs] = useState<PreviewTab[]>([]);
  const [activeRel, setActiveRel] = useState<string | null>(null);
  const ws = useWorkspace();

  /** 在右侧面板里打开一个文件（已开过就切过去，不重复开标签） */
  const openPreview = (rel: string) => {
    const name = rel.split('/').pop() ?? rel;
    setTabs((ts) => (ts.some((t) => t.rel === rel) ? ts : [...ts, { rel, name }]));
    setActiveRel(rel);
  };

  const closeTab = (rel: string) => {
    // 先在事件处理阶段算好新状态，再分别 set（不要在 updater 里做副作用）
    const next = tabs.filter((t) => t.rel !== rel);
    setTabs(next);
    setActiveRel((cur) => (cur === rel ? next[next.length - 1]?.rel ?? null : cur));
  };

  const closeAll = () => { setTabs([]); setActiveRel(null); };

  // 工作区换了，之前打开的预览路径就不成立了 —— 全部关掉，避免看到别的文件夹的内容
  useEffect(() => {
    setTabs([]);
    setActiveRel(null);
  }, [ws.workspace]);

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
        {page === 'chat' && <ChatPage onTurnDone={() => setSessionTick((t) => t + 1)} onPreview={openPreview} />}
        {page === 'plugins' && <PluginsPage />}
        {page === 'files' && <FilesPage onPreview={openPreview} />}
      </main>
      {tabs.length > 0 && (
        <PreviewPane
          tabs={tabs}
          active={activeRel}
          onSelect={setActiveRel}
          onClose={closeTab}
          onCloseAll={closeAll}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onGoPlugins={() => setPage('plugins')}
        />
      )}
      {/* 权限弹窗挂在最外层：切页面/重载窗口都不会把它弄丢（丢了 agent 就永久卡住） */}
      <PermissionGate />
      {isMock && <div className="mock-badge">浏览器 Mock 模式（桌面功能完整版请运行 npm run desktop）</div>}
    </div>
  );
}
