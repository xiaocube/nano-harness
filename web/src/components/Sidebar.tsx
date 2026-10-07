/**
 * Sidebar.tsx —— 毛玻璃侧栏（dsh 风格布局）
 *
 * 上：品牌
 * 主操作：新建任务（agent 的一切从这里开始）
 * 工作区分组：默认工作区 → 其下挂该工作区的历史会话
 * 底部：设置入口 + 版本
 * 会话列表由 sessionTick 驱动刷新：每完成一轮对话自动拉一次。
 */

import { useEffect, useState } from 'react';
import { api, type SessionInfo } from '../api.js';
import { ZapIcon, PuzzleIcon, SettingsIcon, PlusIcon, FolderIcon } from './icons.js';

interface Props {
  page: 'chat' | 'plugins' | 'settings';
  onNavigate: (page: 'chat' | 'plugins' | 'settings') => void;
  sessionTick: number;
  onOpenSession: () => void;
}

export default function Sidebar({ page, onNavigate, sessionTick, onOpenSession }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspace, setWorkspace] = useState('…');

  useEffect(() => {
    void api.listSessions().then(setSessions).catch(() => setSessions([]));
  }, [sessionTick]);

  useEffect(() => {
    void api.getAppInfo().then((info) => {
      const parts = info.workspace.split('/');
      setWorkspace(parts[parts.length - 1] || info.workspace);
    }).catch(() => setWorkspace('默认工作区'));
  }, []);

  const openSession = async (file: string) => {
    await api.loadSession(file);
    onNavigate('chat');
    onOpenSession();
    // 通知聊天页重绘历史（经由全局事件：聊天页监听 window 自定义事件，见 ChatPage）
    window.dispatchEvent(new CustomEvent('session-loaded'));
  };

  const newTask = async () => {
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

      <button className="nav-item" onClick={newTask}>
        <PlusIcon /> 新建任务
      </button>
      <button
        className={`nav-item${page === 'plugins' ? ' active' : ''}`}
        onClick={() => onNavigate('plugins')}
      >
        <PuzzleIcon /> 插件市场
      </button>

      <div className="sidebar-section">工作区</div>
      <div className="workspace-item">
        <FolderIcon size={14} /> {workspace}
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {sessions.length === 0 && (
          <div style={{ padding: '4px 9px 4px 23px', fontSize: 12, color: 'var(--fg-secondary)' }}>
            暂无会话
          </div>
        )}
        {sessions.map((s) => (
          <button key={s.file} className="session-item indented" onClick={() => openSession(s.file)} title={s.title}>
            {s.title}
          </button>
        ))}
      </div>

      <div className="sidebar-footer" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button
          className={`nav-item${page === 'settings' ? ' active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          <SettingsIcon /> 设置
        </button>
        <div style={{ fontSize: 11, color: 'var(--fg-secondary)', padding: '2px 9px' }}>
          v0.2.0 · 模型在本地终端运行
        </div>
      </div>
    </aside>
  );
}
