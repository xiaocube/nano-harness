/**
 * scripts/mock-server.mjs —— 本地 mock 模型服务器
 *
 * 目的：不需要真实 API Key，就能端到端验证 nano-harness 的 Agent Loop。
 * 它模拟一个 OpenAI 兼容的 /chat/completions 端点，按固定剧本演出：
 *
 *   第 1 轮（历史里没有工具结果）→ 返回 tool_calls：让 agent 执行
 *        run_bash: echo nano-harness-mock-ok
 *   第 2 轮（历史里出现了工具结果）→ 返回最终文字，把工具输出复述出来
 *
 * 启动：npm run mock   （监听 127.0.0.1:8787，可用 MOCK_PORT 改端口）
 * 配合：nh "测试" --base-url http://127.0.0.1:8787/v1 --api-key mock --model mock-model --yolo
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8787);

/** 收到一次补全请求时，向终端打印 harness 发来的内容摘要（教学：看清协议长什么样） */
function logRequest(body) {
  console.log('──────── 收到请求 ────────');
  console.log(`model: ${body.model}, messages: ${body.messages.length} 条`);
  for (const m of body.messages) {
    const brief = typeof m.content === 'string' ? m.content.slice(0, 60).replace(/\n/g, ' ') : '(工具调用)';
    console.log(`  [${m.role}] ${brief}${brief.length >= 60 ? '…' : ''}`);
  }
}

const server = createServer(async (req, res) => {
  // 健康检查：nh 可以用它判断端点是否活着（未来版本的向导会用到）
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mock: true }));
    return;
  }

  // 只实现一个接口：chat/completions（结尾匹配，兼容 /v1/chat/completions）
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock 只支持 POST /v1/chat/completions' } }));
    return;
  }

  // 读取请求体
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400).end('bad json');
    return;
  }
  logRequest(body);

  // 剧本分支：历史里是否已经有"工具结果"消息
  const hasToolResult = body.messages.some((m) => m.role === 'tool');
  let message;
  if (!hasToolResult) {
    // 第 1 轮：模型"要求"执行一条 echo 命令
    message = {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'mock-call-1',
          type: 'function',
          function: {
            name: 'run_bash',
            arguments: JSON.stringify({ command: 'echo nano-harness-mock-ok && pwd' }),
          },
        },
      ],
    };
  } else {
    // 第 2 轮：看到工具结果，给出最终回答（复述输出，冒烟测试据此断言）
    const toolMsg = body.messages.find((m) => m.role === 'tool');
    message = {
      role: 'assistant',
      content:
        `任务完成！我调用了工具并拿到了输出：\n\n  ${String(toolMsg?.content ?? '').trim().slice(0, 200)}\n\n` +
        '如果你能在上面看到 nano-harness-mock-ok，说明 Agent Loop 的完整链路（模型→工具→结果→回答）已经跑通 ✅',
    };
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 24, total_tokens: 66 },
    }),
  );
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🤖 mock 模型服务器已启动: http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log('   另开终端运行:');
  console.log(`   nh "测试" --base-url http://127.0.0.1:${PORT}/v1 --api-key mock --model mock-model --yolo`);
});
