/**
 * api.ts —— 渲染层的数据通道
 *
 * 统一封装 window.nanoharness（preload 注入的安全 API）。
 * 浏览器里开发/测试界面时（没有 Electron），自动切换到 MockAPI：
 * 用同样的接口、同样的事件剧本模拟一轮 agent 执行——
 * 这样 UI 开发不依赖真模型，也能测权限弹窗等全部交互。
 */

/* ---------- 与主进程对齐的类型 ---------- */

export interface HarnessConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxSteps: number;
  yolo: boolean;
  contextChars: number;
  appearance?: 'system' | 'light' | 'dark';
}

export interface SessionInfo { file: string; title: string; createdAt: string }

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

/** agent 循环事件（与 src/loop.ts 的 AgentEvent 对齐，外加桌面端权限弹窗事件） */
export type AgentEventPayload =
  | { type: 'thinking_start'; step: number; maxSteps: number }
  | { type: 'thinking_end' }
  | { type: 'usage'; tokens?: number; model: string }
  | { type: 'compacted' }
  | { type: 'tool_call'; step: number; maxSteps: number; name: string; summary: string }
  | { type: 'tool_result'; name: string; preview: string }
  | { type: 'tool_denied'; name: string }
  | { type: 'answer'; answer: string }
  | (PermissionPayload & { type: 'permission_request' });

/** preload 暴露的 API 形状（desktop/preload.ts 的对偶） */
export interface NanoharnessAPI {
  send(task: string): Promise<{ ok: boolean; answer?: string; error?: string }>;
  newChat(): Promise<{ ok: boolean }>;
  currentMessages(): Promise<{ ok: boolean; messages: ChatMessage[] }>;
  replyPermission(id: number, allowed: boolean): void;
  onAgentEvent(callback: (payload: AgentEventPayload) => void): () => void;
  listSessions(): Promise<SessionInfo[]>;
  loadSession(file: string): Promise<{ ok: boolean; messages: ChatMessage[] }>;
  getConfig(): Promise<HarnessConfig>;
  setConfig(partial: Partial<HarnessConfig>): Promise<{ ok: boolean }>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
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
  let replyResolver: ((allowed: boolean) => void) | null = null;
  const emit = (p: AgentEventPayload) => eventListener?.(p);
  /** Mock 会话的内存对话（模拟主进程行为：切页面/换主题不丢历史） */
  let current: ChatMessage[] = [];

  const store = {
    config: {
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-mock', model: 'deepseek-chat',
      maxSteps: 25, yolo: false, contextChars: 48000, appearance: 'system' as const,
    } as HarnessConfig,
    installed: [] as InstalledPlugin[],
    disabledPlugins: {} as Record<string, boolean>,
  };

  return {
    async send(task: string) {
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
        ? `（Mock 演示）我查看了项目结构，并在你允许后写入了 demo.txt。你的任务是：「${task.slice(0, 40)}」`
        : `（Mock 演示）你拒绝了写文件操作，所以我只汇报：项目结构正常。你的任务是：「${task.slice(0, 40)}」`;
      current.push({ role: 'assistant', content: answer });
      emit({ type: 'answer', answer });
      return { ok: true, answer };
    },
    async newChat() { current = []; return { ok: true }; },
    async currentMessages() { return { ok: true, messages: [...current] }; },
    replyPermission(id: number, allowed: boolean) { void id; replyResolver?.(allowed); },
    onAgentEvent(cb) { eventListener = cb; return () => { eventListener = null; }; },
    async listSessions() { return []; },
    async loadSession() { return { ok: true, messages: [] as ChatMessage[] }; },
    async getConfig() { return { ...store.config }; },
    async setConfig(partial) { store.config = { ...store.config, ...partial }; return { ok: true }; },
    async testConnection() { return { ok: true, message: '（Mock）连接成功' }; },
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
    async getAppInfo() { return { workspace: '/Users/demo/project', version: '0.2.0' }; },
  };
}

export const api: NanoharnessAPI = window.nanoharness ?? createMockAPI();
export const isMock = !window.nanoharness;
