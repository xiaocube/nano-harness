/**
 * Sidebar.tsx —— 毛玻璃侧栏（对齐 dsh 的 grouped session list）
 *
 * 结构：
 *   品牌
 *   对话 / 新建任务 / 插件市场
 *   工作区（分组列表）：每个打开过的文件夹一行，**点一下展开它下面的对话**
 *                        ＋ 打开文件夹…
 *   底部：设置 + 版本
 *
 * 分组规则：会话文件里记着自己是在哪个文件夹跑的（session.ts 的 workspace 字段），
 * 侧栏据此把会话挂到对应文件夹下——这正是 dsh 侧栏的组织方式。
 * 早期版本没有这个字段的会话，统一放进"未记录文件夹"组。
 *
 * 布局铁律：所有行缩进只能用 padding，绝不能用 margin —— width:100% + margin
 * 会让行右边缘超出父容器，既对不齐又挤出横向滚动条（v0.3.1 修过这个问题）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type SessionInfo } from '../api.js';
import { useWorkspace, baseName } from '../useWorkspace.js';
import { useDismiss } from '../useDismiss.js';
import {
  ZapIcon, PuzzleIcon, SettingsIcon, PlusIcon, ChatIcon,
  SlidersIcon, ArchiveIcon, CheckIcon, FolderIcon, FolderPlusIcon, ChevronDownIcon, FileIcon,
} from './icons.js';

interface Props {
  page: 'chat' | 'plugins' | 'files';
  settingsOpen: boolean;
  onNavigate: (page: 'chat' | 'plugins' | 'files') => void;
  onOpenSettings: () => void;
  sessionTick: number;
  onOpenSession: () => void;
}

type ArchiveFilter = 'hide' | 'all' | 'only';
const FILTER_LABELS: Record<ArchiveFilter, string> = {
  hide: '隐藏已归档', all: '全部对话', only: '仅显示已归档',
};

/** 侧栏里的一个文件夹分组 */
interface Group {
  /** 分组键：工作区绝对路径，或 '' 表示"未记录文件夹" */
  key: string;
  name: string;
  sessions: SessionInfo[];
  isCurrent: boolean;
  /** 在"最近打开"里的位次（越小越新），用于给还没有对话的文件夹排序 */
  order: number;
}

