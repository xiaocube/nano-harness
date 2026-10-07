/**
 * tests/helpers/mock-model.mjs —— 剧本化的"假模型服务器"
 *
 * 起一个真的 HTTP 服务实现 /chat/completions，按队列依次返回预设回复。
 * 这样 loop / llm / context 的测试完全离线、可重复，还能断言
 * "harness 到底给模型发了什么"。
 */

import { createServer } from 'node:http';

/**
 * @param {object[]} script 依次返回的 assistant message 数组
 *   [{ content: 'hi' }] 或 [{ content:'', tool_calls:[...] }]
 */
export async function startMockModel(script) {
  const requests = [];
  let index = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ url: req.url, headers: req.headers, body });

    const msg = script[Math.min(index, script.length - 1)] ?? { content: '' };
    index++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock', object: 'chat.completion', created: Date.now() / 1000,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', ...msg }, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    /** 关闭并释放端口 */
    close: () => new Promise((resolve) => server.close(resolve)),
    /** 让下一次请求返回错误状态码（测错误分支） */
    failNext(status = 500) {
      server.removeAllListeners('request');
      server.on('request', (_req, res) => { res.writeHead(status).end('{"error":{"message":"boom"}}'); });
    },
  };
}

/** 一个最小可用的 HarnessConfig */
export function testConfig(overrides = {}) {
  return {
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'test-key',
    model: 'test-model',
    maxSteps: 25,
    yolo: true,          // 测试默认放行，权限相关的用例显式关掉
    contextChars: 48_000,
    ...overrides,
  };
}
