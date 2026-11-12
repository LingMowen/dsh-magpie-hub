/**
 * `withDeadline` 的边界：按时返回就用真值，超时/抛错都用兜底。
 *
 * 这几条直接对应手机端的故障现象 —— 目录请求卡住时，模型选择器会一直停在
 * 「更新中」且不可点，所以「超时必须兑现」是这条逻辑的全部意义。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CATALOG_TIMEOUT_MS, withDeadline } from '../src/deadline.js';

test('按时返回时用真实结果', async () => {
    const value = await withDeadline(Promise.resolve({ m1: {} }), 100, { fallback: true });
    assert.deepEqual(value, { m1: {} });
});

test('超时用兜底，且不等待迟到的结果', async () => {
    const started = Date.now();
    const slow = new Promise((resolve) => setTimeout(() => resolve({ late: true }), 300));
    const value = await withDeadline(slow, 40, { fallback: true });
    const elapsed = Date.now() - started;
    assert.deepEqual(value, { fallback: true });
    // 只等 40ms 量级：给 CI 留 200ms 余量，但不允许等到 300ms
    assert.ok(elapsed < 250, `应当早于慢请求返回，实际 ${elapsed}ms`);
});

test('抛错也用兜底（目录失败不该让选择器空掉）', async () => {
    const value = await withDeadline(Promise.reject(new Error('boom')), 100, { safe: 1 });
    assert.deepEqual(value, { safe: 1 });
});

test('超时上限是 4 秒（手机端整页等待的总预算）', () => {
    assert.equal(CATALOG_TIMEOUT_MS, 4000);
});
