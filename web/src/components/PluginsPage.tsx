/**
 * PluginsPage.tsx —— 插件市场（dsh 风格）
 *
 * 参照 dsh 的插件页布局：标题 + "添加插件"主按钮，官方插件以列表行呈现，
 * 每行 = 彩色图标 + 名称徽章 + 描述 + 工具清单 + 启用开关（实时生效）。
 * 已安装但不在官方索引里的本地插件单列一节。
 * "添加插件"弹窗提供两条路径：Finder 打开插件目录手动放置 / 提 PR 上架官方索引。
 */

import { useEffect, useRef, useState } from 'react';
import { api, type InstalledPlugin, type MarketplaceEntry } from '../api.js';
import { useDismiss } from '../useDismiss.js';
import { PuzzleIcon, DownloadIcon, CheckIcon, TrashIcon, RefreshIcon, PlusIcon, FolderIcon, XIcon } from './icons.js';

/** 按插件名稳定选一个颜色，让每行图标像 dsh 一样各有身份 */
const TINTS = ['#0A84FF', '#16A34A', '#EA580C', '#8B5CF6', '#0EA5E9', '#DB2777', '#CA8A04'];
function tintOf(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

/** 一个统一的行数据：市场条目 ∪ 本地已安装 */
interface Row {
  key: string;
  name: string;
  title: string;
  description: string;
  author: string;
  version: string;
  keywords?: string[];
  installed: boolean;
  enabled: boolean;
  toolNames: string[];
  loadError: string | null;
  official: boolean;
}

export default function PluginsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  /** "添加插件"弹窗：点遮罩空白处 / Esc 都能关 */
  const addSheetRef = useRef<HTMLDivElement>(null);
  useDismiss(showAdd, addSheetRef, () => setShowAdd(false));

  const refresh = async () => {
    try {
      const [index, installed] = await Promise.all([api.listMarketplace(), api.listInstalledPlugins()]);
    const byName = new Map(installed.map((p) => [p.manifest.name, p]));
    const official: Row[] = index.plugins.map((e: MarketplaceEntry) => {
      const inst = byName.get(e.name);
      return {
        key: e.name, name: e.name, title: e.title, description: e.description,
        author: e.author, version: inst?.manifest.version ?? e.version, keywords: e.keywords,
        installed: Boolean(inst), enabled: inst?.enabled ?? false,
        toolNames: inst?.toolNames ?? [], loadError: inst?.loadError ?? null, official: true,
      };
    });
    // 已安装但不在官方索引里的（手动放进插件目录的），单独列出
    const local: Row[] = installed
      .filter((p) => !index.plugins.some((e) => e.name === p.manifest.name))
      .map((p: InstalledPlugin) => ({
        key: p.manifest.name, name: p.manifest.name, title: p.manifest.name,
        description: p.manifest.description, author: p.manifest.author, version: p.manifest.version,
        installed: true, enabled: p.enabled, toolNames: p.toolNames,
        loadError: p.loadError, official: false,
      }));
      setRows([...official, ...local]);
    } catch (err) {
      setNotice(`读取插件失败：${(err as Error).message}`);
      setRows([]);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const install = async (name: string) => {
    setBusy(name); setNotice(null);
    try {
      const res = await api.installPlugin(name);
      setNotice(res.message);
    } catch (err) {
      setNotice(`安装失败：${(err as Error).message}`);
    } finally {
      setBusy(null);   // 必须放 finally：否则异常时按钮永远停在"安装中…"
      await refresh();
    }
  };

  const toggle = async (name: string, enabled: boolean) => {
    // 乐观更新：开关先动，结果提示随后
    setRows((xs) => xs.map((r) => (r.name === name ? { ...r, enabled } : r)));
    try {
      const res = await api.togglePlugin(name, enabled);
      setNotice(res.message);
      if (!res.ok) await refresh();
    } catch (err) {
      setNotice(`切换失败：${(err as Error).message}`);
      await refresh();
    }
  };

  const uninstall = async (name: string) => {
    try {
      const res = await api.uninstallPlugin(name);
      setNotice(res.message);
    } catch (err) {
      setNotice(`卸载失败：${(err as Error).message}`);
    } finally {
      await refresh();
    }
  };

  /** 在访达里打开插件目录（失败要说出来，不能像没反应） */
  const revealPlugins = async () => {
    try {
      const res = await api.revealPluginsDir();
      if (!res.ok) setNotice('打开插件目录失败');
    } catch (err) {
      setNotice(`打开插件目录失败：${(err as Error).message}`);
    }
  };

  const officialRows = rows.filter((r) => r.official);
  const localRows = rows.filter((r) => !r.official);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">插件</h1>
          <p className="page-sub">安装、启用和配置插件——插件是 agent 的新能力，开关实时生效。</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="icon-btn" title="刷新" onClick={() => void refresh()}><RefreshIcon size={14} /></button>
          <button className="btn btn-accent" onClick={() => setShowAdd(true)}><PlusIcon size={14} /> 添加插件</button>
        </div>
      </div>

      {notice && <div className="msg-notice" style={{ marginBottom: 12, display: 'inline-block' }}>{notice}</div>}

      <div className="section-head">官方 <span className="section-count">{officialRows.length}</span></div>
      {officialRows.map((r) => <PluginRow key={r.key} row={r} busy={busy} onInstall={install} onToggle={toggle} onUninstall={uninstall} />)}
      {officialRows.length === 0 && <div className="p-desc">市场索引为空——检查 marketplace/index.json。</div>}

      {localRows.length > 0 && (
        <>
          <div className="section-head">本地 <span className="section-count">{localRows.length}</span></div>
          {localRows.map((r) => <PluginRow key={r.key} row={r} busy={busy} onInstall={install} onToggle={toggle} onUninstall={uninstall} />)}
        </>
      )}

      {showAdd && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="添加插件">
          <div className="sheet" ref={addSheetRef}>
            <h3><PlusIcon size={16} /> 添加插件</h3>
            <p className="p-desc" style={{ marginBottom: 12 }}>
              两种方式把插件装进来：
            </p>
            <div className="detail" style={{ marginBottom: 14 }}>
              ① 手动安装：把插件文件夹（含 plugin.json + tools.mjs）放入插件目录，点"打开插件目录"直达；{'\n'}
              ② 上架市场：发布到 GitHub 后向主仓库 marketplace/index.json 提 PR，全用户可见。
            </div>
            <div className="actions">
              <button className="btn" onClick={() => setShowAdd(false)}><XIcon size={13} /> 关闭</button>
              <button className="btn btn-accent" onClick={() => { void revealPlugins(); }}>
                <FolderIcon size={13} /> 打开插件目录
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PluginRow({
  row, busy, onInstall, onToggle, onUninstall,
}: {
  row: Row;
  busy: string | null;
  onInstall: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onUninstall: (name: string) => void;
}) {
  return (
    <div className={`plugin-row${row.installed && !row.enabled ? ' disabled-row' : ''}`}>
      <span className="p-icon" style={{ background: tintOf(row.name) }}>
        <PuzzleIcon size={18} />
      </span>
      <div className="p-info">
        <div className="p-name">
          {row.title}
          {row.official && <span className="p-badge">官方</span>}
          {row.installed && <span className="p-badge p-badge-gray">v{row.version}</span>}
        </div>
        <p className="p-desc">{row.description}</p>
        {row.loadError
          ? <p className="p-tools" style={{ color: 'var(--danger)' }}>加载失败：{row.loadError}</p>
          : row.installed && row.toolNames.length > 0 && (
            <p className="p-tools">工具：{row.toolNames.join(' · ')}</p>
          )}
      </div>
      <div className="p-actions">
        {row.installed ? (
          <>
            <button className="text-btn" title="卸载" onClick={() => onUninstall(row.name)}>
              <TrashIcon size={14} />
            </button>
            <button
              className={`switch${row.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={row.enabled}
              aria-label={`启用 ${row.name}`}
              onClick={() => onToggle(row.name, !row.enabled)}
            />
          </>
        ) : (
          <button
            className="btn btn-accent"
            disabled={busy === row.name}
            onClick={() => onInstall(row.name)}
          >
            {busy === row.name ? '安装中…' : <><DownloadIcon size={13} /> 安装</>}
          </button>
        )}
      </div>
    </div>
  );
}
