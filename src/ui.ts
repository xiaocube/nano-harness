/**
 * ui.ts —— 终端显示层
 *
 * 这是 harness 的"脸面"：所有给用户看的东西都从这里输出。
 * 零依赖设计：不引第三方库（如 chalk/ora），直接用 ANSI 转义码实现颜色和动态效果。
 * ANSI 转义码是终端的"控制指令"，形如 \x1b[31m（31 = 红色），\x1b[0m（重置）。
 */

/** ANSI 颜色码常量表 */
const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/** 终端是否支持颜色：非交互（比如被重定向到文件）或用户显式关闭时，输出纯文本 */
function colorEnabled(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR !== '1';
}

/** 给文本套上 ANSI 颜色；不支持颜色时原样返回 */
function paint(text: string, code: string): string {
  return colorEnabled() ? `${code}${text}${CODES.reset}` : text;
}

/** 以下是一组语义化的输出函数，全项目统一从这里调用 */
export const C = {
  dim: (s: string) => paint(s, CODES.dim),
  bold: (s: string) => paint(s, CODES.bold),
  red: (s: string) => paint(s, CODES.red),
  green: (s: string) => paint(s, CODES.green),
  yellow: (s: string) => paint(s, CODES.yellow),
  cyan: (s: string) => paint(s, CODES.cyan),
  magenta: (s: string) => paint(s, CODES.magenta),
  gray: (s: string) => paint(s, CODES.gray),
};

/**
 * spinner：模型思考时的转圈动画。
 * 原理：每隔 80ms 用 \r（回到行首）+ 清除整行，重画一次同一行。
 * 返回一个 stop() 句柄，调用时停掉定时器并清行，可留下一行最终文字。
 */
export function startSpinner(text: string): { stop: (finalText?: string) => void } {
  // 非交互终端（如管道/CI）转圈没意义，退化为打印一行静态提示
  if (!colorEnabled()) {
    return { stop: (finalText?: string) => { if (finalText) console.log(finalText); } };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`${paint(frames[i++ % frames.length], CODES.cyan)} ${text}`);
  }, 80);
  return {
    stop(finalText?: string) {
      clearInterval(timer);
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      if (finalText) console.log(finalText);
    },
  };
}

/** 启动横幅：告诉用户"我是谁、当前用什么模型、怎么获得帮助" */
export function banner(model: string, workspace: string, yolo: boolean): void {
  console.log('');
  console.log(C.cyan('  ⚡ nano-harness v0.3.0 ') + C.gray('—— 你的第一个 AI Agent Harness'));
  console.log(C.gray('  Agent = Model + Harness，模型是马，harness 是缰绳。'));
  console.log('');
  console.log(`  ${C.gray('模型     ')}${C.bold(model)}`);
  console.log(`  ${C.gray('工作目录 ')}${C.bold(workspace)}`);
  if (yolo) console.log(`  ${C.yellow('⚠ YOLO 模式：所有工具调用自动放行，不再逐条确认')}`);
  console.log('');
  console.log(C.gray('  输入任务直接开聊；/help 查看命令；/exit 退出。'));
  console.log('');
}

/** 打印一次工具调用（给用户看的"过程可视化"）：nh 正在用什么工具、参数是什么 */
export function printToolCall(step: number, maxSteps: number, name: string, argsSummary: string): void {
  console.log('');
  console.log(
    `${C.magenta(`[${step}/${maxSteps}]`)} ${C.cyan('🔧 ' + name)}` +
    C.gray(`(${argsSummary})`)
  );
}

/** 打印工具结果预览（截断到一行，完整结果模型自己能看到） */
export function printToolResult(result: string): void {
  const oneLine = result.replace(/\s+/g, ' ').trim().slice(0, 120);
  console.log(`  ${C.gray('↳ ' + (result.length > 120 ? oneLine + '…' : oneLine))}`);
}

/** 打印 token 用量——让用户直观感受 agent 是"token 消耗机器" */
export function printUsage(tokens: number | undefined, model: string): void {
  if (tokens !== undefined) {
    console.log(C.gray(`  ↳ ${model} · 本次消耗 ${tokens} tokens`));
  }
}

/** 打印最终回答，前面加一条分隔线，视觉上区分"过程"与"结果" */
export function printAnswer(answer: string): void {
  console.log('');
  console.log(C.bold(C.green('▌ 回答')));
  console.log(answer);
  console.log('');
}
