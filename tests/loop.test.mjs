/**
 * tests/loop.test.mjs —— Agent Loop 端到端（对着真的假模型服务器）
 *
 * 这是全项目最核心的一条链路：模型 → 工具调用 → 执行 → 结果回填 → 最终回答。
 * 用剧本化的 mock 服务器把它整条跑通，并覆盖权限拒绝、未知工具、
 * 参数坏 JSON、步数熔断、预设过滤、上下文压缩等分支。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, cleanupHome } from './helpers/env.mjs';
import { startMockModel, testConfig } from './helpers/mock-model.mjs';

const home = isolateHome('nh-loop-');
const { runAgentTurn, runAgentTurnWithContinuations, CONTINUATION_PROMPT, PRESET_DEFS, refreshSystemPrompt, systemPromptFor } = await import('../dist/loop.js');
const { registerBuiltinTools } = await import('../dist/tools/index.js');
const { setConfirmHandler } = await import('../dist/permission.js');

const work = mkdtempSync(join(tmpdir(), 'nh-loop-ws-'));
before(async () => { await registerBuiltinTools(); });
after(() => { cleanupHome(home); rmSync(work, { recursive: true, force: true }); setConfirmHandler(null); });

const toolCall = (name, args, id = 'call-1') => ({
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

/** 跑一轮续跑包装，返回 { result, events, server } */
async function turnCont(script, task, over = {}, maxContinuations) {
  const server = await startMockModel(script);
  const events = [];
  const result = await runAgentTurnWithContinuations([], task, {
    cfg: testConfig({ ...over, baseUrl: server.baseUrl, model: 'mock' }),
    workspace: work,
    yolo: over.yolo ?? true,
    preset: over.preset,
    maxContinuations,
    onEvent: (e) => events.push(e),
  });
  return { result, events, server };
}

/** 跑一轮，返回 { result, events, server } */
async function turn(script, task = '做点事', over = {}) {
  const server = await startMockModel(script);
  const events = [];
  try {
    const result = await runAgentTurn([], task, {
      cfg: testConfig({ ...over, baseUrl: server.baseUrl, model: 'mock' }),
      workspace: work,
      yolo: over.yolo ?? true,
      preset: over.preset,
      onEvent: (e) => events.push(e),
    });
    return { result, events, server };
  } finally {
    // 调用方读完后手动 close；这里不关是为了让断言能看 requests
  }
}

