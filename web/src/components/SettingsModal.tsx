/**
 * SettingsModal.tsx —— 设置弹窗（dsh 风格）
 *
 * 分节：通用设置（外观/权限/步数）· 模型（多提供商卡片管理 + 余额）·
 *       Agent 预设（三模式卡片）· 插件（跳转）
 * 多提供商：卡片列表 + 内联编辑表单 + 添加提供商虚线卡；点击"设为当前"切换。
 */

import { useEffect, useState } from 'react';
import { api, type HarnessConfig, type ModelProvider, type AgentPreset } from '../api.js';
import {
  MonitorIcon, SunIcon, MoonIcon, CheckIcon, AlertIcon, XIcon, FileIcon, PuzzleIcon, CpuIcon,
  PlusIcon, SparkIcon, TrashIcon, WalletIcon, PencilIcon,
} from './icons.js';

type Appearance = NonNullable<HarnessConfig['appearance']>;
type Section = 'general' | 'model' | 'presets' | 'plugins';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'general', label: '通用设置', icon: <MonitorIcon size={15} /> },
  { key: 'model', label: '模型', icon: <CpuIcon size={15} /> },
  { key: 'presets', label: 'Agent 预设', icon: <SparkIcon size={15} /> },
  { key: 'plugins', label: '插件', icon: <PuzzleIcon size={15} /> },
];

