// 账号备份：封印/解开、收集、回填
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CorruptBackupError, NotBackupError, PassphraseError,
    applyAccounts, collectAccounts, open, seal,
} from '../src/backup.js';

const PASS = 'a long enough passphrase 42';

/** 造一个 magpie 数据根：三个文件的形状照真实的那份。 */
async function fixtureRoot() {
    const root = await mkdtemp(join(tmpdir(), 'magpie-backup-'));
    await writeFile(join(root, 'plugin-auth.json'), JSON.stringify({
        'wps-lingxi': { type: 'oauth', access: 'A1', refresh: 'R1', expires: 1764200000 },
        'demo-two': { type: 'oauth', access: 'A2', refresh: 'R2', expires: 1764200001 },
    }), 'utf8');
    await writeFile(join(root, 'logins.json'), JSON.stringify([
        { agent: 'claude', user: 'someone@example.com', profile: {} },
        { agent: 'codex', user: 'other@example.com', auth: {} },
    ]), 'utf8');
    await writeFile(join(root, 'plugins.json'), JSON.stringify({
        plugins: [{ spec: 'wps-lingxi' }, { spec: 'magpie-marvis' }],
    }), 'utf8');
    return root;
}

test('封印再解开，内容一字不差', () => {
    const bundle = { version: 2, keys: true, providers: [], signIns: { plugins: { a: { access: 'x' } } } };
    const sealed = seal(bundle, PASS);
    assert.ok(Buffer.isBuffer(sealed));
    const back = open(sealed, PASS);
    assert.deepEqual(back, bundle);
});

test('外层 envelope 的字段与 Go 那边一致（format/kdf/iterations/base64）', () => {
    const sealed = seal({ version: 2, keys: true, providers: [] }, PASS);
    const env = JSON.parse(sealed.toString('utf8'));
    assert.equal(env.format, 'magpie-backup');
    assert.equal(env.version, 1);
    assert.equal(env.kdf, 'pbkdf2-sha256');
    assert.equal(env.iterations, 600_000);
    // 三个 []byte 字段必须是 base64（Go 的默认编码），salt 解码后 16 字节、nonce 12
    const salt = Buffer.from(env.salt, 'base64');
    const nonce = Buffer.from(env.nonce, 'base64');
    assert.equal(salt.length, 16);
    assert.equal(nonce.length, 12);
    // 密文尾部带 16 字节认证标签
    assert.ok(Buffer.from(env.data, 'base64').length > 16);
});

test('错口令报 PassphraseError，不吐半截数据', () => {
    const sealed = seal({ version: 2, keys: true, providers: [] }, PASS);
    assert.throws(() => open(sealed, `${PASS}!`), PassphraseError);
});

test('改一个字节会被验签发现', () => {
    const sealed = seal({ version: 2, keys: true, providers: [] }, PASS);
    const env = JSON.parse(sealed.toString('utf8'));
    const data = Buffer.from(env.data, 'base64');
    data[0] ^= 0xff;
    env.data = data.toString('base64');
    assert.throws(() => open(Buffer.from(JSON.stringify(env)), PASS), PassphraseError);
});

test('不是备份的文件与损坏的备份分开报', () => {
    assert.throws(() => open(Buffer.from('<html>captive portal</html>'), PASS), NotBackupError);
    // 开头像备份、但 JSON 断了 —— 是损坏，不是「别的文件」
    assert.throws(() => open(Buffer.from('{"format":"magpie-backup","version":1,"kdf'), PASS), CorruptBackupError);
    // 更新版本的 magpie 写的
    const newer = JSON.stringify({ format: 'magpie-backup', version: 2, kdf: 'argon2id', iterations: 1 });
    assert.throws(() => open(Buffer.from(newer), PASS), CorruptBackupError);
    // 参数越界（迭代次数太小）
    const thin = JSON.stringify({
        format: 'magpie-backup', version: 1, kdf: 'pbkdf2-sha256', iterations: 1,
        salt: Buffer.alloc(16).toString('base64'), nonce: Buffer.alloc(12).toString('base64'),
        data: Buffer.alloc(64).toString('base64'),
    });
    assert.throws(() => open(Buffer.from(thin), PASS), CorruptBackupError);
});

test('空口令不给封印', () => {
    assert.throws(() => seal({ version: 2 }, ''), /passphrase/);
});

