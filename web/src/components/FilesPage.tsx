/**
 * FilesPage.tsx —— 工作区文件浏览（点文件即在客户端里预览）
 *
 * 为什么需要它：Agent 写完东西（比如一个贪吃蛇 HTML）之后，用户想"马上看看"，
 * 而不是自己去访达里翻文件夹再用浏览器打开。这里按目录列出工作区文件，
 * 点一下就用 FilePreview 渲染出来。
 *
 * 路径安全由主进程负责：所有列表/读取都限制在当前工作区内。
 */

import { useEffect, useState } from 'react';
import { api, type FileListing } from '../api.js';
import { useWorkspace, baseName } from '../useWorkspace.js';
import {
  FolderIcon, FileIcon, RefreshIcon, ChevronDownIcon, CpuIcon, TerminalIcon, SparkIcon, PuzzleIcon,
} from './icons.js';

/** 文件类型 → 图标（纯装饰，帮用户一眼分辨成果类型） */
function EntryIcon({ kind }: { kind: string }) {
  if (kind === 'dir') return <FolderIcon size={15} />;
  if (kind === 'html') return <SparkIcon size={15} />;
  if (kind === 'image') return <CpuIcon size={15} />;
  if (kind === 'text') return <TerminalIcon size={15} />;
  if (kind === 'markdown') return <PuzzleIcon size={15} />;
  return <FileIcon size={15} />;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilesPage({ onPreview }: { onPreview?: (rel: string) => void }) {
  const ws = useWorkspace();
  const [rel, setRel] = useState('.');
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // 工作区换了 → 回到根目录重新列
  useEffect(() => { setRel('.'); }, [ws.workspace]);

  useEffect(() => {
    let alive = true;
    setError(null);
    void api.listFiles(rel)
      .then((x) => { if (alive) setListing(x); })
      .catch((err) => { if (alive) setError(`读取目录失败：${(err as Error).message}`); });
    return () => { alive = false; };
  }, [rel, tick, ws.workspace]);

  const revealWorkspace = async () => {
    try {
      const res = await api.revealWorkspace();
      if (!res.ok) setError('在访达中打开失败（文件夹可能已被删除）');
    } catch (err) {
      setError(`在访达中打开失败：${(err as Error).message}`);
    }
  };

  const crumbs = rel === '.' ? [] : rel.split('/');

  return (
    <div className="page files-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">文件</h1>
          <p className="page-sub">
            当前工作区：<span className="mono">{ws.workspace || '…'}</span> —— 点文件直接在客户端里预览
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="icon-btn" title="刷新" onClick={() => setTick((t) => t + 1)}><RefreshIcon size={14} /></button>
          <button className="btn" onClick={() => void revealWorkspace()}><FolderIcon size={13} /> 在访达中打开</button>
        </div>
      </div>

      <div className="crumb-bar mono">
        <button className="crumb" onClick={() => setRel('.')}>{baseName(ws.workspace) || '工作区'}</button>
        {crumbs.map((c, i) => (
          <span key={i} className="crumb-item">
            <span className="crumb-sep">/</span>
            <button className="crumb" onClick={() => setRel(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
          </span>
        ))}
      </div>

      {error && <div className="preview-note preview-note-err">{error}</div>}

      {listing && listing.parent !== null && (
        <button className="file-row file-up" onClick={() => setRel(listing.parent!)}>
          <ChevronDownIcon size={14} /> <span className="file-name">返回上一级</span>
        </button>
      )}

      <div className="file-list">
        {listing?.entries.length === 0 && <div className="session-empty">这个文件夹是空的</div>}
        {listing?.entries.map((e) => (
          <button
            key={e.rel}
            className={`file-row${e.type === 'file' ? ' is-file' : ''}`}
            onClick={() => (e.type === 'dir' ? setRel(e.rel) : onPreview?.(e.rel))}
            title={e.rel}
          >
            <span className={`file-icon kind-${e.kind}`}><EntryIcon kind={e.kind} /></span>
            <span className="file-name">{e.name}</span>
            {e.type === 'file' && <span className="file-meta mono">{formatSize(e.size)}</span>}
          </button>
        ))}
      </div>

    </div>
  );
}
