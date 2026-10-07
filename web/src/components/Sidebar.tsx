/**
 * Sidebar.tsx —— 毛玻璃侧栏
 *
 * 上：品牌（左侧留白给 macOS 红绿灯）
 * 中：三个导航项（对话/插件/设置）+ 会话历史列表
 * 下：状态说明
 * 会话列表由 sessionTick 驱动刷新：每完成一轮对话自动拉一次。
 */

import { useEffect, useState } from 'react';
import { api, type SessionInfo } from '../api.js';
import { ZapIcon, ChatIcon, PuzzleIcon, SettingsIcon, PlusIcon } from './icons.js';

interface Props {
  page: 'chat' | 'plugins' | 'settings';
  onNavigate: (page: 'chat' | 'plugins' | 'settings') => void;
  sessionTick: number;
  onOpenSession: () => void;
  /** 加载会话成功后通知聊天页重建消息（简单起见由父级透传回调） */
}

const navItems = [
  { key: 'chat' as const, label: '对话', icon: <ChatIcon /> },
  { key: 'plugins' as const, label: '插件市场', icon: <PuzzleIcon /> },
  { key: 'settings' as const, label: '设置', icon: <SettingsIcon /> },
];

export default function Sidebar({ page, onNavigate, sessionTick, onOpenSession }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    void api.listSessions().then(setSessions).catch(() => setSessions([]));
  }, [sessionTick]);

  const openSession = async (file: string) => {
    await api.loadSession(file);
    onNavigate('chat');
    onOpenSession();
    // 通知聊天页重绘历史（经由全局事件：聊天页监听 window 自定义事件，见 ChatPage）
    window.dispatchEvent(new CustomEvent('session-loaded'));
  };

  const newChat = async () => {
    await api.newChat();
    window.dispatchEvent(new CustomEvent('session-loaded'));
    onNavigate('chat');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark"><ZapIcon size={12} /></span>
        nano-harness
      </div>

      <button className="nav-item" onClick={newChat}>
        <PlusIcon /> 新对话
      </button>

      <nav style={{ display: 'flex', flexDirection: 'column' }}>
        {navItems.map(({ key, label, icon }) => (
          <button
            key={key}
            className={`nav-item${page === key ? ' active' : ''}`}
            onClick={() => onNavigate(key)}
          >
            {icon} {label}
          </button>
        ))}
      </nav>

      <div className="sidebar-section">历史会话</div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {sessions.length === 0 && (
          <div style={{ padding: '4px 9px', fontSize: 12, color: 'var(--fg-secondary)' }}>
            暂无会话
          </div>
        )}
        {sessions.map((s) => (
          <button key={s.file} className="session-item" onClick={() => openSession(s.file)} title={s.title}>
            {s.title}
          </button>
        ))}
      </div>

      <div className="sidebar-footer" style={{ fontSize: 11, color: 'var(--fg-secondary)', padding: '4px 9px' }}>
        v0.2.0 · 模型在本地终端运行
      </div>
    </aside>
  );
}
