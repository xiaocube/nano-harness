/**
 * PermissionGate.tsx —— 权限确认弹窗（挂在 App 上，而不是聊天页里）
 *
 * 为什么必须在 App 层：权限请求是主进程**一次性推送**的事件，
 * 谁在监听谁才看得到。以前它挂在聊天页里 —— 用户切到"文件/插件市场"，
 * 聊天页卸载、弹窗消失，而 agent loop 还停在 `await confirm(...)`：
 * 任务永久卡住、running 锁死、之后每次发送都被拒绝，只能重启。
 *
 * 现在：
 *   1. 组件挂在 App 上，切页面不会卸载；
 *   2. 挂载时主动拉一次 pendingPermissions()，所以 Cmd+R 重载窗口后
 *      未回答的请求也会重新弹出来；
 *   3. z-index 高于设置弹窗，绝不被盖住（盖住 = 无人回答 = 卡死）。
 */

import { useEffect, useRef, useState } from 'react';
import { api, type PermissionPayload } from '../api.js';
import { ShieldIcon, CheckIcon, XIcon } from './icons.js';

export default function PermissionGate() {
  const [req, setReq] = useState<PermissionPayload | null>(null);
  const allowBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 订阅新请求
    const off = api.onAgentEvent((evt) => {
      if (evt.type === 'permission_request') setReq(evt);
    });
    // 补捞重载/切换前就挂着的那一个
    void api.pendingPermissions()
      .then((list) => { if (list.length > 0) setReq((cur) => cur ?? list[0]); })
      .catch(() => { /* 主进程还没起来也不影响后续事件 */ });
    return off;
  }, []);

  // 弹出来就聚焦"允许"，键盘用户不用摸鼠标（Esc 不关闭：必须明确回答）
  useEffect(() => {
    if (req) allowBtn.current?.focus();
  }, [req]);

  if (!req) return null;

  const answer = (allowed: boolean) => {
    api.replyPermission(req.id, allowed);
    setReq(null);
  };

  return (
    <div className="overlay overlay-permission" role="dialog" aria-modal="true" aria-label="权限确认">
      <div className="sheet">
        <h3><ShieldIcon size={17} /> 权限确认：{req.title}</h3>
        {req.target && <div className="target">目标：{req.target}</div>}
        <div className="detail">{req.detail}</div>
        <div className="actions">
          <button className="btn" onClick={() => answer(false)}>
            <XIcon size={13} /> 拒绝
          </button>
          <button ref={allowBtn} className="btn btn-accent" onClick={() => answer(true)}>
            <CheckIcon size={13} /> 允许
          </button>
        </div>
      </div>
    </div>
  );
}
