/**
 * tools/bash-tool.ts —— 终端执行工具
 *
 * 这是能力最强也最危险的工具：模型可以通过它做几乎任何事。
 * 因此三重护栏缺一不可：
 *   1. needsPermission = true —— 每次执行前都让用户过目命令内容；
 *   2. 超时熔断 —— 挂死的命令最多等 timeout_sec 秒，然后杀掉进程；
 *   3. 输出截断 —— 一个 cat 大文件的命令就能产生几 MB 输出，必须截断。
 *
 * 说明：bash 天然能触达文件系统任意角落，无法像文件工具那样做路径围栏，
 * 所以这里的防线是"权限确认"而非"路径校验"——这就是分层防御的现实取舍。
 */

import { spawn } from 'node:child_process';
import { registerTool } from './index.js';
import type { Tool } from './index.js';

/** 返回给模型的最大输出字符数（stdout + stderr 合计） */
const MAX_OUTPUT = 20_000;
/** 超时上限（秒）：模型可以要求更短，但不能更长 */
const MAX_TIMEOUT_SEC = 120;

export function registerBashTool(): void {
  const runBash: Tool = {
    name: 'run_bash',
    description:
      '在工作区目录下执行一条 bash 命令并返回输出（stdout/stderr 合并，超长截断）。' +
      '适合编译、测试、git 操作、文本处理等。每次执行前会征求用户同意。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令（单条，可用 && 串联）' },
        timeout_sec: { type: 'number', description: '超时秒数，默认 30，上限 120' },
      },
      required: ['command'],
    },
    needsPermission: true,
    describe: (args) => String(args.command ?? ''),
    execute: async (args, ctx) => {
      const command = String(args.command ?? '');
      if (!command.trim()) return '错误：command 为空。';

      // 模型经常"好心"想等久一点，这里钳制在上限内
      const requested = Number(args.timeout_sec ?? 30);
      const timeoutSec = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 30, MAX_TIMEOUT_SEC);

      return new Promise<string>((resolve) => {
        // cwd 锁定在工作区：命令默认在项目根目录下执行
        const child = spawn('bash', ['-c', command], {
          cwd: ctx.workspace,
          env: { ...process.env, NANO_HARNESS: '1' }, // 让被调用的程序知道自己在 agent 环境里
        });

        let out = '';
        const collect = (chunk: Buffer) => {
          out += chunk.toString('utf8');
          // 超过上限就提前终止：没必要让进程继续产出用不到的数据
          if (out.length > MAX_OUTPUT * 2) child.kill('SIGKILL');
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        // 超时熔断：到点杀进程，并如实告诉模型"是超时被杀的"
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutSec * 1000);

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve(`错误：无法启动进程：${err.message}`);
        });

        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const truncated =
            out.length > MAX_OUTPUT
              ? out.slice(0, MAX_OUTPUT) + `\n[输出已截断，原文共 ${out.length} 字符]`
              : out;
          if (signal === 'SIGKILL') {
            resolve(truncated + `\n[命令超过 ${timeoutSec}s 超时被终止，退出信号 SIGKILL]`);
          } else {
            // 退出码附在末尾：0 = 成功，非 0 = 失败，模型据此判断命令是否成功
            resolve(truncated + `\n[退出码: ${code}]`);
          }
        });
      });
    },
  };

  registerTool(runBash);
}

