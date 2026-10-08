/**
 * api.ts —— 渲染层的数据通道
 *
 * 统一封装 window.nanoharness（preload 注入的安全 API）。
 * 浏览器里开发/测试界面时（没有 Electron），自动切换到 MockAPI：
 * 用同样的接口、同样的事件剧本模拟一轮 agent 执行——
 * 这样 UI 开发不依赖真模型，也能测权限弹窗等全部交互。
 */

/* ---------- 与主进程对齐的类型 ---------- */

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type AgentPreset = 'standard' | 'minimal' | 'creative';

export interface HarnessConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providers?: ModelProvider[];
  activeProviderId?: string;
  activePreset?: AgentPreset;
  maxSteps: number;
  yolo: boolean;
  contextChars: number;
  appearance?: 'system' | 'light' | 'dark';
  /** 当前工作区绝对路径 + 最近使用（桌面端持久化在配置里） */
  workspace?: string;
  recentWorkspaces?: string[];
}

export interface SessionInfo {
  file: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** 会话所属的工作区绝对路径（老会话可能没有 → 侧栏单列"未记录文件夹"） */
  workspace?: string;
}

export interface ChatMessage { role: 'user' | 'assistant' | 'system' | 'tool'; content: string }

export interface ToolInfo { name: string; description: string; needsPermission: boolean }

export interface InstalledPlugin {
  manifest: { name: string; version: string; description: string; author: string };
  dir: string;
  toolNames: string[];
  loadError: string | null;
  enabled: boolean;
}

export interface MarketplaceEntry {
  name: string; title: string; description: string; author: string; version: string;
  keywords?: string[];
  source: { type: 'bundled'; dir: string } | { type: 'github'; repo: string; subdir?: string };
}
export interface MarketplaceIndex { version: number; plugins: MarketplaceEntry[] }

export type PermissionPayload = { id: number; title: string; detail: string; target?: string };

/* ---------- 成果预览（文件浏览） ---------- */

export type FileKind = 'html' | 'markdown' | 'image' | 'text' | 'binary' | 'dir';

export interface FileEntry {
  name: string;
  /** 相对当前工作区的路径 */
  rel: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
  kind: FileKind;
}

export interface FileListing {
  ok: boolean;
  workspace: string;
  rel: string;
  /** 上一级目录（'.' 表示工作区根；null 表示已经在根） */
  parent: string | null;
  entries: FileEntry[];
}

export interface FilePreviewData {
  ok: boolean;
  name: string;
  rel: string;
  absPath: string;
  size: number;
  mtime: number;
  kind: FileKind;
  /** 文本类内容（markdown / 代码 / 纯文本） */
  text?: string | null;
  /** 图片用 data: URL 直接渲染 */
  dataUrl?: string;
  /** HTML 走 nh-file:// 预览协议（不继承本页 CSP，内联脚本能跑） */
  url?: string;
  /** 不能预览时的说明 */
  message?: string;
}

/** 工作区信息：当前路径 + 最近使用 + 各文件夹的修改时间（侧栏按它排序） */
export interface WorkspaceInfo {
  workspace: string;
  recent: string[];
  /** 路径 → 文件夹修改时间（epoch ms）。刚打开还没对话的文件夹靠它参与排序 */
  mtimes?: Record<string, number>;
  fallback?: string;
}

/** agent 循环事件（与 src/loop.ts 的 AgentEvent 对齐，外加桌面端权限弹窗事件） */
export type AgentEventPayload =
  | { type: 'thinking_start'; step: number; maxSteps: number }
  | { type: 'thinking_end' }
  | { type: 'usage'; tokens?: number; model: string }
  | { type: 'compacted' }
  | { type: 'tool_call'; step: number; maxSteps: number; name: string; summary: string; target?: string }
  | { type: 'tool_result'; name: string; preview: string }
  | { type: 'tool_denied'; name: string }
  | { type: 'max_steps'; maxSteps: number }
  | { type: 'continuation'; index: number; max: number }
  | { type: 'answer'; answer: string }
  | (PermissionPayload & { type: 'permission_request' });

