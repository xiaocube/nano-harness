/**
 * PluginsPage.tsx —— 插件市场
 *
 * 两个信息区：
 *   1. 市场索引（marketplace/index.json）：卡片网格，一键安装/卸载
 *   2. 发布指引：上传 = 向主仓库的索引提 PR（开源社区标准流程）
 */

import { useEffect, useState } from 'react';
import { api, type InstalledPlugin, type MarketplaceEntry } from '../api.js';
import { PuzzleIcon, DownloadIcon, CheckIcon, TrashIcon } from './icons.js';

export default function PluginsPage() {
  const [entries, setEntries] = useState<MarketplaceEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => {
    void api.listMarketplace().then((idx) => setEntries(idx.plugins));
    void api.listInstalledPlugins().then(setInstalled);
  };
  useEffect(refresh, []);

  const isInstalled = (name: string) => installed.some((p) => p.manifest.name === name && !p.loadError);

  const install = async (name: string) => {
    setInstalling(name);
    setNotice(null);
    const res = await api.installPlugin(name);
    setInstalling(null);
    setNotice(res.message);
    refresh();
  };

  const uninstall = async (name: string) => {
    const res = await api.uninstallPlugin(name);
    setNotice(res.message);
    refresh();
  };

  return (
    <div className="page">
      <h1 className="page-title">插件市场</h1>
      <p className="page-sub">
        插件 = 工具包。安装后立刻成为 agent 可用的新能力，与内置工具完全同构。
      </p>

      {notice && <div className="msg-notice" style={{ marginBottom: 14, display: 'inline-block' }}>{notice}</div>}

      <div className="plugin-grid">
        {entries.map((entry) => {
          const done = isInstalled(entry.name);
          return (
            <div key={entry.name} className="plugin-card">
              <div className="plugin-card-head">
                <span className="p-icon"><PuzzleIcon size={16} /></span>
                <h3>{entry.title}</h3>
                <span className="ver">v{entry.version}</span>
              </div>
              <p className="desc">{entry.description}</p>
              <div className="meta">
                <span>@{entry.author}</span>
                {entry.keywords?.map((k) => <span key={k} className="kw">{k}</span>)}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                {done ? (
                  <>
                    <span className="badge-installed" style={{ marginRight: 'auto' }}>
                      <CheckIcon size={13} /> 已安装
                    </span>
                    <button className="btn btn-ghost" onClick={() => void uninstall(entry.name)}>
                      <TrashIcon size={13} /> 卸载
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-accent"
                    disabled={installing === entry.name}
                    onClick={() => void install(entry.name)}
                  >
                    <DownloadIcon size={13} /> {installing === entry.name ? '安装中…' : '安装'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {entries.length === 0 && (
          <div style={{ color: 'var(--fg-secondary)', fontSize: 13 }}>
            市场索引为空——检查 marketplace/index.json 是否存在。
          </div>
        )}
      </div>

      <div className="publish-card">
        <strong style={{ color: 'var(--fg)' }}>想发布你自己的插件？</strong>
        <ol>
          <li>
            写一个文件夹：<code>plugin.json</code>（说明书）+ <code>tools.mjs</code>
            （默认导出 <code>{'{ tools: [...] }'}</code>，工具结构与内置工具完全一致，参考仓库里的{' '}
            <code>examples/plugins/devtools</code>）；
          </li>
          <li>发布到任意公开 GitHub 仓库；</li>
          <li>
            向主仓库的 <code>marketplace/index.json</code> 提 PR，加一条你的插件信息；
          </li>
          <li>合并后全世界的 nano-harness 用户都能一键安装你的插件。</li>
        </ol>
      </div>
    </div>
  );
}
