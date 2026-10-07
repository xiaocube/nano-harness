/**
 * tests/context.test.mjs —— 上下文压缩
 *
 * 核心是两条不变量：
 *   1. 压缩不能把 assistant(tool_calls) 和它的 tool 结果切开（切开就 400，且历史被永久污染）；
 *   2. 压缩失败（摘要模型调不通）必须降级放行，不能把整轮对话卡死。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, cleanupHome } from './helpers/env.mjs';
import { startMockModel, testConfig } from './helpers/mock-model.mjs';

const home = isolateHome('nh-ctx-');
const { maybeCompact, estimateTokens, estimateMessagesTokens } = await import('../dist/context.js');

after(() => cleanupHome(home));

const toolGroup = (step) => ([
  { role: 'assistant', content: '', tool_calls: [{ id: `c${step}`, type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `c${step}`, content: `结果 ${step} ${'y'.repeat(80)}` },
]);

/** 造一段"工具调用很密集"的历史，这是最容易切错的情况 */
const heavyHistory = (steps) => [
  { role: 'system', content: 'sys' },
  ...Array.from({ length: steps }, (_, i) => ({ role: 'user', content: `任务 ${i} ${'x'.repeat(120)}` })),
  ...Array.from({ length: steps }, (_, i) => toolGroup(i)).flat(),
];

describe('context: 估算', () => {
  test('estimateTokens 随长度单调增长', () => {
    assert.ok(estimateTokens('x'.repeat(100)) > estimateTokens('x'.repeat(10)));
    assert.ok(estimateTokens('') === 0);
  });

  test('estimateMessagesTokens 覆盖所有消息', () => {
    const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    assert.ok(estimateMessagesTokens(msgs) >= estimateTokens('a') + estimateTokens('b'));
  });
});

describe('context: 触发条件', () => {
  test('没超阈值时不压缩', async () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    const out = await maybeCompact(msgs, testConfig({ contextChars: 10_000 }));
    assert.equal(out.compacted, false);
    assert.equal(out.messages, msgs, '应原样返回同一个引用');
  });

  test('可压缩内容太少时不压缩（避免把摘要再摘要）', async () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'x'.repeat(5000) }];
    const out = await maybeCompact(msgs, testConfig({ contextChars: 100 }));
    assert.equal(out.compacted, false);
  });
});

describe('context: 压缩正确性', () => {
  /** 不变量：每条 tool 消息前面必须有"带 tool_calls 的 assistant"或另一条 tool */
  const assertNoOrphanTools = (msgs) => {
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'tool') continue;
      const prev = msgs[i - 1];
      const ok = Boolean(prev) && ((prev.role === 'assistant' && prev.tool_calls) || prev.role === 'tool');
      assert.ok(ok, `第 ${i} 条 tool 消息是孤儿：前一条是 ${prev?.role}`);
    }
  };

  for (const steps of [2, 4, 6, 8]) {
    test(`${steps} 组工具调用：压缩后不出现"孤儿 tool 消息"`, async () => {
      const mock = await startMockModel([{ content: '【摘要】继续干活' }, { content: 'done' }]);
      try {
        const out = await maybeCompact(heavyHistory(steps), testConfig({ baseUrl: mock.baseUrl, contextChars: 300 }));
        assertNoOrphanTools(out.messages);
        if (steps >= 4) {
          assert.equal(out.compacted, true, '工具密集的长历史应当触发压缩');
          assert.equal(out.messages[0].role, 'system', 'system 必须在最前');
          assert.match(out.messages[1].content, /此前对话的摘要/);
        }
      } finally { await mock.close(); }
    });
  }

  test('压缩后保留最近几轮原文（模型不能失忆）', async () => {
    const mock = await startMockModel([{ content: '【摘要】' }]);
    try {
      const out = await maybeCompact(heavyHistory(6), testConfig({ baseUrl: mock.baseUrl, contextChars: 300 }));
      assert.equal(out.compacted, true);
      assert.match(JSON.stringify(out.messages), /结果 5/, '最后一条工具结果应被保留');
    } finally { await mock.close(); }
  });
});

describe('context: 失败降级', () => {
  test('摘要调用失败时放弃压缩，而不是抛错卡死', async () => {
    // 指向一个打不通的端口
    const out = await maybeCompact(heavyHistory(6), testConfig({ baseUrl: 'http://127.0.0.1:1/v1', contextChars: 300 }));
    assert.equal(out.compacted, false);
    assert.ok(Array.isArray(out.messages));
  });

  test('摘要返回空字符串时不压缩', async () => {
    const mock = await startMockModel([{ content: '   ' }]);
    try {
      const out = await maybeCompact(heavyHistory(6), testConfig({ baseUrl: mock.baseUrl, contextChars: 300 }));
      assert.equal(out.compacted, false);
    } finally { await mock.close(); }
  });
});
