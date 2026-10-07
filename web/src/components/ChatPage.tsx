/**
 * ChatPage.tsx —— 聊天页
 *
 * 首屏极简：居中 logo + 单输入框 + 3 个示例任务 chip（空状态引导规则）。
 * 发送后切换为"消息流 + 贴底输入框"的经典 agent 界面。
 *
 * 消息流完全由核心事件驱动（onAgentEvent）：工具调用卡片、步数、
 * token 用量、权限弹窗——UI 只是事件的可视化，不含任何业务逻辑。
 */

import { useEffect, useRef, useState } from 'react';
import { api, type AgentEventPayload, type PermissionPayload, type AgentPreset } from '../api.js';
import { SendIcon, ZapIcon, TerminalIcon, ShieldIcon, CheckIcon, XIcon, ChevronDownIcon, FolderIcon, SparkIcon } from './icons.js';

/** 预设 pill 的展示文案（与核心 PRESET_DEFS 对齐） */
const PRESET_LABELS: Record<AgentPreset, string> = {
  standard: '标准模式', minimal: '极简模式', creative: '创造模式',
};

/** 消息流里的一条渲染项 */
type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; key: number; name: string; summary: string; step: number; status: 'running' | 'done' | 'denied'; preview?: string }
  | { kind: 'notice'; text: string }
  | { kind: 'meta'; text: string };

const EXAMPLE_TASKS = ['看看这个项目结构', '帮我写一个 hello.py', '解释 package.json 的作用'];

let itemSeq = 1;

