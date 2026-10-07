/**
 * devtools 插件 —— nano-harness 插件开发示例
 *
 * 插件开发只需记住一件事：默认导出一个 tools 数组，每个元素和内置工具
 * （src/tools/index.ts 的 Tool 接口）完全同构：
 *   name / description / parameters(JSON Schema) / needsPermission / describe / execute
 *
 * 文件用 .mjs 后缀（ESM），无需构建、无需依赖，改完重启 harness 即生效。
 */

/** 获取当前时间 */
const getTime = {
  name: 'get_time',
  description: '获取当前日期时间（本地时区，ISO 格式与人类可读格式各一份）。',
  parameters: { type: 'object', properties: {}, required: [] },
  needsPermission: false,
  describe: () => '当前时间',
  execute: async () => {
    const now = new Date();
    return `ISO: ${now.toISOString()}\n本地: ${now.toLocaleString('zh-CN')}`;
  },
};

/** 统计文本字数 */
const wordCount = {
  name: 'word_count',
  description: '统计一段文本的字符数、词数与行数。分析文本长度时使用。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要统计的文本内容' },
    },
    required: ['text'],
  },
  needsPermission: false,
  describe: (args) => `${String(args.text ?? '').length} 字符`,
  execute: async (args) => {
    const text = String(args.text ?? '');
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lines = text ? text.split('\n').length : 0;
    return `字符数: ${text.length}\n词数: ${words}\n行数: ${lines}`;
  },
};

/** 查看系统信息 */
const systemInfo = {
  name: 'system_info',
  description: '查看操作系统、CPU 架构、内存总量等系统基本信息。',
  parameters: { type: 'object', properties: {}, required: [] },
  needsPermission: false,
  describe: () => '系统信息',
  execute: async () => {
    const os = await import('node:os');
    return [
      `系统: ${os.type()} ${os.release()}`,
      `平台: ${os.platform()} (${os.arch()})`,
      `CPU: ${os.cpus()[0]?.model ?? '未知'} × ${os.cpus().length}`,
      `内存: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB`,
      `Node: ${process.version}`,
    ].join('\n');
  },
};

// ★ 插件的唯一约定：默认导出 tools 数组
export default { tools: [getTime, wordCount, systemInfo] };
