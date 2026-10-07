/**
 * FilePreviewBody.tsx —— 单个文件的预览内容（右侧面板的身体）
 *
 * 只负责"把文件渲染出来"，不负责面板/标签/尺寸——那些由 PreviewPane 管。
 * 按类型分流：
 *   html     → sandbox iframe，src 走 nh-file:// 自定义协议（见主进程的 protocol.handle）
 *   markdown → 渲染成排版
 *   image    → <img>
 *   text     → 等宽代码块
 *   binary   → 说明 + 「用默认应用打开」
 */

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type FilePreviewData } from '../api.js';
import { FolderIcon, ExternalLinkIcon, RefreshIcon } from './icons.js';

/** 把字节数变成人看的大小 */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilePreviewBody({ rel }: { rel: string }) {
  const [file, setFile] = useState<FilePreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    void api.previewFile(rel)
      .then((data) => {
        if (!alive) return;
        if (data.ok) setFile(data);
        else { setFile(null); setError(data.message ?? '打不开这个文件'); }
      })
      .catch((err) => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [rel, tick]);

  const openExternal = async () => {
    try {
      const res = await api.openFileExternal(rel);
      if (!res.ok && res.message) setError(res.message);
    } catch (err) {
      setError(`打开失败：${(err as Error).message}`);
    }
  };

  const reveal = async () => {
    try {
      const res = await api.revealFile(rel);
      if (!res.ok && res.message) setError(res.message);
    } catch (err) {
      setError(`在访达中显示失败：${(err as Error).message}`);
    }
  };

  return (
    <>
      <div className="pane-subbar">
        <span className="preview-meta mono" title={file?.absPath ?? rel}>
          {file ? `${file.rel} · ${formatSize(file.size)}` : rel}
        </span>
        <div className="preview-actions">
          <button className="icon-btn" title="重新读取" aria-label="重新读取" onClick={() => setTick((t) => t + 1)}>
            <RefreshIcon size={14} />
          </button>
          <button className="icon-btn" title="在访达中显示" aria-label="在访达中显示" onClick={() => void reveal()}>
            <FolderIcon size={14} />
          </button>
          <button className="icon-btn" title="用系统默认应用打开（HTML = 浏览器）" aria-label="用默认应用打开" onClick={() => void openExternal()}>
            <ExternalLinkIcon size={14} />
          </button>
        </div>
      </div>

      <div className="preview-body">
        {error && <div className="preview-note preview-note-err">{error}</div>}
        {!file && !error && <div className="preview-note">正在读取…</div>}

        {file?.ok && file.kind === 'html' && file.url && (
          /*
           * 被预览页面来自 nh-file:// 这个独立来源，与应用页面的 file:// 不同源，
           * 所以给 allow-same-origin 是安全的：它能用自己的 localStorage（不少小游戏靠它
           * 存最高分），但读不到宿主 DOM / window.nanoharness；没给顶层跳转和弹窗权限。
           */
          <iframe
            className="preview-frame"
            title={file.name}
            src={file.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"
          />
        )}

        {file?.ok && file.kind === 'image' && file.dataUrl && (
          <div className="preview-center"><img className="preview-image" src={file.dataUrl} alt={file.name} /></div>
        )}

        {file?.ok && file.kind === 'markdown' && (
          <div className="preview-doc md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
            >
              {file.text ?? ''}
            </ReactMarkdown>
          </div>
        )}

        {file?.ok && file.kind === 'text' && <pre className="preview-code">{file.text ?? ''}</pre>}

        {file?.ok && (file.kind === 'binary' || (!file.url && !file.dataUrl && !file.text && file.kind !== 'dir')) && (
          <div className="preview-note">
            {file.message ?? '这个格式没法在客户端里预览'}
            <div style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => void openExternal()}>
                <ExternalLinkIcon size={13} /> 用默认应用打开
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
