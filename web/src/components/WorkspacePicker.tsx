/**
 * WorkspacePicker.tsx —— composer 上方的工作区胶囊 + 下拉
 *
 * 侧栏里的文件夹列表是 Sidebar 自己渲染的分组列表（点一下展开对话），
 * 这里只负责输入框上方那颗胶囊：显示当前文件夹名，点开可以
 *   - 看到当前工作区的完整路径
 *   - 一键切回其它打开过的文件夹
 *   - 「打开文件夹…」调原生选择框（可在里面新建文件夹）
 *   - 「在访达中打开」
 *
 * 状态全部来自主进程（useWorkspace）：选完立即落盘 + 广播，两处显示永远一致。
 * 任何 IPC 异常都转成可见提示——静默失败会让用户以为"点了没反应"。
 */

import { useRef, useState } from 'react';
import { api } from '../api.js';
import { useWorkspace, baseName, parentDir } from '../useWorkspace.js';
import { useDismiss } from '../useDismiss.js';
import { FolderIcon, FolderPlusIcon, ExternalLinkIcon, ChevronDownIcon } from './icons.js';

interface Props {
  /** 切换结果提示（失败时尤其重要，例如文件夹已被删除） */
  onNotice?: (message: string) => void;
}

export default function WorkspacePicker({ onNotice }: Props) {
  const info = useWorkspace();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击别处 / Esc 关闭下拉（容器包含了触发按钮，所以点按钮仍然是自己 toggle）
  useDismiss(open, rootRef, () => setOpen(false));

  const choose = async () => {
    setOpen(false);
    try {
      const res = await api.chooseWorkspace();
      if (res.ok && res.path) onNotice?.(`已打开文件夹：${res.path}`);
      else if (!res.canceled) onNotice?.('没有选择文件夹');
    } catch (err) {
      onNotice?.(`打开文件夹失败：${(err as Error).message}`);
    }
  };

  const pick = async (path: string) => {
    setOpen(false);
    try {
      const res = await api.setWorkspace(path);
      onNotice?.(res.message);
    } catch (err) {
      onNotice?.(`切换失败：${(err as Error).message}`);
    }
  };

  const reveal = async () => {
    setOpen(false);
    try {
      await api.revealWorkspace();
    } catch (err) {
      onNotice?.(`打开访达失败：${(err as Error).message}`);
    }
  };

  const others = info.recent.filter((p) => p && p !== info.workspace);

  return (
    <div className="ws-picker ws-pill" ref={rootRef}>
      <button
        type="button"
        className="pill"
        onClick={() => setOpen((v) => !v)}
        title={`工作区：${info.workspace || '…'}\n点击切换或打开文件夹`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="选择工作区文件夹"
      >
        <FolderIcon size={12} />
        <span className="ws-name">{baseName(info.workspace)}</span>
        <ChevronDownIcon size={11} />
      </button>

      {open && (
        <div className="pill-popover ws-popover up" role="menu">
          <div className="ws-current">
            <span className="ws-current-label">当前工作区</span>
            <span className="ws-current-path mono" title={info.workspace}>{info.workspace || '…'}</span>
          </div>

          {others.length > 0 && <div className="ws-group">其它文件夹</div>}
          {others.map((p) => (
            <button key={p} type="button" role="menuitem" onClick={() => void pick(p)} title={p}>
              <FolderIcon size={13} />
              <span className="ws-name">{baseName(p)}</span>
              <span className="ws-sub mono" title={p}>{parentDir(p)}</span>
            </button>
          ))}

          <div className="ws-sep" />
          <button type="button" role="menuitem" onClick={() => void choose()}>
            <FolderPlusIcon size={13} /> 打开文件夹…
          </button>
          <button type="button" role="menuitem" onClick={() => void reveal()}>
            <ExternalLinkIcon size={13} /> 在访达中打开
          </button>
        </div>
      )}
    </div>
  );
}
