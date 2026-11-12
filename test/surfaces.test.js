import test from 'node:test';
import assert from 'node:assert/strict';
import { compactAmount, currentProviderId, noteLine, shortProviderName, stripLine } from '../src/surfaces.js';



/** 一份只够这几条断言用的快照。 */
const snapshot = {
    providers: [
        { id: 'wps-lingxi', name: 'WPS 灵犀 Lingxi', accounts: [{ key: 'a' }] },
        { id: 'codearts', name: 'CodeArts', accounts: [] },
        { id: 'marvis', name: '腾讯 Marvis TENCENT', accounts: [{ key: 'b' }] },
    ],
    usage: [
        {
            provider: 'wps-lingxi',
            accountKey: 'a',
            windows: [{ name: '智点', limit: 2300, amount: 1 }],
        },
        { provider: 'marvis', accountKey: 'b', windows: [{ name: '无额度' }] },
    ],
};

test('平台短名：取第一段中文，全英文取第一段', () => {
    assert.equal(shortProviderName(snapshot, 'wps-lingxi'), '灵犀');
    assert.equal(shortProviderName(snapshot, 'codearts'), 'CodeArts');
    assert.equal(shortProviderName(snapshot, 'marvis'), '腾讯');
    // 未知平台退回 id 本身，不能抛
    assert.equal(shortProviderName(snapshot, 'nope'), 'nope');
    assert.equal(shortProviderName(null, undefined), '');
});

test('数字压缩：万 / 亿 / 千分位', () => {
    assert.equal(compactAmount(999), '999');
    assert.equal(compactAmount(2300), '2,300');
    assert.equal(compactAmount(12000), '1万');
    assert.equal(compactAmount(120000000), '1.2亿');
    assert.equal(compactAmount(undefined), '0');
});

test('回合脚注不超过 16 字', () => {
    const ok = noteLine({ provider: 'wps-lingxi', status: 'ok', tokens: 12000, ms: 900 }, snapshot);
    assert.equal(ok, '12K');
    assert.ok([...ok].length <= 16, `超字：${ok}`);
    // 没有 token 就用耗时，不给 0 冒充
    const slow = noteLine({ provider: 'wps-lingxi', status: 'ok', ms: 1234 }, snapshot);
    assert.ok([...slow].length <= 16, `超字：${slow}`);
    assert.match(slow, /ms$/);
    // 纯 ASCII：脚注整行要放得下，中文会把 note 挤掉（`turn_footnote.dart` 的降级链）
    assert.match(noteLine({ provider: 'wps-lingxi', status: 'ok', tokens: 1200000 }, snapshot), /^1\.2M$/);
    // 失败要有明确标记
    assert.match(noteLine({ provider: 'wps-lingxi', status: 'error' }, snapshot), /失败/);
});

test('额度状态条不超过 24 字，且算的是剩余不是已用', () => {
    const line = stripLine(snapshot, 'wps-lingxi', 'zh');
    assert.equal(line, '灵犀 · 剩 2,299');
    assert.ok([...line].length <= 24, `超字：${line}`);
    const en = stripLine(snapshot, 'wps-lingxi', 'en');
    assert.equal(en, '灵犀 · left 2,299');
    // 没有额度窗口就只显示平台名，不能瞎编数字
    assert.equal(stripLine(snapshot, 'marvis', 'zh'), '腾讯');
    // 平台名为空时退回「额度」这个词
    assert.equal(stripLine({ providers: [], usage: [] }, '', 'zh'), '额度');
});