export default function ChatPage({ onTurnDone }: { onTurnDone: () => void }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [permission, setPermission] = useState<PermissionPayload | null>(null);
  const [expandedTool, setExpandedTool] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Composer pills：工作区 / 预设 / 当前模型名 */
  const [workspace, setWorkspace] = useState('…');
  const [preset, setPreset] = useState<AgentPreset>('standard');
  const [modelName, setModelName] = useState('');
  const [presetMenu, setPresetMenu] = useState(false);

  // 订阅核心事件 → 更新消息流
  useEffect(() => {
    const off = api.onAgentEvent((evt: AgentEventPayload) => {
      switch (evt.type) {
        case 'thinking_start':
          setRunning(true);
          setThinkingStep(evt.step);
          break;
        case 'thinking_end':
          setThinkingStep(0);
          break;
        case 'tool_call':
          setItems((xs) => [...xs, { kind: 'tool', key: itemSeq++, name: evt.name, summary: evt.summary, step: evt.step, status: 'running' }]);
          break;
        case 'tool_result':
          setItems((xs) => {
            const idx = [...xs].reverse().findIndex((x) => x.kind === 'tool' && x.status === 'running');
            if (idx === -1) return xs;
            const realIdx = xs.length - 1 - idx;
            const next = [...xs];
            next[realIdx] = { ...(xs[realIdx] as Extract<ChatItem, { kind: 'tool' }>), status: 'done', preview: evt.preview };
            return next;
          });
          break;
        case 'tool_denied':
          setItems((xs) => {
            const idx = [...xs].reverse().findIndex((x) => x.kind === 'tool' && x.status === 'running');
            if (idx === -1) return xs;
            const realIdx = xs.length - 1 - idx;
            const next = [...xs];
            next[realIdx] = { ...(xs[realIdx] as Extract<ChatItem, { kind: 'tool' }>), status: 'denied' };
            return next;
          });
          break;
        case 'usage':
          setItems((xs) => [...xs, { kind: 'meta', text: `${evt.model} · ${evt.tokens ?? '?'} tokens` }]);
          break;
        case 'compacted':
          setItems((xs) => [...xs, { kind: 'notice', text: '上下文已压缩' }]);
          break;
        case 'permission_request':
          setPermission({ id: evt.id, title: evt.title, detail: evt.detail, target: evt.target });
          break;
        case 'answer':
          setItems((xs) => [...xs, { kind: 'assistant', text: evt.answer }]);
          setRunning(false);
          setThinkingStep(0);
          onTurnDone();
          break;
      }
    });
    return off;
  }, [onTurnDone]);

  // 会话被侧栏加载/清空后重建视图（数据来自主进程内存中的当前对话）
  useEffect(() => {
    const reload = async () => {
      const { messages } = await api.currentMessages();
      setItems(messages.map((m) =>
        m.role === 'user' ? { kind: 'user' as const, text: m.content }
        : m.role === 'assistant' ? { kind: 'assistant' as const, text: m.content }
        : null,
      ).filter((x): x is ChatItem => x !== null));
    };
    // 挂载时也恢复一次：切到插件/设置页再回来不丢聊天内容
    void reload();
    window.addEventListener('session-loaded', reload as EventListener);
    return () => window.removeEventListener('session-loaded', reload as EventListener);
  }, []);

  // Composer pills 初始化：工作区 / 预设 / 当前模型名
  useEffect(() => {
    void api.getAppInfo().then((info) => {
      const parts = info.workspace.split('/');
      setWorkspace(parts[parts.length - 1] || info.workspace);
    }).catch(() => setWorkspace('工作区'));
    void api.getConfig().then((cfg) => {
      setPreset(cfg.activePreset ?? 'standard');
      const p = (cfg.providers ?? []).find((x) => x.id === cfg.activeProviderId) ?? cfg.providers?.[0];
      setModelName(p?.model ?? cfg.model);
    }).catch(() => {});
  }, []);

  // 消息流自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, thinkingStep]);

  const send = async (task: string) => {
    const trimmed = task.trim();
    if (!trimmed || running) return;
    setItems((xs) => [...xs, { kind: 'user', text: trimmed }]);
    setInput('');
    setRunning(true);
    // 把 pills 的选择带给核心：工作区决定文件边界，预设决定人设与工具面
    const res = await api.send(trimmed, { workspace, preset });
    if (!res.ok && res.error) {
      setItems((xs) => [...xs, { kind: 'notice', text: `出错了：${res.error}` }]);
      setRunning(false);
      setThinkingStep(0);
    }
  };

  const isEmpty = items.length === 0;
  const hasChat = !isEmpty || running;

  return (
    <>
      {isEmpty && !running && (
        <div className="chat-empty">
          <div className="logo"><ZapIcon size={28} /></div>
          <h1>有什么可以帮你？</h1>
          <p className="sub">nano-harness 可以读写文件、执行命令——模型在本机运行，数据不出你的电脑。</p>
        </div>
      )}

      <div className={hasChat ? 'chat-running' : 'chat-running'} style={hasChat ? undefined : { display: 'none' }}>
        <div className="chat-scroll" ref={scrollRef} aria-busy={running}>
          {items.map((item, i) => {
            switch (item.kind) {
              case 'user':
                return <div key={i} className="msg msg-user">{item.text}</div>;
              case 'assistant':
                return <div key={i} className="msg msg-assistant">{item.text}</div>;
              case 'notice':
                return <div key={i} className="msg-notice">{item.text}</div>;
              case 'meta':
                return <div key={i} style={{ alignSelf: 'center', fontSize: 10.5, color: 'var(--fg-secondary)' }}>{item.text}</div>;
              case 'tool': {
                const expanded = expandedTool === item.key;
                return (
                  <div key={item.key} className="tool-card">
                    <div
                      className="tool-card-head"
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedTool(expanded ? null : item.key)}
                      onKeyDown={(e) => e.key === 'Enter' && setExpandedTool(expanded ? null : item.key)}
                    >
                      <TerminalIcon size={13} />
                      <span>{item.name}</span>
                      <span style={{ color: 'var(--fg-secondary)' }}>{item.summary}</span>
                      <span className="step-badge">第 {item.step} 步</span>
                      <span className={`tool-status status-${item.status}`}>
                        {item.status === 'running' && <span className="spinner" style={{ width: 10, height: 10 }} />}
                        {item.status === 'done' && <><CheckIcon size={12} /> 完成</>}
                        {item.status === 'denied' && <><XIcon size={12} /> 已拒绝</>}
                      </span>
                      <ChevronDownIcon size={12} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform var(--t-fast)' }} />
                    </div>
                    {expanded && item.preview && <div className="tool-card-body">{item.preview}</div>}
                  </div>
                );
              }
            }
          })}
          {thinkingStep > 0 && (
            <div className="thinking" role="status">
              <span className="spinner" /> 正在思考（第 {thinkingStep} 步）…
            </div>
          )}
        </div>
      </div>

      <div className="composer">
        {!hasChat && (
          <div className="chips" style={{ marginBottom: 14 }}>
            {EXAMPLE_TASKS.map((t) => (
              <button key={t} className="chip" onClick={() => void send(t)}>{t}</button>
            ))}
          </div>
        )}
        <div className="composer-pills">
          <button
            className="pill"
            title="选择本轮任务的工作区目录"
            onClick={async () => {
              const res = await api.chooseWorkspace();
              if (res.ok && res.path) {
                const parts = res.path.split('/');
                setWorkspace(parts[parts.length - 1] || res.path);
              }
            }}
          >
            <FolderIcon size={12} /> {workspace} <ChevronDownIcon size={11} />
          </button>
          <div className="pill-menu">
            <button className="pill" onClick={() => setPresetMenu((v) => !v)}>
              <SparkIcon size={12} /> {PRESET_LABELS[preset]} <ChevronDownIcon size={11} />
            </button>
            {presetMenu && (
              <div className="pill-popover">
                {(Object.keys(PRESET_LABELS) as AgentPreset[]).map((k) => (
                  <button key={k} onClick={async () => {
                    setPreset(k);
                    setPresetMenu(false);
                    await api.setPreset(k); // 持久化，新对话默认沿用
                  }}>
                    {PRESET_LABELS[k]}
                    {preset === k && <span className="check"><CheckIcon size={13} /></span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="pill pill-static" style={{ marginLeft: 'auto' }}>{modelName}</span>
        </div>
        <div className="composer-box">
          <textarea
            value={input}
            placeholder={running ? '任务执行中…' : '输入任务，⌘+回车 发送'}
            rows={1}
            disabled={running}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(input);
            }}
            aria-label="任务输入框"
          />
          <button className="send-btn" disabled={running || !input.trim()} onClick={() => void send(input)} aria-label="发送">
            <SendIcon size={15} />
          </button>
        </div>
        <div className="composer-meta">
          {running ? 'agent 正在执行，工具调用会先征求你的同意' : '工具调用前会请求权限 · 会话自动保存'}
        </div>
      </div>

      {permission && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="权限确认">
          <div className="sheet">
            <h3><ShieldIcon size={17} /> 权限确认：{permission.title}</h3>
            {permission.target && <div className="target">目标：{permission.target}</div>}
            <div className="detail">{permission.detail}</div>
            <div className="actions">
              <button
                className="btn"
                onClick={() => { api.replyPermission(permission.id, false); setPermission(null); }}
              >
                <XIcon size={13} /> 拒绝
              </button>
              <button
                className="btn btn-accent"
                onClick={() => { api.replyPermission(permission.id, true); setPermission(null); }}
              >
                <CheckIcon size={13} /> 允许
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