test('收集账号：只取账号三件套，不带供应商', async () => {
    const root = await fixtureRoot();
    const bundle = await collectAccounts(root, { app: 'test-app' });
    assert.equal(bundle.version, 2);
    assert.equal(bundle.keys, true, '账号就是凭据，策略位必须是 true');
    assert.deepEqual(bundle.providers, [], '不带 providers');
    assert.equal(bundle.app, 'test-app');
    assert.equal(Object.keys(bundle.signIns.plugins).length, 2);
    assert.equal(bundle.signIns.logins.length, 2);
    assert.equal(bundle.hubPlugins.plugins.length, 2);
});

test('收集账号：文件缺失也不报错（空账号就是空备份）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'magpie-empty-'));
    const bundle = await collectAccounts(root);
    assert.equal(bundle.signIns, undefined);
    assert.equal(bundle.hubPlugins, undefined);
    // 仍然能封印、能解开
    assert.deepEqual(open(seal(bundle, PASS), PASS), bundle);
});

test('回填：账号按 key 覆盖，订阅账号按 agent+账号去重追加', async () => {
    const source = await fixtureRoot();
    const bundle = await collectAccounts(source);
    // 目标机已经有一个不同的账号，以及一个同名但 key 不同的
    const target = await mkdtemp(join(tmpdir(), 'magpie-target-'));
    await writeFile(join(target, 'plugin-auth.json'), JSON.stringify({
        'local-only': { access: 'L' },
        'wps-lingxi': { access: 'OLD' },
    }), 'utf8');
    await writeFile(join(target, 'logins.json'), JSON.stringify([
        { agent: 'claude', user: 'someone@example.com', profile: {} },
    ]), 'utf8');
    const summary = await applyAccounts(target, bundle);
    // wps-lingxi 被覆盖、demo-two 新增、local-only 保留
    const auth = JSON.parse(await readFile(join(target, 'plugin-auth.json'), 'utf8'));
    assert.equal(auth['wps-lingxi'].access, 'A1', '导入的覆盖本机同 key');
    assert.equal(auth['demo-two'].access, 'A2');
    assert.equal(auth['local-only'].access, 'L', '本机独有的不能丢');
    assert.equal(summary.accounts, 2);
    // 订阅账号：claude 那条重复（不重复加），codex 那条是新的
    const logins = JSON.parse(await readFile(join(target, 'logins.json'), 'utf8'));
    assert.equal(logins.length, 2);
    assert.equal(summary.logins, 1);
    // 插件清单两项都是新的
    const plugins = JSON.parse(await readFile(join(target, 'plugins.json'), 'utf8'));
    assert.equal(plugins.plugins.length, 2);
    assert.equal(summary.plugins, 2);
});

test('回填：给了 install 就把新插件装上，装失败记进 missing', async () => {
    const source = await fixtureRoot();
    const bundle = await collectAccounts(source);
    const target = await mkdtemp(join(tmpdir(), 'magpie-install-'));
    const tried = [];
    const summary = await applyAccounts(target, bundle, {
        install: async (spec) => {
            tried.push(spec);
            if (spec === 'magpie-marvis')
                throw new Error('网络不通');
        },
    });
    assert.deepEqual(tried, ['wps-lingxi', 'magpie-marvis']);
    assert.deepEqual(summary.missing, ['magpie-marvis'], '装不上的要报出来，不能静默');
});

test('回填：没有 signIns 的备份只装插件，账号文件不动', async () => {
    const target = await mkdtemp(join(tmpdir(), 'magpie-only-plugins-'));
    await writeFile(join(target, 'plugin-auth.json'), JSON.stringify({ keep: { access: 'K' } }), 'utf8');
    const summary = await applyAccounts(target, {
        version: 2, keys: true, providers: [], hubPlugins: { plugins: [{ spec: 'x' }] },
    });
    assert.equal(summary.accounts, 0);
    assert.equal(summary.plugins, 1);
    const auth = JSON.parse(await readFile(join(target, 'plugin-auth.json'), 'utf8'));
    assert.deepEqual(auth, { keep: { access: 'K' } }, '没带账号时不能把本机账号写空');
});

test('回填是原子的：写完才改名，不留半个文件', async () => {
    const target = await mkdtemp(join(tmpdir(), 'magpie-atomic-'));
    await applyAccounts(target, {
        version: 2, keys: true, providers: [],
        signIns: { plugins: { p: { access: 'A' } } },
    });
    const auth = JSON.parse(await readFile(join(target, 'plugin-auth.json'), 'utf8'));
    assert.deepEqual(auth, { p: { access: 'A' } });
    // 临时文件不能残留
    assert.equal(existsSync(join(target, 'plugin-auth.json.tmp')), false);
});
