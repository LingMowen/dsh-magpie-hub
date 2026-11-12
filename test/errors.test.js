/**
 * 错误文案翻译层的行为测试（`src/panel.js` 的 `friendlyError` / `errorCallout`）。
 *
 * 背景：安卓端从桌面复制了 `plugin-auth.json`，里面的凭据是 Windows DPAPI
 * 密封的，手机上解不开 —— 面板把原文 `这是 Windows DPAPI 密封的凭据…`
 * 直接显示给用户，看起来像插件坏了。这里锁住「底层原文 → 可动手的一句话」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelView } from '../src/panel.js';

function snapshot(overrides = {}) {
    const provider = {
        id: 'sensenova-token-plan',
        name: 'SenseNova Token Plan',
        accounts: [{ key: 'sensenova-token-plan', accountId: 'acct-1', signIn: 'kept' }],
        methods: [{ index: 0, type: 'oauth', label: '浏览器登录' }],
        models: { 'm-1': {} },
        ...overrides.provider,
    };
    return {
        providers: [provider],
        usage: overrides.usage ?? [],
        routing: { rows: [], total: 0 },
        store: [],
        plugins: [],
        pluginFailures: [],
        updatedAt: 1,
    };
}

/** 收集视图里所有 callout 的文案。 */
function callouts(view) {
    const out = [];
    const walk = (node) => {
        if (node === null || typeof node !== 'object')
            return;
        if (node.type === 'callout' && typeof node.text === 'string')
            out.push(node.text);
        for (const value of Object.values(node)) {
            if (Array.isArray(value))
                value.forEach(walk);
            else if (value !== null && typeof value === 'object')
                walk(value);
        }
    };
    walk(view);
    return out;
}

const DPAPI = '这是 Windows DPAPI 密封的凭据，但当前环境没有 DPAPI，无法解开';

test('DPAPI 原文被翻成「请在手机上重新登录」', () => {
    const view = panelView(snapshot({
        usage: [{ key: 'sensenova-token-plan', label: 'sensenova-token-plan', error: DPAPI, windows: [] }],
    }), { locale: 'zh' }, { page: 'quotas' });
    const texts = callouts(view);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /手机上重新登录/);
    // 原文里的技术词不该再出现（用户看不出那是什么）
    assert.ok(!texts[0].includes('DPAPI'));
});

test('英文 locale 同样不暴露 DPAPI 原文', () => {
    const view = panelView(snapshot({
        usage: [{ key: 'sensenova-token-plan', label: 'sensenova-token-plan', error: DPAPI, windows: [] }],
    }), { locale: 'en' }, { page: 'quotas' });
    const texts = callouts(view);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /sign in again on the phone/i);
    assert.ok(!texts[0].includes('DPAPI'));
});

test('401 / sign_in_required 翻成「登录已过期」', () => {
    const view = panelView(snapshot({
        usage: [{ key: 'sensenova-token-plan', label: 'sensenova-token-plan', error: 'request failed: 401 sign_in_required', windows: [] }],
    }), { locale: 'zh' }, { page: 'quotas' });
    assert.deepEqual(callouts(view), ['sensenova-token-plan：登录已过期']);
});

test('网络错误翻成「连不上服务器」', () => {
    const view = panelView(snapshot({
        usage: [{ key: 'sensenova-token-plan', label: 'sensenova-token-plan', error: 'TypeError: fetch failed', windows: [] }],
    }), { locale: 'zh' }, { page: 'quotas' });
    assert.match(callouts(view)[0], /连不上服务器/);
});

test('认不出的错误保留一小段原文，且不整段堆上去', () => {
    const long = 'E'.repeat(400);
    const view = panelView(snapshot({
        usage: [{ key: 'sensenova-token-plan', label: 'sensenova-token-plan', error: long, windows: [] }],
    }), { locale: 'zh' }, { page: 'quotas' });
    const text = callouts(view)[0];
    assert.match(text, /重新登录/);
    assert.ok(text.length < 200, `错误文案过长：${text.length}`);
    assert.ok(text.includes('…'));
});

test('平台级 error 也走同一套翻译（平台页卡片前）', () => {
    const view = panelView(snapshot({
        provider: { error: DPAPI },
    }), { locale: 'zh' }, { page: 'agents' });
    const texts = callouts(view);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /手机上重新登录/);
    assert.ok(texts[0].startsWith('SenseNova Token Plan'));
});