/** preload 暴露的 API 形状（desktop/preload.ts 的对偶） */
export interface NanoharnessAPI {
  send(task: string, opts?: { workspace?: string; preset?: AgentPreset }): Promise<{ ok: boolean; answer?: string; error?: string }>;
  newChat(): Promise<{ ok: boolean; error?: string }>;
  currentMessages(): Promise<{ ok: boolean; messages: ChatMessage[] }>;
  replyPermission(id: number, allowed: boolean): void;
  /** 还没被回答的权限请求（界面重新挂载时取回，避免弹窗丢失导致 agent 永久挂起） */
  pendingPermissions(): Promise<PermissionPayload[]>;
  onAgentEvent(callback: (payload: AgentEventPayload) => void): () => void;
  listSessions(archiveFilter?: 'hide' | 'all' | 'only'): Promise<SessionInfo[]>;
  loadSession(file: string): Promise<{ ok: boolean; messages: ChatMessage[] }>;
  archiveSession(file: string, archived: boolean): Promise<{ ok: boolean }>;
  getConfig(): Promise<HarnessConfig>;
  setConfig(partial: Partial<HarnessConfig>): Promise<{ ok: boolean }>;
  testConnection(providerId?: string): Promise<{ ok: boolean; message: string }>;
  revealConfigFile(): Promise<{ ok: boolean }>;
  saveProvider(provider: ModelProvider): Promise<{ ok: boolean; message: string }>;
  deleteProvider(id: string): Promise<{ ok: boolean; message: string }>;
  setActiveProvider(id: string): Promise<{ ok: boolean; message: string }>;
  queryBalance(id: string): Promise<{ ok: boolean; message: string }>;
  setPreset(preset: AgentPreset): Promise<{ ok: boolean; message: string }>;
  /** 当前工作区 + 最近使用 */
  workspaceInfo(): Promise<WorkspaceInfo>;
  /** 打开原生目录选择框（可在其中新建文件夹）；成功后主进程会广播 workspace:changed */
  chooseWorkspace(): Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
  /** 直接切换到某个已存在的文件夹（"最近使用"快捷入口） */
  setWorkspace(path: string): Promise<{ ok: boolean; message: string }>;
  /** 在访达中打开当前工作区 */
  revealWorkspace(): Promise<{ ok: boolean }>;
  /** 工作区变化推送（选择/切换后侧栏与 composer 同步） */
  onWorkspaceChanged(callback: (payload: WorkspaceInfo) => void): () => void;
  /** 列出工作区内的某个目录（成果预览页用） */
  listFiles(rel?: string): Promise<FileListing>;
  /** 读取一个文件交给客户端渲染（HTML/图片转 data: URL，文本返回原文） */
  previewFile(rel: string): Promise<FilePreviewData>;
  /** 在访达中定位文件（越界等失败会带回 message） */
  revealFile(rel: string): Promise<{ ok: boolean; message?: string }>;
  /** 交给系统默认应用打开（HTML = 默认浏览器） */
  openFileExternal(rel: string): Promise<{ ok: boolean; message?: string }>;
  getTheme(): Promise<{ dark: boolean }>;
  setTheme(mode: 'system' | 'light' | 'dark'): Promise<{ dark: boolean }>;
  onThemeChanged(callback: (payload: { dark: boolean }) => void): () => void;
  listTools(): Promise<ToolInfo[]>;
  listInstalledPlugins(): Promise<InstalledPlugin[]>;
  listMarketplace(): Promise<MarketplaceIndex>;
  installPlugin(name: string): Promise<{ ok: boolean; message: string }>;
  uninstallPlugin(name: string): Promise<{ ok: boolean; message: string }>;
  togglePlugin(name: string, enabled: boolean): Promise<{ ok: boolean; message: string }>;
  revealPluginsDir(): Promise<{ ok: boolean }>;
  /** 应用信息：工作区路径等（侧栏展示用） */
  getAppInfo(): Promise<{ workspace: string; version: string }>;
}