describe('loop: 基本链路', () => {
  test('模型直接给文字 → 返回答案，事件顺序正确', async () => {
    const { result, events, server } = await turn([{ content: '你好，我是助手' }]);
    try {
      assert.equal(result.answer, '你好，我是助手');
      assert.deepEqual(events.map((e) => e.type), ['thinking_start', 'thinking_end', 'usage', 'answer']);
      assert.equal(events.at(-1).answer, '你好，我是助手');
      // 历史：system + user + assistant
      assert.deepEqual(result.messages.map((m) => m.role), ['system', 'user', 'assistant']);
    } finally { await server.close(); }
  });

  test('系统提示词里带上当前工作区', async () => {
    const { result, server } = await turn([{ content: 'ok' }]);
    try {
      assert.match(result.messages[0].content, new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally { await server.close(); }
  });

  test('工具调用 → 执行 → 结果回填 → 最终回答', async () => {
    writeFileSync(join(work, 'hello.txt'), 'file-content-42', 'utf8');
    const { result, events, server } = await turn([
      toolCall('read_file', { path: 'hello.txt' }),
      { content: '读到了 42' },
    ]);
    try {
      assert.equal(result.answer, '读到了 42');
      const types = events.map((e) => e.type);
      assert.deepEqual(types, [
        'thinking_start', 'thinking_end', 'usage',
        'tool_call', 'tool_result',
        'thinking_start', 'thinking_end', 'usage', 'answer',
      ]);
      // tool 消息必须带 tool_call_id（OpenAI 协议要求）
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      assert.equal(toolMsg.tool_call_id, 'call-1');
      assert.equal(toolMsg.content, 'file-content-42');
      // 第二次请求里应该能看到工具结果
      const second = server.requests[1].body.messages;
      assert.ok(second.some((m) => m.role === 'tool' && m.content === 'file-content-42'));
      assert.ok(second.some((m) => m.role === 'assistant' && m.tool_calls), '带 tool_calls 的 assistant 消息必须先于 tool 消息');
    } finally { await server.close(); }
  });

  test('工具真的写文件（危险操作在 YOLO 下自动放行）', async () => {
    const { result, server } = await turn([
      toolCall('write_file', { path: 'written.txt', content: 'agent wrote this' }),
      { content: '写好了' },
    ]);
    try {
      assert.equal(result.answer, '写好了');
      assert.equal(readFileSync(join(work, 'written.txt'), 'utf8'), 'agent wrote this');
    } finally { await server.close(); }
  });
});

describe('loop: 权限闸门', () => {
  test('用户拒绝 → 工具不执行，且把"被拒绝"回传给模型', async () => {
    const target = join(work, 'should-not-exist.txt');
    setConfirmHandler(async () => false);
    const { result, events, server } = await turn(
      [toolCall('write_file', { path: 'should-not-exist.txt', content: 'nope' }), { content: '好的，我换个办法' }],
      '写个文件',
      { yolo: false },
    );
    try {
      assert.equal(existsSync(target), false, '被拒绝的写操作绝不能落盘');
      assert.ok(events.some((e) => e.type === 'tool_denied'));
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      assert.match(toolMsg.content, /用户拒绝/);
      assert.equal(result.answer, '好的，我换个办法');
    } finally { await server.close(); setConfirmHandler(null); }
  });

  test('用户放行 → 工具执行', async () => {
    setConfirmHandler(async () => true);
    const { result, server } = await turn(
      [toolCall('write_file', { path: 'allowed.txt', content: 'yes' }), { content: 'done' }],
      '写个文件',
      { yolo: false },
    );
    try {
      assert.equal(readFileSync(join(work, 'allowed.txt'), 'utf8'), 'yes');
      assert.equal(result.answer, 'done');
    } finally { await server.close(); setConfirmHandler(null); }
  });

  test('只读工具不触发权限询问', async () => {
    let asked = 0;
    setConfirmHandler(async () => { asked++; return true; });
    const { server } = await turn([toolCall('list_dir', {}), { content: 'ok' }], '看看', { yolo: false });
    try {
      assert.equal(asked, 0, 'list_dir 是只读工具，不该问用户');
    } finally { await server.close(); setConfirmHandler(null); }
  });
});

describe('loop: 异常分支', () => {
  test('模型调用了不存在的工具 → 把可用工具列表回传', async () => {
    const { result, events, server } = await turn([
      toolCall('teleport', { to: 'mars' }),
      { content: '抱歉，我换个工具' },
    ]);
    try {
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      assert.match(toolMsg.content, /不存在名为 "teleport" 的工具/);
      assert.match(toolMsg.content, /read_file/);
      assert.ok(events.some((e) => e.type === 'tool_result' && /未知工具/.test(e.preview)));
    } finally { await server.close(); }
  });

  test('工具参数不是合法 JSON → 回传错误而不是崩溃', async () => {
    const server = await startMockModel([
      { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{not json' } }] },
      { content: '好的' },
    ]);
    try {
      const result = await runAgentTurn([], 'x', {
        cfg: testConfig({ baseUrl: server.baseUrl }), workspace: work, yolo: true, onEvent: () => {},
      });
      assert.match(result.messages.find((m) => m.role === 'tool').content, /不是合法 JSON/);
    } finally { await server.close(); }
  });

  test('工具执行抛错 → 转成文本回传，循环继续', async () => {
    const { result, server } = await turn([
      toolCall('read_file', { path: 'definitely-missing.txt' }),
      { content: '文件不存在，我换个思路' },
    ]);
    try {
      assert.match(result.messages.find((m) => m.role === 'tool').content, /工具执行出错/);
      assert.equal(result.answer, '文件不存在，我换个思路');
    } finally { await server.close(); }
  });

  test('模型一直要工具 → 到 maxSteps 熔断，报告 stopReason 但不提前落库刹车文案', async () => {
    const { result, events, server } = await turn([toolCall('list_dir', {})], '死循环', { maxSteps: 3 });
    try {
      assert.match(result.answer, /已达最大步数（3）上限/);
      assert.equal(result.stopReason, 'max_steps');
      assert.equal(events.filter((e) => e.type === 'thinking_start').length, 3);
      assert.equal(server.requests.length, 3);
      // 单轮不把刹车文案塞进历史、也不发终态 answer（交给外层决定是否续跑）
      assert.equal(events.some((e) => e.type === 'answer'), false);
      assert.equal(events.some((e) => e.type === 'max_steps'), true);
      assert.equal(result.messages.some((m) => m.role === 'assistant' && /已达最大步数/.test(m.content)), false);
    } finally { await server.close(); }
  });
});

describe('loop: 有界自动续跑', () => {
  test('maxContinuations=0：保留旧行为，外层把刹车文案作为最终回答', async () => {
    const { result, events, server } = await turnCont(
      [toolCall('list_dir', {})], '死循环', { maxSteps: 2 }, 0,
    );
    try {
      assert.equal(result.stopReason, 'max_steps');
      assert.match(result.answer, /已达最大步数（2）上限/);
      assert.equal(events.filter((e) => e.type === 'continuation').length, 0);
      assert.equal(events.at(-1).type, 'answer');
      assert.equal(result.messages.at(-1).role, 'assistant');
      assert.match(result.messages.at(-1).content, /已达最大步数/);
    } finally { await server.close(); }
  });

  test('第一段到顶、第二段给出最终答案 → 带着上文续跑成功，只发一次终态 answer', async () => {
    // maxSteps=3：前 3 个响应一直要工具（第一段耗尽），第 4 个响应（续跑段）给文字答案
    const script = [
      toolCall('list_dir', {}, 'c1'),
      toolCall('list_dir', {}, 'c2'),
      toolCall('list_dir', {}, 'c3'),
      { content: '改完了，闸门也绿' },
    ];
    const { result, events, server } = await turnCont(script, '持续改进', { maxSteps: 3 }, 2);
    try {
      assert.equal(result.stopReason, 'answered');
      assert.equal(result.answer, '改完了，闸门也绿');
      assert.equal(server.requests.length, 4); // 没有因为到顶而丢弃上下文或重来
      assert.deepEqual(events.filter((e) => e.type === 'continuation').map((e) => e.index), [1]);
      assert.equal(events.filter((e) => e.type === 'answer').length, 1);
      assert.equal(events.at(-1).type, 'answer');
      // 续跑指令被压进了对话历史，模型因此能看到"要收敛"
      assert.ok(result.messages.some((m) => m.role === 'user' && m.content.startsWith(CONTINUATION_PROMPT.slice(0, 8))));
      // 第一段读到的工具结果仍在历史里（不是重新开始）
      assert.ok(result.messages.filter((m) => m.role === 'tool').length >= 3);
    } finally { await server.close(); }
  });

  test('续跑额度用尽仍在要工具 → 停止，最终回答是刹车文案，全程有界', async () => {
    const script = Array.from({ length: 10 }, (_, i) => toolCall('list_dir', {}, `c${i}`));
    const { result, events, server } = await turnCont(script, '死循环', { maxSteps: 2 }, 1);
    try {
      // 1 个首段 + 1 个续跑段 = 2 × 2 = 4 次模型请求后封顶
      assert.equal(server.requests.length, 4);
      assert.equal(result.stopReason, 'max_steps');
      assert.match(result.answer, /已达最大步数（2）上限/);
      assert.equal(events.filter((e) => e.type === 'continuation').length, 1);
      assert.equal(events.filter((e) => e.type === 'answer').length, 1);
      assert.equal(result.messages.at(-1).role, 'assistant');
      assert.match(result.messages.at(-1).content, /已达最大步数/);
    } finally { await server.close(); }
  });

  test('模型返回意外格式 → 抛出可读错误', async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[]}'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(() => runAgentTurn([], 'x', {
        cfg: testConfig({ baseUrl: `http://127.0.0.1:${srv.address().port}/v1` }),
        workspace: work, yolo: true, onEvent: () => {},
      }), /意外格式/);
    } finally { srv.close(); }
  });
});

