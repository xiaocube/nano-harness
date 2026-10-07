/**
 * useDismiss.ts —— 浮层（下拉/弹窗）统一的关闭逻辑
 *
 * 一个浮层只要开着，就应该满足两条最基本的期望：
 *   1. 点浮层**外面任意处**就关掉（不用回去点原来那个按钮）；
 *   2. 按 Esc 关掉。
 *
 * 之前每个浮层各写一遍，结果预设胶囊漏了——点开"标准模式"后只能再点它自己才关。
 * 现在统一走这里，新增浮层不会再忘。
 *
 * @param active  浮层是否打开（false 时不挂任何监听，零开销）
 * @param ref     浮层**容器**的引用：容器内的点击不算"点外面"。
 *                注意要把触发按钮也包进同一个容器，否则点按钮会被当成点外面。
 * @param onClose 关闭回调
 */

import { useEffect, useRef, type RefObject } from 'react';

export function useDismiss(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  // 用 ref 存回调：调用方通常传内联箭头函数，这样不会每次渲染都重挂监听
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const maybeClose = (e: Event) => {
      const el = ref.current;
      if (!el || !el.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    // mousedown 负责"按下即关"（手感更快），click 兜住键盘/程序触发的点击
    document.addEventListener('mousedown', maybeClose);
    document.addEventListener('click', maybeClose);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', maybeClose);
      document.removeEventListener('click', maybeClose);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, ref]);
}
