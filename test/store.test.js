/**
 * `PluginStore` 的读写形状。
 *
 * 这组用例来自一个真实事故：`add` / `remove` / `setEnabled` / `setOptions`
 * 以前都直接 `writeJson(paths.plugins, list)` 写**裸数组**，而 magpie 只认
 * `{ plugins: [...] }`——只要在面板里装过一次插件，`plugins.json` 就被写成
 * 数组，magpie（以及手机端原生面板）打开时当作「一个插件都没装」。
 *
 * 所以这里**必须**断言磁盘上的形状，而不只是断言 `list()` 读回来对不对。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AuthStore, PluginStore } from '../src/store.js';

/** 建一个临时「magpie 根目录」，返回 store 与文件路径。 */
async function withStore(fn) {
    const root = await mkdtemp(join(tmpdir(), 'magpie-store-'));
    const paths = {
        root,
        plugins: join(root, 'plugins.json'),
        modules: join(root, 'plugins', 'node_modules'),
    };
    await mkdir(paths.modules, { recursive: true });
    try {
        return await fn(new PluginStore(paths), paths);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}

/** 读磁盘上的原始 JSON（不做任何兼容处理）。 */
async function readRaw(paths) {
    return JSON.parse(await readFile(paths.plugins, 'utf8'));
}

test('add：磁盘上是 { plugins: [...] }，不是裸数组', async () => {
    await withStore(async (store, paths) => {
        await store.add('wps-lingxi');
        const raw = await readRaw(paths);
        assert.equal(Array.isArray(raw), false, '顶层必须是对象');
        assert.ok(Array.isArray(raw.plugins), 'plugins 必须是数组');
        assert.equal(raw.plugins.length, 1);
        assert.equal(raw.plugins[0].spec, 'wps-lingxi');
        assert.equal(raw.plugins[0].enabled, true);
    });
});

test('add：重复 spec 是更新而不是追加', async () => {
    await withStore(async (store, paths) => {
        await store.add('wps-lingxi');
        await store.add('wps-lingxi', { probe: 1 });
        const raw = await readRaw(paths);
        assert.equal(raw.plugins.length, 1);
        assert.deepEqual(raw.plugins[0].options, { probe: 1 });
    });
});

test('remove / setEnabled / setOptions 都保持外层对象', async () => {
    await withStore(async (store, paths) => {
        await store.add('a');
        await store.add('b');

        await store.setEnabled('a', false);
        let raw = await readRaw(paths);
        assert.equal(Array.isArray(raw), false);
        assert.equal(raw.plugins.find((x) => x.spec === 'a').enabled, false);

        await store.setOptions('b', { k: 1 });
        raw = await readRaw(paths);
        assert.equal(Array.isArray(raw), false);
        assert.deepEqual(raw.plugins.find((x) => x.spec === 'b').options, { k: 1 });

        await store.remove('a');
        raw = await readRaw(paths);
        assert.equal(Array.isArray(raw), false);
        assert.deepEqual(raw.plugins.map((x) => x.spec), ['b']);
    });
});

test('setOptions(null) 清掉 options 键（与桌面端 Clear 同义）', async () => {
    await withStore(async (store, paths) => {
        await store.add('a', { k: 1 });
        await store.setOptions('a', null);
        const raw = await readRaw(paths);
        assert.equal('options' in raw.plugins[0], false);
    });
});

test('list() 兼容历史遗留的裸数组（读得出来，下次写回变成对象）', async () => {
    await withStore(async (store, paths) => {
        // 模拟被旧版本写坏的文件
        await writeFile(paths.plugins, JSON.stringify([{ spec: 'legacy' }]), 'utf8');
        assert.deepEqual((await store.list()).map((x) => x.spec), ['legacy']);

        await store.add('fresh');
        const raw = await readRaw(paths);
        assert.equal(Array.isArray(raw), false, '写回时必须修成对象');
        assert.deepEqual(raw.plugins.map((x) => x.spec), ['legacy', 'fresh']);
    });
});

test('list() 过滤掉没有 spec 的条目', async () => {
    await withStore(async (store, paths) => {
        await writeFile(paths.plugins, JSON.stringify({
            plugins: [{ spec: 'ok' }, { name: 'no-spec' }, null, 'string', { spec: 42 }],
        }), 'utf8');
        assert.deepEqual((await store.list()).map((x) => x.spec), ['ok']);
    });
});

test('文件不存在时 list() 给空数组，add 后建出正确形状', async () => {
    await withStore(async (store, paths) => {
        assert.deepEqual(await store.list(), []);
        await store.add('first');
        const raw = await readRaw(paths);
        assert.equal(Array.isArray(raw), false);
        assert.equal(raw.plugins[0].spec, 'first');
    });
});

/**
 * 桌面 magpie 与我们读的是同一个 `plugin-auth.json`（`configRoot()` 优先命中
 * `~/.config/magpie`）。它在自己的进程里登录/删账号时直接改这个 JSON，我们
 * 这边没有写文件 —— 所以缓存必须能发现「别人动过」，否则用户在 magpie 里
 * 登录一个账号，面板要重启才看得见。
 *
 * 用 mtime + size 判断：Windows 上同一毫秒内改写会让 mtime 看起来没变，
 * 而字节数几乎一定会变。
 */
test('AuthStore：外部改了 auth 文件后，下一次读能拿到新内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auth-store-'));
    const file = join(dir, 'plugin-auth.json');
    await writeFile(file, JSON.stringify({ 'wps-lingxi': { accountId: 'A' } }), 'utf8');
    try {
        const store = new AuthStore({ root: dir, auth: file });
        assert.equal((await store.get('wps-lingxi'))?.accountId, 'A');
        // 模拟 magpie 在我们背后改写：多一个账号、改一个字段
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(file, JSON.stringify({
            'wps-lingxi': { accountId: 'B' },
            marvis: { accountId: 'M1' },
        }), 'utf8');
        assert.equal((await store.get('wps-lingxi'))?.accountId, 'B');
        // 新增的那个账号也要看得见，不只是「命中的那条被替换」
        assert.equal((await store.get('marvis'))?.accountId, 'M1');
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('AuthStore：文件被删后重读成空，自己写完不白读盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auth-store-'));
    const file = join(dir, 'plugin-auth.json');
    await writeFile(file, JSON.stringify({ 'wps-lingxi': { accountId: 'A' } }), 'utf8');
    try {
        const store = new AuthStore({ root: dir, auth: file });
        assert.equal((await store.get('wps-lingxi'))?.accountId, 'A');
        // 自己写一条：缓存立刻更新，且 stamp 对齐（不会因为 mtime 变了又重读）
        await store.set('marvis', { accountId: 'M2' });
        assert.equal((await store.get('marvis'))?.accountId, 'M2');
        assert.equal((await store.get('wps-lingxi'))?.accountId, 'A');
        // 文件被整个删掉：重读成空，而不是继续吐旧缓存
        await rm(file);
        assert.equal(await store.get('wps-lingxi'), undefined);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