export default function Sidebar({ page, settingsOpen, onNavigate, onOpenSettings, sessionTick, onOpenSession }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ArchiveFilter>('hide');
  const [filterMenu, setFilterMenu] = useState(false);
  /** 搜索/筛选区的容器：点外面或 Esc 都收起筛选菜单 */
  const filterRef = useRef<HTMLDivElement>(null);
  useDismiss(filterMenu, filterRef, () => setFilterMenu(false));
  const [version, setVersion] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  /** 手动展开/收起过的文件夹；没点过的以"当前工作区默认展开"为准 */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const ws = useWorkspace();

  const refreshSessions = (f: ArchiveFilter = filter) => {
    void api.listSessions(f).then(setSessions).catch(() => setSessions([]));
  };

  useEffect(() => {
    refreshSessions(filter);
  }, [sessionTick, filter]);

  useEffect(() => {
    void api.getAppInfo().then((info) => setVersion(info.version)).catch(() => {});
  }, []);

  // 提示 4 秒后自动消失，避免侧栏长期挂着一行旧消息
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  /** 搜索过滤（按标题匹配） */
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  }, [sessions, query]);

  /**
   * 按工作区分组，**始终按修改时间倒序**（点谁都不会跳位）。
   *
   * 一个文件夹的"修改时间"取两者中较新的：
   *   - 它下面最新一条对话的 updatedAt（聊天视角的"最近活动"）
   *   - 文件夹自身的文件系统 mtime（刚打开、还没有对话时靠它参与排序）
   * 之前是"当前工作区永远排第一"，于是点一下就窜到顶部，看起来像列表在乱动——已改掉。
   * 当前工作区仍然有蓝色圆点和加粗名字标记，只是不再抢位置。
   *
   * 另外：打开过的文件夹即使一条对话都没有也要出现在列表里（否则用户刚打开一个
   * 空文件夹、切走之后就再也找不到它了）。已知文件夹 = 当前工作区 + 最近打开过的。
   */
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    const ensure = (key: string, isCurrent: boolean, order: number): Group => {
      let g = map.get(key);
      if (!g) {
        g = { key, name: key ? baseName(key) : '未记录文件夹', sessions: [], isCurrent, order };
        map.set(key, g);
      }
      if (isCurrent) g.isCurrent = true;
      return g;
    };

    // 搜索时只显示有命中的文件夹；平时把所有已知文件夹都摆出来
    if (!query.trim()) {
      ws.recent.forEach((p, i) => { if (p) ensure(p, p === ws.workspace, i); });
      if (ws.workspace) ensure(ws.workspace, true, 0);
    }
    for (const s of matched) {
      const key = s.workspace ?? '';
      ensure(key, Boolean(key) && key === ws.workspace, 99).sessions.push(s);
    }

    const timeOf = (g: Group): number => {
      const latest = g.sessions[0]?.updatedAt ? Date.parse(g.sessions[0].updatedAt) : 0;
      const folder = g.key ? ws.mtimes?.[g.key] ?? 0 : 0;
      return Math.max(latest, folder);
    };

    return [...map.values()].sort((a, b) => {
      const diff = timeOf(b) - timeOf(a);
      if (diff !== 0) return diff;
      // 时间一样（例如都是空文件夹）时按"最近打开"的次序兜底，保证顺序稳定
      return a.order - b.order;
    });
  }, [matched, ws.workspace, ws.recent, ws.mtimes, query]);

  /** 搜索时强制展开，方便直接看到命中项 */
  const isOpen = (g: Group) => (query.trim() ? true : toggled[g.key] ?? g.isCurrent);

  const chooseWorkspace = async () => {
    try {
      const res = await api.chooseWorkspace();
      if (res.ok && res.path) setNotice(`已打开文件夹：${res.path}`);
      else if (!res.canceled) setNotice('没有选择文件夹');
    } catch (err) {
      setNotice(`打开文件夹失败：${(err as Error).message}`);
    }
  };

  /** 开一个空白新任务：清空当前对话视图，工作区保持不变（文件仍在各自分组里） */
  const startBlankTask = async () => {
    const res = await api.newChat();
    if (!res.ok) {           // 任务执行中会被主进程拒绝，别把提示吞掉
      setNotice(res.error ?? '暂时无法新建任务');
      return;
    }
    setNotice(null);
    window.dispatchEvent(new CustomEvent('session-loaded'));
    onNavigate('chat');
  };

  /** 点文件夹标题：展开/收起；切到该文件夹；**它下面还没有对话时直接进空白新任务界面** */
  const clickGroup = async (g: Group) => {
    const wasOpen = isOpen(g);
    setToggled((t) => ({ ...t, [g.key]: !wasOpen }));
    if (g.key && g.key !== ws.workspace) {
      try {
        const res = await api.setWorkspace(g.key);
        setNotice(res.message);
      } catch (err) {
        setNotice(`切换失败：${(err as Error).message}`);
      }
      // 空文件夹 = 还没有任何对话：切过去时顺手给一个空白新任务界面，
      // 别让用户盯着上一个文件夹的旧对话。
      // 注意只在"真的切换了工作区且是展开动作"时做——只是想收起分组时
      // 不应该把当前对话清掉。
      if (g.sessions.length === 0 && !wasOpen) await startBlankTask();
    }
  };

  const openSession = async (s: SessionInfo) => {
    // 会话记着自己属于哪个文件夹：切回去，别让后续任务跑到别的目录
    if (s.workspace && s.workspace !== ws.workspace) {
      try { await api.setWorkspace(s.workspace); } catch { /* 文件夹没了就保持现状 */ }
    }
    try {
      await api.loadSession(s.file);
    } catch (err) {
      setNotice(`打开会话失败：${(err as Error).message}`);
      return;
    }
    onNavigate('chat');
    onOpenSession();
    window.dispatchEvent(new CustomEvent('session-loaded'));
  };

  const toggleArchive = async (s: SessionInfo) => {
    await api.archiveSession(s.file, !s.archived);
    // 重新拉取而不是就地改标记：筛选模式是"仅已归档"时，取消归档的行应当立刻消失
    refreshSessions();
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark"><ZapIcon size={12} /></span>
        nano-harness
      </div>

      <button className={`nav-item${page === 'chat' ? ' active' : ''}`} onClick={() => onNavigate('chat')}>
        <ChatIcon /> 对话
      </button>
      <button className="nav-item" onClick={() => void startBlankTask()}>
        <PlusIcon /> 新建任务
      </button>
      <button
        className={`nav-item${page === 'files' ? ' active' : ''}`}
        onClick={() => onNavigate('files')}
      >
        <FileIcon /> 文件
      </button>
      <button
        className={`nav-item${page === 'plugins' ? ' active' : ''}`}
        onClick={() => onNavigate('plugins')}
      >
        <PuzzleIcon /> 插件市场
      </button>

      <div className="sidebar-section">工作区</div>
      {/* 搜索结果 + 筛选按钮 + 展开的筛选菜单包在同一个容器里：
          这样"点外面关闭"的判定不会把菜单内部的点击也算成外面 */}
      <div className="sidebar-filter" ref={filterRef}>
        <div className="sidebar-tools">
          <input
            className="input"
            placeholder="搜索对话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索对话"
          />
          <button
            className={`icon-btn${filter !== 'hide' ? ' filtered' : ''}`}
            title={`筛选对话：${FILTER_LABELS[filter]}`}
            aria-label="筛选对话"
            onClick={() => setFilterMenu((v) => !v)}
          >
            <SlidersIcon size={13} />
          </button>
        </div>
        {filterMenu && (
          <div className="pill-popover static-popover" role="menu">
            {(['hide', 'all', 'only'] as ArchiveFilter[]).map((k) => (
              <button key={k} type="button" onClick={() => { setFilter(k); setFilterMenu(false); }}>
                {FILTER_LABELS[k]}
                {filter === k && <span className="check"><CheckIcon size={13} /></span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {notice && <div className="sidebar-notice" role="status">{notice}</div>}

      <div className="session-list">
        {groups.length === 0 && (
          <div className="session-empty">{query ? '没有匹配的对话' : '暂无对话'}</div>
        )}

        {groups.map((g) => {
          const open = isOpen(g);
          return (
            <div key={g.key || '__untagged'} className="ws-group-block">
              <div className={`ws-group-head${g.isCurrent ? ' active' : ''}`}>
                <button
                  type="button"
                  className="ws-group-toggle"
                  onClick={() => void clickGroup(g)}
                  aria-expanded={open}
                  title={g.key
                    ? `${g.key}\n点击${open ? '收起' : '展开'}对话；${g.isCurrent ? '当前工作区' : '并切换到该文件夹'}`
                    : '这些对话创建于旧版本，没有记录所属文件夹'}
                >
                  <ChevronDownIcon size={12} className={`ws-caret${open ? '' : ' closed'}`} />
                  <FolderIcon size={14} />
                  <span className="ws-name">{g.name}</span>
                  {g.isCurrent && <span className="ws-current-dot" title="当前工作区" />}
                  <span className="ws-group-count">{g.sessions.length}</span>
                </button>
              </div>

              {open && (
                <div className="ws-group-body">
                  {g.sessions.length === 0 && (
                    <button
                      type="button"
                      className="session-empty session-empty-action"
                      onClick={() => void startBlankTask()}
                      title="在左侧这个文件夹里开始一个新任务"
                    >
                      还没有对话 · 点这里开始新任务
                    </button>
                  )}
                  {g.sessions.map((s) => (
                    <div key={s.file} className="session-item">
                      <button
                        type="button"
                        className="session-open"
                        onClick={() => void openSession(s)}
                        title={`${s.title}\n${s.updatedAt.replace('T', ' ').slice(0, 16)}`}
                      >
                        <span className="s-title" style={s.archived ? { opacity: 0.6 } : undefined}>{s.title}</span>
                      </button>
                      <button
                        type="button"
                        className="archive-btn"
                        aria-label={s.archived ? '取消归档' : '归档'}
                        title={s.archived ? '取消归档' : '归档'}
                        onClick={() => void toggleArchive(s)}
                      >
                        <ArchiveIcon size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <button
          type="button"
          className="workspace-item ws-add"
          onClick={() => void chooseWorkspace()}
          title="打开一个新的文件夹作为工作区（可在系统选择框里新建文件夹）"
        >
          <FolderPlusIcon size={14} />
          <span className="ws-name">打开文件夹…</span>
        </button>
      </div>

      <div className="sidebar-footer">
        <button
          className={`nav-item${settingsOpen ? ' active' : ''}`}
          onClick={onOpenSettings}
        >
          <SettingsIcon /> 设置
        </button>
        <div className="sidebar-version">v{version || '—'} · 模型在本机运行</div>
      </div>
    </aside>
  );
}
