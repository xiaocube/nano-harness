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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type AgentEventPayload, type AgentPreset } from '../api.js';
import { useWorkspace } from '../useWorkspace.js';
import { useDismiss } from '../useDismiss.js';
import WorkspacePicker from './WorkspacePicker.js';
import { SendIcon, ZapIcon, TerminalIcon, CheckIcon, XIcon, ChevronDownIcon, SparkIcon, FileIcon } from './icons.js';

/**
 * 助手消息的 Markdown 渲染：模型输出的是 Markdown（加粗/列表/代码块），
 * 直接当纯文本显示会露出 ** 星号。用户消息保持纯文本原样。
 * 链接一律新开浏览器标签；代码块用等宽字体 + 次级底色。
 */
function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** 预设 pill 的展示文案（与核心 PRESET_DEFS 对齐） */
const PRESET_LABELS: Record<AgentPreset, string> = {
  standard: '标准模式', minimal: '极简模式', creative: '创造模式',
};

/** 消息流里的一条渲染项 */
type ChatItem =
  | { kind: 'user'; key: number; text: string }
  | { kind: 'assistant'; key: number; text: string }
  | { kind: 'tool'; key: number; name: string; summary: string; step: number; status: 'running' | 'done' | 'denied'; preview?: string; target?: string }
  | { kind: 'notice'; key: number; text: string }
  | { kind: 'meta'; key: number; text: string };

const EXAMPLE_TASKS = ['看看这个项目结构', '帮我写一个 hello.py', '解释 package.json 的作用'];

let itemSeq = 1;

export default function ChatPage({ onTurnDone, onPreview }: { onTurnDone: () => void; onPreview?: (rel: string) => void }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [expandedTool, setExpandedTool] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Composer pills：预设 / 当前模型名（工作区由 WorkspacePicker + useWorkspace 统一管理） */
  const [preset, setPreset] = useState<AgentPreset>('standard');
  const [modelName, setModelName] = useState('');
  const [presetMenu, setPresetMenu] = useState(false);
  /** 预设下拉的容器：点外面 / Esc 都能关（之前只能再点一次胶囊才关） */
  const presetMenuRef = useRef<HTMLDivElement>(null);
  useDismiss(presetMenu, presetMenuRef, () => setPresetMenu(false));
  const [notice, setNotice] = useState<string | null>(null);
  /** 本轮任务的工作区绝对路径——来自主进程，send 时原样回传 */
  const ws = useWorkspace();

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
          setItems((xs) => [...xs, { kind: 'tool', key: itemSeq++, name: evt.name, summary: evt.summary, step: evt.step, status: 'running', target: evt.target }]);
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
          setItems((xs) => [...xs, { kind: 'meta', key: itemSeq++, text: `${evt.model} · ${evt.tokens ?? '?'} tokens` }]);
          break;
        case 'compacted':
          setItems((xs) => [...xs, { kind: 'notice', key: itemSeq++, text: '上下文已压缩' }]);
          break;
        case 'answer':
          setItems((xs) => [...xs, { kind: 'assistant', key: itemSeq++, text: evt.answer }]);
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
      const restored = messages
        .map((m): ChatItem | null =>
          m.role === 'user' ? { kind: 'user', key: itemSeq++, text: m.content }
          : m.role === 'assistant' ? { kind: 'assistant', key: itemSeq++, text: m.content }
          : null,
        )
        .filter((x): x is ChatItem => x !== null);
      setItems(restored);
    };
    // 挂载时也恢复一次：切到插件/设置页再回来不丢聊天内容
    void reload();
    window.addEventListener('session-loaded', reload as EventListener);
    return () => window.removeEventListener('session-loaded', reload as EventListener);
  }, []);

  // Composer pills 初始化：预设 / 当前模型名
  useEffect(() => {
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

  // 输入框随内容长高（最多 140px，再多就内部滚动）——多行任务不用挤在 1 行里看
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  const send = async (task: string) => {
    const trimmed = task.trim();
    if (!trimmed || running) return;
    setItems((xs) => [...xs, { kind: 'user', key: itemSeq++, text: trimmed }]);
    setInput('');
    setRunning(true);
    setNotice(null);
    // 把 pills 的选择带给核心：工作区决定文件边界（绝对路径），预设决定人设与工具面。
    // 主进程 handler 有可能 reject（例如启动准备失败），必须兜住，
    // 否则界面会永远停在"任务执行中"，输入框一直禁用。
    try {
      const res = await api.send(trimmed, { workspace: ws.workspace, preset });
      if (!res.ok && res.error) {
        setItems((xs) => [...xs, { kind: 'notice', key: itemSeq++, text: `出错了：${res.error}` }]);
        setRunning(false);
        setThinkingStep(0);
      }
    } catch (err) {
      setItems((xs) => [...xs, { kind: 'notice', key: itemSeq++, text: `发送失败：${(err as Error).message}` }]);
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

      {/* 消息流只在"有内容"时渲染，空状态时整块隐藏（而非渲染空壳） */}
      <div className="chat-running" hidden={!hasChat}>
        <div className="chat-scroll" ref={scrollRef} aria-busy={running}>
          {items.map((item) => {
            switch (item.kind) {
              case 'user':
                return <div key={item.key} className="msg msg-user">{item.text}</div>;
              case 'assistant':
                return <div key={item.key} className="msg msg-assistant"><AssistantMarkdown text={item.text} /></div>;
              case 'notice':
                return <div key={item.key} className="msg-notice">{item.text}</div>;
              case 'meta':
                return <div key={item.key} style={{ alignSelf: 'center', fontSize: 10.5, color: 'var(--fg-secondary)' }}>{item.text}</div>;
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
                      {item.status === 'done' && item.target && (item.name === 'write_file' || item.name === 'edit_file') && (
                        <span
                          className="tool-preview-btn"
                          role="button"
                          tabIndex={0}
                          title={`在客户端里预览 ${item.target}`}
                          onClick={(e) => { e.stopPropagation(); onPreview?.(item.target!); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onPreview?.(item.target!); } }}
                        >
                          <FileIcon size={12} /> 预览
                        </span>
                      )}
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
          <WorkspacePicker onNotice={setNotice} />
          <div className="pill-menu" ref={presetMenuRef}>
            <button className="pill" onClick={() => setPresetMenu((v) => !v)} aria-haspopup="menu" aria-expanded={presetMenu}>
              <SparkIcon size={12} /> {PRESET_LABELS[preset]} <ChevronDownIcon size={11} />
            </button>
            {presetMenu && (
              <div className="pill-popover" role="menu">
                {(Object.keys(PRESET_LABELS) as AgentPreset[]).map((k) => (
                  <button key={k} type="button" role="menuitem" onClick={async () => {
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
          <span className="pill pill-static" style={{ marginLeft: 'auto' }} title="当前模型">{modelName}</span>
        </div>
        <div className="composer-box">
          <textarea
            ref={taRef}
            value={input}
            placeholder={running ? '任务执行中…' : '输入任务，⌘+回车 发送'}
            rows={1}
            disabled={running}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(input);
              if (e.key === 'Escape') setPresetMenu(false);
            }}
            aria-label="任务输入框"
          />
          <button className="send-btn" disabled={running || !input.trim()} onClick={() => void send(input)} aria-label="发送">
            <SendIcon size={15} />
          </button>
        </div>
        <div className={`composer-meta${notice ? ' composer-notice' : ''}`} role={notice ? 'status' : undefined}>
          {notice ?? (running ? 'agent 正在执行，工具调用会先征求你的同意' : '工具调用前会请求权限 · 会话自动保存')}
        </div>
      </div>

    </>
  );
}
