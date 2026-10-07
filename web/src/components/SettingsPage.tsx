/**
 * SettingsPage.tsx —— 设置页
 *
 * 模型接入（OpenAI 兼容三件套）+ 外观三态（跟随系统/浅色/深色）+ 连接测试。
 * 保存调用 config:set 落盘；外观切换立即生效（nativeTheme）并持久化。
 */

import { useEffect, useState } from 'react';
import { api, type HarnessConfig } from '../api.js';
import { MonitorIcon, SunIcon, MoonIcon, CheckIcon, AlertIcon } from './icons.js';

type Appearance = NonNullable<HarnessConfig['appearance']>;

export default function SettingsPage() {
  const [cfg, setCfg] = useState<HarnessConfig | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.getConfig().then(setCfg);
  }, []);

  if (!cfg) return <div className="page">加载中…</div>;

  const update = (patch: Partial<HarnessConfig>) => setCfg({ ...cfg, ...patch });

  const save = async () => {
    await api.setConfig(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const setAppearance = async (mode: Appearance) => {
    update({ appearance: mode });
    await api.setTheme(mode); // 立即生效
    await api.setConfig({ appearance: mode }); // 并持久化
  };

  const test = async () => {
    setTestResult(null);
    await api.setConfig(cfg); // 先保存再测，避免测的是旧配置
    const res = await api.testConnection();
    setTestResult(res);
  };

  return (
    <div className="page">
      <h1 className="page-title">设置</h1>
      <p className="page-sub">配置存在 ~/.nano-harness/config.json，CLI 与桌面版共用。</p>

      <div className="settings">
        <div className="field">
          <label>外观</label>
          <div className="segmented" role="radiogroup" aria-label="外观模式">
            {([
              { key: 'system', label: '跟随系统', icon: <MonitorIcon size={13} /> },
              { key: 'light', label: '浅色', icon: <SunIcon size={13} /> },
              { key: 'dark', label: '深色', icon: <MoonIcon size={13} /> },
            ] as const).map(({ key, label, icon }) => (
              <button
                key={key}
                role="radio"
                aria-checked={(cfg.appearance ?? 'system') === key}
                className={`segment${(cfg.appearance ?? 'system') === key ? ' active' : ''}`}
                onClick={() => void setAppearance(key)}
              >
                {icon} {label}
              </button>
            ))}
          </div>
          <span className="hint">跟随 macOS 系统深浅色，切换实时生效</span>
        </div>

        <div className="field">
          <label>API base_url（OpenAI 兼容）</label>
          <input className="input" value={cfg.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} />
        </div>

        <div className="field">
          <label>API Key</label>
          <input className="input" type="password" value={cfg.apiKey} onChange={(e) => update({ apiKey: e.target.value })} />
          <span className="hint">Ollama 等本地模型可留空</span>
        </div>

        <div className="field">
          <label>模型名</label>
          <input className="input" value={cfg.model} onChange={(e) => update({ model: e.target.value })} />
          <span className="hint">如 deepseek-chat / glm-4-flash / qwen3:8b</span>
        </div>

        <div className="field">
          <label>最大步数（熔断）</label>
          <input
            className="input"
            type="number"
            min={1}
            max={100}
            value={cfg.maxSteps}
            onChange={(e) => update({ maxSteps: Number(e.target.value) || 25 })}
          />
        </div>

        <div className="row">
          <div>
            <label style={{ fontWeight: 600, fontSize: 12.5 }}>YOLO 模式</label>
            <div className="hint" style={{ color: 'var(--fg-secondary)', fontSize: 11.5 }}>
              跳过所有权限确认（仅建议在沙箱环境中开启）
            </div>
          </div>
          <button
            className={`segment${cfg.yolo ? ' active' : ''}`}
            role="switch"
            aria-checked={cfg.yolo}
            onClick={() => update({ yolo: !cfg.yolo })}
            style={cfg.yolo ? { background: 'var(--danger)', color: 'var(--on-danger)' } : undefined}
          >
            {cfg.yolo ? '已开启' : '已关闭'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
          <button className="btn btn-accent" onClick={() => void save()}>
            {saved ? <><CheckIcon size={13} /> 已保存</> : '保存设置'}
          </button>
          <button className="btn" onClick={() => void test()}>测试连接</button>
          {testResult && (
            <span className={`status-line ${testResult.ok ? 'status-ok' : 'status-err'}`}>
              {testResult.ok ? <CheckIcon size={13} /> : <AlertIcon size={13} />} {testResult.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