declare global {
  interface Window { nanoharness?: NanoharnessAPI }
}

/* ---------- 浏览器开发用 Mock 实现 ---------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 造一个"演出型"模拟 API：同样的事件顺序、可测权限弹窗，纯前端无网络 */
function createMockAPI(): NanoharnessAPI {
  let eventListener: ((p: AgentEventPayload) => void) | null = null;
  let themeListener: ((p: { dark: boolean }) => void) | null = null;
  let workspaceListener: ((p: WorkspaceInfo) => void) | null = null;
  let replyResolver: ((allowed: boolean) => void) | null = null;
  const emit = (p: AgentEventPayload) => eventListener?.(p);
  /** Mock 会话的内存对话（模拟主进程行为：切页面/换主题不丢历史） */
  let current: ChatMessage[] = [];

  const store = {
    config: {
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-mock', model: 'deepseek-chat',
      providers: [{ id: 'default', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-mock', model: 'deepseek-chat' }],
      activeProviderId: 'default',
      activePreset: 'standard' as const,
      maxSteps: 25, yolo: false, contextChars: 48000, appearance: 'system' as const,
    } as HarnessConfig,
    installed: [] as InstalledPlugin[],
    disabledPlugins: {} as Record<string, boolean>,
    current: [] as ChatMessage[],
    sessions: [] as SessionInfo[],
    /** Mock 工作区：模拟"用户选了另一个文件夹"的效果 */
    workspace: '/Users/demo/project',
    recent: ['/Users/demo/project'] as string[],
    /** Mock 的文件夹修改时间（真实模式下由主进程 fs.stat 提供） */
    mtimes: {} as Record<string, number>,
  };

  /** Mock 里"选择文件夹"直接返回一个演示路径（浏览器没有原生选择框） */
  const mockChoose = async () => {
    const path = store.workspace === '/Users/demo/project' ? '/Users/demo/另一个项目' : '/Users/demo/project';
    store.workspace = path;
    store.recent = [path, ...store.recent.filter((p) => p !== path)].slice(0, 8);
    store.mtimes[path] = Date.now();
    workspaceListener?.({ workspace: path, recent: store.recent, mtimes: store.mtimes });
    return { ok: true, path };
  };

  return {
    async send(task: string, opts) {
      void opts; // Mock 不真的跑工具，但接口形状与真实主进程一致
      await sleep(300);
      current.push({ role: 'user', content: task });
      emit({ type: 'thinking_start', step: 1, maxSteps: 25 });
      await sleep(900);
      emit({ type: 'thinking_end' });
      emit({ type: 'usage', tokens: 233, model: store.config.model });
      emit({ type: 'tool_call', step: 1, maxSteps: 25, name: 'list_dir', summary: '.' });
      await sleep(600);
      emit({ type: 'tool_result', name: 'list_dir', preview: 'src/ · web/ · package.json · README.md …' });
      emit({ type: 'usage', tokens: 466, model: store.config.model });
      // 第二步：演示一次写文件权限弹窗（与真实模式同一事件通道）
      emit({ type: 'thinking_start', step: 2, maxSteps: 25 });
      await sleep(700);
      emit({ type: 'thinking_end' });
      emit({ type: 'tool_call', step: 2, maxSteps: 25, name: 'write_file', summary: 'demo.txt（12 字符）' });
      const allowed = await new Promise<boolean>((resolve) => {
        replyResolver = resolve;
        emit({ type: 'permission_request', id: 1, title: '写入文件', detail: 'Hello, nano!', target: 'demo.txt' });
      });
      replyResolver = null;
      if (allowed) {
        emit({ type: 'tool_result', name: 'write_file', preview: '已写入 demo.txt' });
      } else {
        emit({ type: 'tool_denied', name: 'write_file' });
      }
      emit({ type: 'thinking_start', step: 3, maxSteps: 25 });
      await sleep(800);
      emit({ type: 'thinking_end' });
      const answer = allowed
        ? `（Mock 演示）我查看了项目结构，并在你允许后写入了 **demo.txt**。你的任务是：「${task.slice(0, 40)}」\n\n- 读写文件：已验证 \n- 执行命令：正常 \n\n\`nano-harness\` 的 **Markdown 渲染** working ✅`
        : `（Mock 演示）你拒绝了写文件操作，所以我只汇报：项目结构正常。你的任务是：「${task.slice(0, 40)}」`;
      current.push({ role: 'assistant', content: answer });
      emit({ type: 'answer', answer });
      // 让侧栏在 Mock 模式下也有会话可看（演示 updatedAt/归档）
      const now = new Date().toISOString();
      if (store.sessions[0]) store.sessions[0].updatedAt = now;
      else store.sessions.unshift({ file: 'mock-session.json', title: task.slice(0, 30), createdAt: now, updatedAt: now, archived: false, workspace: store.workspace });
      return { ok: true, answer };
    },
    async newChat() { current = []; return { ok: true }; },
    async currentMessages() { return { ok: true, messages: [...current] }; },
    replyPermission(id: number, allowed: boolean) { void id; replyResolver?.(allowed); },
    async pendingPermissions() { return []; },
    onAgentEvent(cb) { eventListener = cb; return () => { eventListener = null; }; },
    async listSessions(archiveFilter) {
      void archiveFilter;
      return [...store.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async loadSession() { return { ok: true, messages: [] as ChatMessage[] }; },
    async archiveSession(file, archived) {
      const s = store.sessions.find((x) => x.file === file);
      if (s) s.archived = archived;
      return { ok: true };
    },
    async getConfig() { return { ...store.config }; },
    async setConfig(partial) { store.config = { ...store.config, ...partial }; return { ok: true }; },
    async testConnection(providerId) {
      void providerId;
      return { ok: true, message: '（Mock）连接成功' };
    },
    async revealConfigFile() { return { ok: true }; },
    async saveProvider(provider) {
      const list = store.config.providers ?? [];
      const idx = list.findIndex((p) => p.id === provider.id);
      if (idx >= 0) list[idx] = provider; else list.push(provider);
      store.config = { ...store.config, providers: list, activeProviderId: provider.id };
      return { ok: true, message: `已保存「${provider.name}」（Mock）` };
    },
    async deleteProvider(id) {
      store.config = { ...store.config, providers: (store.config.providers ?? []).filter((p) => p.id !== id) };
      return { ok: true, message: '已删除（Mock）' };
    },
    async setActiveProvider(id) {
      store.config = { ...store.config, activeProviderId: id };
      return { ok: true, message: '已切换（Mock）' };
    },
    async queryBalance() { return { ok: true, message: '余额 ¥86.40 CNY（Mock）' }; },
    async setPreset(preset) { store.config = { ...store.config, activePreset: preset }; return { ok: true, message: '预设已切换（Mock）' }; },
    async chooseWorkspace() { return mockChoose(); },
    async workspaceInfo() { return { workspace: store.workspace, recent: store.recent, mtimes: store.mtimes, fallback: store.workspace }; },
    async setWorkspace(path) {
      store.workspace = path;
      store.recent = [path, ...store.recent.filter((p) => p !== path)].slice(0, 8);
      store.mtimes[path] = Date.now();
      workspaceListener?.({ workspace: path, recent: store.recent, mtimes: store.mtimes });
      return { ok: true, message: `工作区已切换到 ${path}` };
    },
    async revealWorkspace() { return { ok: true }; },
    /** Mock 文件树：浏览器里也能开发/演示成果预览页 */
    async listFiles() {
      const now = Date.now();
      return {
        ok: true, workspace: store.workspace, rel: '.', parent: null,
        entries: [
          { name: '贪吃蛇.html', rel: '贪吃蛇.html', type: 'file', size: 5894, mtime: now, kind: 'html' },
          { name: 'README.md', rel: 'README.md', type: 'file', size: 1024, mtime: now, kind: 'markdown' },
          { name: 'src', rel: 'src', type: 'dir', size: 0, mtime: now, kind: 'dir' },
        ] as FileEntry[],
      };
    },
    async previewFile(rel) {
      const name = rel.split('/').pop() ?? rel;
      const base = { ok: true, name, rel, absPath: `${store.workspace}/${rel}`, size: 0, mtime: Date.now() };
      if (rel.endsWith('.html')) {
        // 浏览器 Mock 模式没有 nh-file 协议，用 data: 顶一下（真实模式走自定义协议）
        const html = '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:24px"><h1>（Mock）预览</h1><p>真实模式会在这里渲染你的 HTML 文件。</p></body>';
        return { ...base, kind: 'html' as const, url: `data:text/html;charset=utf-8;base64,${btoa(unescape(encodeURIComponent(html)))}` };
      }
      if (rel.endsWith('.md')) return { ...base, kind: 'markdown' as const, text: '# （Mock）README\n\n这里是 Markdown 预览。' };
      return { ...base, kind: 'text' as const, text: '（Mock）文本预览' };
    },
    async revealFile() { return { ok: true }; },
    async openFileExternal() { return { ok: true }; },
    onWorkspaceChanged(cb) { workspaceListener = cb; return () => { workspaceListener = null; }; },
    async getTheme() { return { dark: window.matchMedia('(prefers-color-scheme: dark)').matches }; },
    async setTheme(mode) {
      const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      themeListener?.({ dark }); // 与真实模式对齐：主题变化立即广播给 App
      return { dark };
    },
    onThemeChanged(cb) {
      themeListener = cb;
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => cb({ dark: mq.matches });
      mq.addEventListener('change', handler);
      return () => { mq.removeEventListener('change', handler); themeListener = null; };
    },
    async listTools() {
      return [
        { name: 'read_file', description: '读取工作区内一个文本文件的内容', needsPermission: false },
        { name: 'write_file', description: '把内容写入工作区内的文件（覆盖）', needsPermission: true },
        { name: 'edit_file', description: '精确替换文件中的一段文本', needsPermission: true },
        { name: 'list_dir', description: '列出工作区内某个目录的内容', needsPermission: false },
        { name: 'run_bash', description: '执行一条 bash 命令并返回输出', needsPermission: true },
      ];
    },
    async listInstalledPlugins() {
      return store.installed.map((p) => ({ ...p, enabled: store.disabledPlugins[p.manifest.name] !== true }));
    },
    async listMarketplace() {
      return {
        version: 1,
        plugins: [{
          name: 'devtools', title: '开发工具集',
          description: '查看当前时间、统计文本字数、查看系统信息。也是插件开发的参考示例。',
          author: 'xiaocube', version: '0.1.0', keywords: ['demo', '开发'],
          source: { type: 'bundled', dir: 'examples/plugins/devtools' },
        }],
      };
    },
    async installPlugin(name: string) {
      await sleep(800);
      store.installed.push({
        manifest: { name, version: '0.1.0', description: '演示插件', author: 'xiaocube' },
        dir: `~/.nano-harness/plugins/${name}`, toolNames: ['get_time'], loadError: null, enabled: true,
      });
      return { ok: true, message: `已安装 ${name}（Mock）` };
    },
    async uninstallPlugin(name: string) {
      store.installed = store.installed.filter((p) => p.manifest.name !== name);
      return { ok: true, message: `已卸载 ${name}（Mock）` };
    },
    async togglePlugin(name: string, enabled: boolean) {
      store.disabledPlugins[name] = !enabled;
      return { ok: true, message: `${enabled ? '已启用' : '已禁用'} ${name}（Mock）` };
    },
    async revealPluginsDir() { return { ok: true }; },
    async getAppInfo() { return { workspace: store.workspace, version: '0.5.0' }; },
  };
}

export const api: NanoharnessAPI = window.nanoharness ?? createMockAPI();
export const isMock = !window.nanoharness;
