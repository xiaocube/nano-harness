/**
 * PreviewPane.tsx —— 右侧预览面板（可拖拽调宽、带标签页）
 *
 * 为什么不是弹窗：看成果时经常要"一边看对话一边看结果"，弹窗会把对话盖住。
 * 这里把面板放在内容区右边，独立成列，宽度可以拖：
 *
 *   ┌────────┬──────────────┬─────────────────┐
 *   │ 侧栏    │ 对话 / 文件   │ ⇔ │ 预览面板     │
 *   └────────┴──────────────┴─────────────────┘
 *
 * 标签页让多个成果并存（比如贪吃蛇.html + README.md 来回切），
 * 关掉最后一个标签面板自动收起；宽度记在 localStorage，下次打开还是这个宽度。
 */

import { useEffect, useRef, useState } from 'react';
import FilePreviewBody from './FilePreviewBody.js';
import { FileIcon, XIcon } from './icons.js';

export interface PreviewTab {
  /** 相对工作区路径 */
  rel: string;
  name: string;
}

const WIDTH_KEY = 'nh.previewPaneWidth';
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 520;
/** 侧栏固定宽度（与 app.css 的 .sidebar 一致） */
const SIDEBAR_WIDTH = 232;
/** 内容区至少要留出的宽度——不然对话被挤成一条缝就没法用了 */
const MIN_CONTENT = 360;

/** 面板最宽：既不超过窗口 60%，也要保证内容区还剩得下 MIN_CONTENT */
function maxWidth(): number {
  const byRatio = Math.round(window.innerWidth * 0.6);
  const byContent = window.innerWidth - SIDEBAR_WIDTH - MIN_CONTENT;
  return Math.max(MIN_WIDTH, Math.min(byRatio, byContent));
}

function loadWidth(): number {
  const raw = Number(window.localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(raw) && raw >= MIN_WIDTH ? Math.min(raw, maxWidth()) : DEFAULT_WIDTH;
}

interface Props {
  tabs: PreviewTab[];
  active: string | null;
  onSelect: (rel: string) => void;
  onClose: (rel: string) => void;
  onCloseAll: () => void;
}

export default function PreviewPane({ tabs, active, onSelect, onClose, onCloseAll }: Props) {
  const [width, setWidth] = useState(loadWidth);
  const dragging = useRef(false);

  // 窗口变小的时候把面板收进可视范围
  useEffect(() => {
    const onResize = () => setWidth((w) => Math.min(w, maxWidth()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** 拖左边缘调宽：拖的时候禁用文本选中，松手后记住宽度 */
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = width;
    document.body.classList.add('resizing');

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dragging.current = false;
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', finish);
      // 指针移到窗口外松手 / 窗口失焦时也要收尾，否则 col-resize 光标会一直粘着
      window.removeEventListener('blur', finish);
      setWidth((w) => { window.localStorage.setItem(WIDTH_KEY, String(w)); return w; });
    };
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(Math.max(startW - (ev.clientX - startX), MIN_WIDTH), maxWidth());
      setWidth(next);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', finish);
    window.addEventListener('blur', finish);
  };

  /** 键盘调整宽度（无障碍：分隔条可聚焦，左右方向键各调 24px） */
  const nudge = (delta: number) => {
    setWidth((w) => {
      const next = Math.min(Math.max(w + delta, MIN_WIDTH), maxWidth());
      window.localStorage.setItem(WIDTH_KEY, String(next));
      return next;
    });
  };

  /** 双击分隔条复位宽度 */
  const resetWidth = () => {
    const w = Math.min(DEFAULT_WIDTH, maxWidth());
    setWidth(w);
    window.localStorage.setItem(WIDTH_KEY, String(w));
  };

  const activeTab = tabs.find((t) => t.rel === active) ?? tabs[tabs.length - 1];

  return (
    <aside className="preview-pane" style={{ width }}>
      <div
        className="pane-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整预览宽度"
        title="拖动调整宽度（双击复位）"
        onMouseDown={startDrag}
        onDoubleClick={resetWidth}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(24); }
          if (e.key === 'ArrowRight') { e.preventDefault(); nudge(-24); }
        }}
      />
      <div className="pane-inner">
        <div className="pane-tabs" role="tablist" aria-label="预览标签">
          {tabs.map((t) => (
            <div
              key={t.rel}
              className={`pane-tab${t.rel === activeTab?.rel ? ' active' : ''}`}
              role="tab"
              tabIndex={t.rel === activeTab?.rel ? 0 : -1}
              aria-selected={t.rel === activeTab?.rel}
              title={t.rel}
              onClick={() => onSelect(t.rel)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onSelect(t.rel);
              }}
            >
              <FileIcon size={12} />
              <span className="pane-tab-name">{t.name}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭 ${t.name}`}
                onClick={(e) => { e.stopPropagation(); onClose(t.rel); }}
              >
                <XIcon size={11} />
              </button>
            </div>
          ))}
          <button className="pane-close-all icon-btn" title="收起预览面板" aria-label="收起预览面板" onClick={onCloseAll}>
            <XIcon size={13} />
          </button>
        </div>

        {activeTab && <FilePreviewBody key={activeTab.rel} rel={activeTab.rel} />}
      </div>
    </aside>
  );
}