describe('loop: 预设', () => {
  test('极简模式只把只读工具发给模型', async () => {
    const { server } = await turn([{ content: 'ok' }], '看看', { preset: 'minimal' });
    try {
      const names = server.requests[0].body.tools.map((t) => t.function.name).sort();
      assert.deepEqual(names, ['list_dir', 'read_file']);
      assert.match(server.requests[0].body.messages[0].content, /极简模式/);
    } finally { await server.close(); }
  });

  test('标准模式暴露全部工具', async () => {
    const { server } = await turn([{ content: 'ok' }], '看看', { preset: 'standard' });
    try {
      const names = server.requests[0].body.tools.map((t) => t.function.name).sort();
      assert.deepEqual(names, ['edit_file', 'list_dir', 'read_file', 'run_bash', 'write_file']);
    } finally { await server.close(); }
  });

  test('三个预设都有文案与工具面定义', () => {
    for (const key of ['standard', 'minimal', 'creative']) {
      assert.ok(PRESET_DEFS[key]);
      assert.equal(typeof PRESET_DEFS[key].label, 'string');
      assert.equal(typeof PRESET_DEFS[key].system(work), 'string');
    }
  });

  test('自定义工具会被带进请求', async () => {
    const { registerTool } = await import('../dist/tools/index.js');
    if (!('echo_tool' in Object.fromEntries((await import('../dist/tools/index.js')).listTools().map((t) => [t.name, t])))) {
      registerTool({
        name: 'echo_tool', description: '回显参数，用于测试', parameters: { type: 'object', properties: {} },
        needsPermission: false, describe: () => '', execute: async () => 'echo',
      });
    }
    const { server } = await turn([{ content: 'ok' }]);
    try {
      assert.ok(server.requests[0].body.tools.some((t) => t.function.name === 'echo_tool'));
    } finally { await server.close(); }
  });
});

