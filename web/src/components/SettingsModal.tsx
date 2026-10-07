/**
 * SettingsModal.tsx —— 设置弹窗（dsh 风格）
 *
 * 布局：居中大弹窗 = 头部（标题 + 打开配置文件 + 关闭）
 *       + 左侧分节导航（通用设置 / 模型 / 插件）+ 右侧内容区
 * 内容区行式布局：左"标签+说明"、右控件。
 * 外观用三张大卡片（浅色/深色/跟随系统），选中态蓝色描边。
 * Esc / 点遮罩 / X 均可关闭。
 */

import { useEffect, useState } from 'react';
import { api, type HarnessConfig } from '../api.js';
import {
  MonitorIcon, SunIcon, MoonIcon, CheckIcon, AlertIcon, XIcon, FileIcon, PuzzleIcon, CpuIcon,
} from './icons.js';

type Appearance = NonNullable<HarnessConfig['appearance']>;
type Section = 'general' | 'model' | 'plugins';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'general', label: '通用设置', icon: <MonitorIcon size={15} /> },
  { key: 'model', label: '模型', icon: <CpuIcon size={15} /> },
  { key: 'plugins', label: '插件', icon: <PuzzleIcon size={15} /> },
];

export default function SettingsModal({
  onClose, onGoPlugins,
}: {
  onClose: () => void;
  onGoPlugins: () => void;
}) {
  const [section, setSection] = useState<Section>('general');
  const [cfg, setCfg] = useState<HarnessConfig | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.getConfig().then(setCfg);
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!cfg) return null;
  const update = (patch: Partial<HarnessConfig>) => setCfg({ ...cfg, ...patch });

  const save = async () => {
    await api.setConfig(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const setAppearance = async (mode: Appearance) => {
    update({ appearance: mode });
    await api.setTheme(mode);          // 立即生效
    await api.setConfig({ appearance: mode }); // 并持久化
  };

  const test = async () => {
    setTestResult(null);
    await api.setConfig(cfg); // 先保存再测，避免测的是旧配置
    setTestResult(await api.testConnection());
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="设置" onClick={onClose}>
      <div className="settings-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>设置</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn" onClick={() => void api.revealConfigFile()}>
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
                    onChange={(e) => update({ yolo: e.target.value === 'yolo' })}
                    style={{ width: 180 }}
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
                    value={cfg.maxSteps}
                    onChange={(e) => update({ maxSteps: Number(e.target.value) || 25 })}
                    style={{ width: 110 }}
                  />
                </div>
              </>
            )}

            {section === 'model' && (
              <>
                <div className="srow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <div className="s-label">API base_url（OpenAI 兼容）</div>
                  <input className="input" value={cfg.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} />
                </div>
                <div className="srow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <div className="s-label">API Key</div>
                  <input className="input" type="password" value={cfg.apiKey} onChange={(e) => update({ apiKey: e.target.value })} />
                  <div className="s-desc">Ollama 等本地模型可留空</div>
                </div>
                <div className="srow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <div className="s-label">模型名</div>
                  <input className="input" value={cfg.model} onChange={(e) => update({ model: e.target.value })} />
                  <div className="s-desc">如 deepseek-chat / glm-4-flash / qwen3:8b</div>
                </div>
                <div className="srow">
                  <div className="s-desc">修改后记得保存，再点测试连接验证</div>
                  <div className="s-control" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {testResult && (
                      <span className={`status-line ${testResult.ok ? 'status-ok' : 'status-err'}`}>
                        {testResult.ok ? <CheckIcon size={13} /> : <AlertIcon size={13} />} {testResult.message}
                      </span>
                    )}
                    <button className="btn" onClick={() => void test()}>测试连接</button>
                    <button className="btn btn-accent" onClick={() => void save()}>
                      {saved ? <><CheckIcon size={13} /> 已保存</> : '保存'}
                    </button>
                  </div>
                </div>
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