/** 预设展示数据（与核心 PRESET_DEFS 的文案对齐） */
const PRESET_CARDS: { key: AgentPreset; label: string; badge: string; description: string }[] = [
  { key: 'standard', label: '标准模式', badge: '默认', description: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。' },
  { key: 'minimal', label: '极简模式', badge: '内置', description: '仅使用只读工具快速回答，适合查询、对比和基础测试，更快更省。' },
  { key: 'creative', label: '创造模式', badge: '内置', description: '面向定制 nano-harness：让 Agent 动手编写插件，为 harness 添加新能力和工具。' },
];

export default function SettingsModal({
  onClose, onGoPlugins,
}: {
  onClose: () => void;
  onGoPlugins: () => void;
}) {
  const [section, setSection] = useState<Section>('general');
  const [cfg, setCfg] = useState<HarnessConfig | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  /** 设置都是"改完即生效"，这个标记只用来给用户一个"已保存"的确认 */
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 最大步数的输入草稿：让用户能先把框清空再输入，而不是每敲一下就夹取+落盘 */
  const [stepsDraft, setStepsDraft] = useState<string | null>(null);
  /** 正在编辑的提供商（null=列表态；'new'=新增；其他=id 编辑） */
  const [editing, setEditing] = useState<ModelProvider | 'new' | null>(null);

  useEffect(() => {
    void api.getConfig().then(setCfg).catch((err: Error) => setNotice(`读取配置失败：${err.message}`));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 切分节时清掉上一节的提示，避免"模型的提示出现在预设页"这种串台
  useEffect(() => { setNotice(null); }, [section]);

  if (!cfg) return null;
  const update = (patch: Partial<HarnessConfig>) => setCfg({ ...cfg, ...patch });

  /**
   * 改完即持久化。历史 bug：权限模式/最大步数只改了本地 state，
   * 而"保存"按钮从来没被渲染过——用户以为改了，重启后全部还原。
   */
  const persist = async (patch: Partial<HarnessConfig>) => {
    update(patch);
    await api.setConfig(patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const setAppearance = async (mode: Appearance) => {
    update({ appearance: mode });
    await api.setTheme(mode);          // 立即生效
    await api.setConfig({ appearance: mode }); // 并持久化
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="设置" onClick={onClose}>
      <div className="settings-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>设置</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {saved && <span className="save-hint" role="status"><CheckIcon size={12} /> 已保存</span>}
            <button className="btn" onClick={() => { void api.revealConfigFile().catch((err: Error) => setNotice(`打开配置文件失败：${err.message}`)); }}>
              <FileIcon size={13} /> 打开配置文件
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="关闭设置"><XIcon size={14} /></button>
          </div>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map(({ key, label, icon }) => (
              <button
                key={key}
                className={`nav-item${section === key ? ' active' : ''}`}
                onClick={() => setSection(key)}
              >
                {icon} {label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {section === 'general' && (
              <>
                <div className="srow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
                  <div>
                    <div className="s-label">外观</div>
                    <div className="s-desc">跟随 macOS 系统深浅色，或手动指定</div>
                  </div>
                  <div className="appearance-cards" role="radiogroup" aria-label="外观模式">
                    {([
                      { key: 'light', label: '浅色', icon: <SunIcon size={20} /> },
                      { key: 'dark', label: '深色', icon: <MoonIcon size={20} /> },
                      { key: 'system', label: '跟随系统', icon: <MonitorIcon size={20} /> },
                    ] as const).map(({ key, label, icon }) => (
                      <button
                        key={key}
                        role="radio"
                        aria-checked={(cfg.appearance ?? 'system') === key}
                        className={`appear-card${(cfg.appearance ?? 'system') === key ? ' active' : ''}`}
                        onClick={() => void setAppearance(key)}
                      >
                        {icon} {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="srow">
                  <div>
                    <div className="s-label">权限模式</div>
                    <div className="s-desc">写文件、执行命令前是否需要人工确认</div>
                  </div>
                  <select
                    className="input s-control"
                    value={cfg.yolo ? 'yolo' : 'ask'}
                    onChange={(e) => void persist({ yolo: e.target.value === 'yolo' })}
                    style={{ width: 180 }}
                    aria-label="权限模式"
                  >
                    <option value="ask">每次确认（推荐）</option>
                    <option value="yolo">YOLO 自动放行</option>
                  </select>
                </div>

                <div className="srow">
                  <div>
                    <div className="s-label">最大步数</div>
                    <div className="s-desc">单轮任务最多执行多少步，防止死循环烧 token</div>
                  </div>
                  <input
                    className="input s-control"
                    type="number"
                    min={1}
                    max={100}
                    value={stepsDraft ?? String(cfg.maxSteps)}
                    onChange={(e) => setStepsDraft(e.target.value)}
                    onBlur={() => {
                      const n = Math.min(100, Math.max(1, Number(stepsDraft) || 25));
                      setStepsDraft(null);
                      if (n !== cfg.maxSteps) void persist({ maxSteps: n });
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    style={{ width: 110 }}
                    aria-label="最大步数"
                  />
                </div>
              </>
            )}

            {section === 'model' && (
              <>
                <p className="s-desc" style={{ margin: '10px 0 12px' }}>
                  填入各提供商的 API 密钥即可使用其模型；"当前"提供商是对话实际使用的那个。
                </p>
                {(editing === null) && (cfg.providers ?? []).map((p) => {
                  const isActive = p.id === cfg.activeProviderId;
                  return (
                    <div key={p.id} className={`provider-card${isActive ? ' active' : ''}`}>
                      <div className="p-info">
                        <div className="p-name">
                          {p.name}
                          {isActive && <span className="p-badge">当前</span>}
                        </div>
                        <p className="p-desc mono">{p.model} · {p.baseUrl.replace(/^https?:\/\//, '')}</p>
                      </div>
                      <div className="p-actions">
                        <button
                          className="text-btn"
                          title="查询余额（仅 DeepSeek）"
                          onClick={async () => {
                            const res = await api.queryBalance(p.id);
                            setTestResult((s) => ({ ...s, [p.id]: res }));
                          }}
                        >
                          <WalletIcon size={14} />
                        </button>
                        {!isActive && (
                          <button className="text-btn" onClick={async () => {
                            const res = await api.setActiveProvider(p.id);
                            setNotice(res.message);
                            setCfg(await api.getConfig());
                          }}>设为当前</button>
                        )}
                        <button className="text-btn" title="编辑" onClick={() => setEditing(p)}>
                          <PencilIcon size={14} />
                        </button>
                        {(cfg.providers?.length ?? 0) > 1 && (
                          <button className="text-btn" title="删除" onClick={async () => {
                            const res = await api.deleteProvider(p.id);
                            setNotice(res.message);
                            setCfg(await api.getConfig());
                          }}>
                            <TrashIcon size={14} />
                          </button>
                        )}
                      </div>
                      {testResult[p.id] && (
                        <div className={`status-line ${testResult[p.id].ok ? 'status-ok' : 'status-err'}`} style={{ width: '100%' }}>
                          {testResult[p.id].ok ? <CheckIcon size={13} /> : <AlertIcon size={13} />} {testResult[p.id].message}
                        </div>
                      )}
                    </div>
                  );
                })}

                {editing !== null ? (
                  <ProviderForm
                    initial={editing === 'new'
                      ? { id: `p-${Date.now()}`, name: '', baseUrl: 'https://api.deepseek.com', apiKey: '', model: '' }
                      : editing}
                    onCancel={() => setEditing(null)}
                    onSave={async (p) => {
                      const res = await api.saveProvider(p);
                      setNotice(res.message);
                      setEditing(null);
                      setCfg(await api.getConfig());
                    }}
                    onTest={async (id) => {
                      const res = await api.testConnection(id);
                      setTestResult((s) => ({ ...s, [id]: res }));
                    }}
                  />
                ) : (
                  <button className="dashed-add" onClick={() => setEditing('new')}>
                    <PlusIcon size={14} /> 添加模型提供商
                  </button>
                )}
                {notice && <div className="msg-notice" style={{ marginTop: 10 }}>{notice}</div>}
              </>
            )}

            {section === 'presets' && (
              <>
                <p className="s-desc" style={{ margin: '10px 0 12px' }}>
                  选择 Agent 的工具和工作方式。日常任务用「标准模式」，快速查询用「极简模式」，扩展 nano-harness 用「创造模式」。
                </p>
                <div className="preset-grid">
                  {PRESET_CARDS.map((p) => {
                    const active = (cfg.activePreset ?? 'standard') === p.key;
                    return (
                      <button
                        key={p.key}
                        className={`preset-card${active ? ' active' : ''}`}
                        onClick={async () => {
                          update({ activePreset: p.key });
                          const res = await api.setPreset(p.key);
                          setNotice(res.message);
                          setSaved(true);
                          setTimeout(() => setSaved(false), 1500);
                        }}
                      >
                        <div className="preset-card-head">
                          <strong>{p.label}</strong>
                          <span className="p-badge">{active ? '当前' : p.badge}</span>
                        </div>
                        <p className="p-desc">{p.description}</p>
                      </button>
                    );
                  })}
                </div>
                {notice && <div className="msg-notice" style={{ marginTop: 10 }}>{notice}</div>}
              </>
            )}

            {section === 'plugins' && (
              <div className="srow">
                <div>
                  <div className="s-label">插件管理</div>
                  <div className="s-desc">浏览、安装和启用插件在插件市场页进行</div>
                </div>
                <button
                  className="btn btn-accent s-control"
                  onClick={() => { onClose(); onGoPlugins(); }}
                >
                  <PuzzleIcon size={13} /> 前往插件市场
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 提供商内联编辑表单（新增/编辑共用） */
function ProviderForm({
  initial, onCancel, onSave, onTest,
}: {
  initial: ModelProvider;
  onCancel: () => void;
  onSave: (p: ModelProvider) => void;
  onTest: (id: string) => void;
}) {
  const [p, setP] = useState<ModelProvider>(initial);
  const valid = p.name.trim() && p.baseUrl.trim() && p.model.trim();
  return (
    <div className="provider-form">
      <div className="field"><label>名称</label>
        <input className="input" value={p.name} placeholder="如 DeepSeek / 智谱 GLM / 本地 Ollama" onChange={(e) => setP({ ...p, name: e.target.value })} />
      </div>
      <div className="field"><label>API base_url（OpenAI 兼容）</label>
        <input className="input" value={p.baseUrl} onChange={(e) => setP({ ...p, baseUrl: e.target.value })} />
      </div>
      <div className="field"><label>API Key</label>
        <input className="input" type="password" value={p.apiKey} placeholder="本地模型可留空" onChange={(e) => setP({ ...p, apiKey: e.target.value })} />
      </div>
      <div className="field"><label>模型名</label>
        <input className="input" value={p.model} placeholder="如 deepseek-chat / glm-4-flash / qwen3:8b" onChange={(e) => setP({ ...p, model: e.target.value })} />
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => onTest(p.id)}>测试连接</button>
        <button className="btn" onClick={onCancel}>取消</button>
        <button className="btn btn-accent" disabled={!valid} onClick={() => onSave(p)}>保存并设为当前</button>
      </div>
    </div>
  );
}