describe('loop: 上下文压缩', () => {
  test('历史超过阈值时触发压缩，事件与消息结构正确', async () => {
    const mock = await startMockModel([
      { content: '【摘要】用户想做的事：测试压缩' },   // 第一次调用 = 摘要
      { content: '压缩后继续干活' },                    // 第二次调用 = 正式回答
    ]);
    try {
      const cfg = testConfig({ baseUrl: mock.baseUrl, contextChars: 200 });
      const history = [
        { role: 'system', content: 'sys' },
        ...Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `历史消息 ${i} ${'x'.repeat(60)}` })),
      ];
      const events = [];
      const result = await runAgentTurn(history, '继续', { cfg, workspace: work, yolo: true, onEvent: (e) => events.push(e) });
      assert.ok(events.some((e) => e.type === 'compacted'));
      assert.match(result.messages[0].content, /sys/, 'system 必须回到最前');
      assert.match(result.messages[1].content, /此前对话的摘要|摘要/);
      assert.ok(result.messages.length < history.length + 2);
    } finally { await mock.close(); }
  });
});

describe('loop: 系统提示词刷新（宿主在切换工作区/预设/恢复会话时调用）', () => {
  test('首条已是 system → 原地替换成新工作区与预设的内容', () => {
    const messages = [
      { role: 'system', content: '旧工作区 /old/dir 的提示词' },
      { role: 'user', content: '你好' },
    ];
    refreshSystemPrompt(messages, 'minimal', work);
    assert.equal(messages.length, 2, '不应新增消息，只替换首条');
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(messages[0].content, /极简模式/);
  });

  test('首条不是 system → 在最前面补一条', () => {
    const messages = [{ role: 'user', content: '你好' }];
    refreshSystemPrompt(messages, 'standard', work);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages.length, 2);
  });

  test('systemPromptFor 随预设返回不同工具面/人设文案', () => {
    assert.match(systemPromptFor('minimal', work), /极简模式/);
    assert.match(systemPromptFor('creative', work), /创造模式/);
    assert.match(systemPromptFor('standard', work), new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
