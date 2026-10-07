/**
 * useWorkspace.ts —— 工作区的单一数据源（渲染层）
 *
 * 工作区是"主进程持有、渲染层只读"的状态：用户在侧栏或 composer 里切换后，
 * 主进程落盘并广播 workspace:changed，所有订阅者（侧栏 / composer / 会话器）
 * 立刻拿到同一个路径，不会出现"两处显示不一致"。
 *
 * 数据流：
 *   WorkspacePicker --choose/set--> 主进程（校验 + 落盘） --workspace:changed--> useWorkspace
 */

import { useEffect, useState } from 'react';
import { api, type WorkspaceInfo } from './api.js';

/** 取路径最后一段作为展示名（'/' 结尾也能正确取到） */
export function baseName(p: string): string {
  if (!p) return '选择文件夹';
  const trimmed = p.replace(/\/+$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || trimmed || p;
}

/**
 * 取父目录，用于"最近使用"里区分同名文件夹（/a/proj 与 /b/proj）。
 * 不能用 CSS 的 direction:rtl 做左截断——那会把开头的 "/" 甩到结尾，
 * 显示成 "a/proj/"，用户会以为路径写错了。
 */
export function parentDir(p: string): string {
  const trimmed = (p || '').replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return trimmed || p;
  return trimmed.slice(0, idx);
}

export function useWorkspace(): WorkspaceInfo {
  const [info, setInfo] = useState<WorkspaceInfo>({ workspace: '', recent: [] });

  useEffect(() => {
    let alive = true;
    void api.workspaceInfo().then((x) => { if (alive) setInfo(x); }).catch(() => {});
    // 整包接收（含 mtimes），侧栏要靠它按修改时间排序
    const off = api.onWorkspaceChanged((p) => setInfo(p));
    return () => { alive = false; off(); };
  }, []);

  return info;
}
