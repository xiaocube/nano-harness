/**
 * Sidebar.tsx —— 毛玻璃侧栏（dsh 风格布局）
 *
 * 上：品牌
 * 主操作：新建任务（agent 的一切从这里开始）+ 插件市场
 * 工作区分组：搜索框 + 归档筛选（隐藏已归档/全部/仅已归档）→ 会话列表（hover 归档）
 * 底部：设置入口 + 版本
 * 会话列表由 sessionTick 驱动刷新：每完成一轮对话自动拉一次。
 */

import { useEffect, useState } from 'react';
import { api, type SessionInfo } from '../api.js';
import { ZapIcon, PuzzleIcon, SettingsIcon, PlusIcon, FolderIcon, SearchIcon, SlidersIcon, ArchiveIcon, CheckIcon } from './icons.js';

interface Props {
  page: 'chat' | 'plugins';
  settingsOpen: boolean;
  onNavigate: (page: 'chat' | 'plugins') => void;
  onOpenSettings: () => void;
  sessionTick: number;
  onOpenSession: () => void;
}

type ArchiveFilter = 'hide' | 'all' | 'only';
const FILTER_LABELS: Record<ArchiveFilter, string> = {
  hide: '隐藏已归档', all: '全部对话', only: '仅显示已归档',
};

export default function Sidebar({ page, settingsOpen, onNavigate, onOpenSettings, sessionTick, onOpenSession }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ArchiveFilter>('hide');
  const [filterMenu, setFilterMenu] = useState(false);
  const [workspace, setWorkspace] = useState('…');

  useEffect(() => {
    void api.listSessions(filter).then(setSessions).catch(() => setSessions([]));
  }, [sessionTick, filter]);

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
    window.dispatchEvent(new CustomEvent('session-loaded'));
  };

  const newTask = async () => {
    await api.newChat();
    window.dispatchEvent(new CustomEvent('session-loaded'));
    onNavigate('chat');
  };

  const shown = sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));

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
      <div className="sidebar-tools">
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="搜索会话"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索会话"
        />
        <button
          className={`icon-btn${filter !== 'hide' ? ' filtered' : ''}`}
          title="筛选会话"
          style={{ width: 26, height: 26 }}
          onClick={() => setFilterMenu((v) => !v)}
        >
          <SlidersIcon size={13} />
        </button>
      </div>
      {filterMenu && (
        <div className="pill-popover" style={{ position: 'static', marginBottom: 6 }}>
          {(['hide', 'all', 'only'] as ArchiveFilter[]).map((k) => (
            <button key={k} onClick={() => { setFilter(k); setFilterMenu(false); }}>
              {FILTER_LABELS[k]}
              {filter === k && <span className="check"><CheckIcon size={13} /></span>}
            </button>
          ))}
        </div>
      )}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {shown.length === 0 && (
          <div style={{ padding: '4px 9px 4px 23px', fontSize: 12, color: 'var(--fg-secondary)' }}>
            {query ? '没有匹配的会话' : '暂无会话'}
          </div>
        )}
        {shown.map((s) => (
          <button key={s.file} className="session-item indented" onClick={() => openSession(s.file)}>
            <span className="s-title" style={s.archived ? { opacity: 0.6 } : undefined}>{s.title}</span>
            <span
              className="archive-btn"
              role="button"
              aria-label={s.archived ? '取消归档' : '归档'}
              title={s.archived ? '取消归档' : '归档'}
              onClick={async (e) => {
                e.stopPropagation();
                await api.archiveSession(s.file, !s.archived);
                setSessions((xs) => xs.map((x) => (x.file === s.file ? { ...x, archived: !x.archived } : x)));
              }}
            >
              <ArchiveIcon size={13} />
            </span>
          </button>
        ))}
      </div>

      <div className="sidebar-footer" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button
          className={`nav-item${settingsOpen ? ' active' : ''}`}
          onClick={onOpenSettings}
        >
          <SettingsIcon /> 设置
        </button>
        <div style={{ fontSize: 11, color: 'var(--fg-secondary)', padding: '2px 9px' }}>
          v0.3.0 · 模型在本地终端运行
        </div>
      </div>
    </aside>
  );
}
