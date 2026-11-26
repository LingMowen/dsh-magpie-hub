/**
 * magpie 备份文件（`.magpie-backup`）的封印与解开。
 *
 * 格式必须与 magpie 的 `internal/backup/backup.go` 逐字节兼容，否则
 * 「电脑上导出 → 手机上导入」这条路根本走不通。对齐的四处：
 *
 * 1. 外层 envelope 是 JSON：`{format, version, kdf, iterations, salt, nonce, data}`，
 *    其中三个 `[]byte` 字段在 JSON 里都是 **base64**（Go 的默认编码）。
 * 2. 密钥 = `PBKDF2-HMAC-SHA256(口令, salt, iterations, 32 字节)`。
 * 3. 明文用 **AES-256-GCM** 封印，AAD 是
 *    `` `${format}/${version}/${kdf}/${iterations}/${salt hex}` `` ——
 *    salt 是**十六进制**，不是 base64（Go 那边是 `%x`）。
 * 4. GCM 的认证标签（16 字节）**追加在密文尾部**，不单独存放
 *    （Go 的 `gcm.Seal` 就是这么排的）；Node 的 `getAuthTag()` 要自己拼上去。
 *
 * 任何一处不一致都会表现为「口令明明是对的，却打不开」，而错误只有
 * 一个 `unable to authenticate data`，所以这里把每一步都按 Go 的实现抄。
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 备份文件的后缀，与 magpie 的 `backup.Ext` 一致。 */
export const BACKUP_EXT = '.magpie-backup';

/** envelope 里 `format` 字段的值，也是认文件的唯一标识。 */
const FORMAT = 'magpie-backup';
/** KDF 名字：只认这一个，别的都是更新版本的 magpie 写的。 */
const KDF = 'pbkdf2-sha256';
/** 迭代次数，与 magpie 的 `iterations` 常量一致。 */
const ITERATIONS = 600_000;
/** 我们这个 bundle 的结构版本（2 起带 per-part 凭据标记）。 */
const BUNDLE_VERSION = 2;
/** 认证标签长度：GCM 默认值，magpie 也用默认。 */
const TAG_BYTES = 16;

/** 口令不对（或文件被改过）。 */
export class PassphraseError extends Error {
    constructor() {
        super('wrong passphrase, or the file was changed');
        this.name = 'PassphraseError';
    }
}

/** 根本不是备份文件（别的应用的文件、服务器返回的网页）。 */
export class NotBackupError extends Error {
    constructor() {
        super('not a magpie backup');
        this.name = 'NotBackupError';
    }
}

/** 备份文件损坏，或者是更新版本的 magpie 写的。 */
export class CorruptBackupError extends Error {
    constructor(message = 'not a magpie backup') {
        super(message);
        this.name = 'CorruptBackupError';
    }
}

/**
 * AAD：与 Go 的 `header(e)` 同一条字符串。
 *
 * Go 那边是 `fmt.Appendf(nil, "%s/%d/%s/%d/%x", …)` —— `%x` 对 `[]byte`
 * 就是小写十六进制。这里必须一模一样，否则 GCM 验签必然失败。
 */
function header(version, iterations, salt) {
    return `${FORMAT}/${version}/${KDF}/${iterations}/${salt.toString('hex')}`;
}

/** PBKDF2：Go 的 `pbkdf2.Key(sha256.New, pass, salt, iterations, 32)`。 */
function deriveKey(pass, salt, iterations) {
    return pbkdf2Sync(Buffer.from(pass, 'utf8'), salt, iterations, 32, 'sha256');
}

/**
 * 把一个 bundle 封印成备份文件的字节。
 *
 * @param {object} bundle 明文内容（会 `JSON.stringify` 后封印）
 * @param {string} pass 口令，不能为空
 * @returns {Buffer} 可以原样写成 `.magpie-backup` 的字节
 */
export function seal(bundle, pass) {
    if (typeof pass !== 'string' || pass === '')
        throw new Error('a backup needs a passphrase');
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const version = 1;
    const plain = Buffer.from(JSON.stringify(bundle), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', deriveKey(pass, salt, ITERATIONS), nonce, {
        authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(header(version, ITERATIONS, salt), 'utf8'));
    // 顺序与 Go 的 `gcm.Seal(nil, nonce, plain, aad)` 一致：密文在前、标签在后。
    const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const envelope = {
        format: FORMAT,
        version,
        kdf: KDF,
        iterations: ITERATIONS,
        salt: salt.toString('base64'),
        nonce: nonce.toString('base64'),
        data: data.toString('base64'),
    };
    // Go 用 `json.MarshalIndent(e, "", "  ")`，缩进两格。格式上不影响互读，
    // 但保持一样，diff 时好对。
    return Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
}

/**
 * 解开一个备份文件。
 *
 * 校验顺序照抄 Go 的 `Open`：先认格式，再看是不是更新版本写的，最后才是
 * 参数合法性与口令 —— 这样每种失败都能给出**不一样**的提示，而不是一律
 * 「打不开」。
 *
 * @param {Buffer|Uint8Array|string} data 文件字节
 * @param {string} pass 口令
 * @returns {object} 明文 bundle
 */
export function open(data, pass) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data ?? '').toString('utf8');
    let envelope;
    try {
        envelope = JSON.parse(text);
    }
    catch {
        // 只有「开头像备份」的才算损坏；别的（网页、别的文件）就是别的。
        throw looksLikeBackup(text) ? new CorruptBackupError() : new NotBackupError();
    }
    if (envelope === null || typeof envelope !== 'object' || envelope.format !== FORMAT)
        throw new NotBackupError();
    if (envelope.version !== 1 || envelope.kdf !== KDF) {
        throw new CorruptBackupError('this backup was made by a newer magpie; update to open it');
    }
    const iterations = envelope.iterations;
    const salt = Buffer.from(String(envelope.salt ?? ''), 'base64');
    const nonce = Buffer.from(String(envelope.nonce ?? ''), 'base64');
    const sealed = Buffer.from(String(envelope.data ?? ''), 'base64');
    if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000
        || nonce.length !== 12 || salt.length < 16 || sealed.length <= TAG_BYTES) {
        throw new CorruptBackupError();
    }
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const body = sealed.subarray(0, sealed.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(pass, salt, iterations), nonce, {
        authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(header(envelope.version, iterations, salt), 'utf8'));
    decipher.setAuthTag(tag);
    let plain;
    try {
        plain = Buffer.concat([decipher.update(body), decipher.final()]);
    }
    catch {
        // GCM 验签失败：口令不对，或者有人改过密文。两者对用户是同一件事。
        throw new PassphraseError();
    }
    try {
        return JSON.parse(plain.toString('utf8'));
    }
    catch {
        throw new CorruptBackupError('the backup opened but its content is unreadable');
    }
}

/** 去掉空白后是否以备份的头部开头（Go 的 `isBackupJSON`）。 */
function looksLikeBackup(text) {
    return text.replace(/[ \t\r\n]/g, '').startsWith(`{"format":"${FORMAT}"`);
}

/* ------------------------------------------------------------------ */
/* 账号的收集与回填                                                     */
/* ------------------------------------------------------------------ */

/** magpie 数据根下的四个文件（备份只管账号，不碰供应商与插件声明）。 */
const ACCOUNTS_FILE = 'plugin-auth.json';
const LOGINS_FILE = 'logins.json';
const PLUGINS_FILE = 'plugins.json';

async function readJson(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch (e) {
        if (e?.code === 'ENOENT')
            return undefined;
        throw e;
    }
}

/** 原子落盘：先写临时文件再改名，断电不会留下半个 JSON。 */
async function writeJson(file, value) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
}

/**
 * 收集要带走的账号。
 *
 * 只取三样东西，正好是「换一台设备还能继续用」的最小集：
 *   - `signIns.plugins` ← `plugin-auth.json`（各平台账号的凭据）
 *   - `signIns.logins`  ← `logins.json`（订阅类账号：Codex、Claude Code 等）
 *   - `hubPlugins`      ← `plugins.json`（要装哪些插件包；概念只在
 *                        dsh-magpie-hub 里有，magpie 读到会忽略）
 *
 * **故意不带** `plugin-providers.json`：那是插件的声明缓存，重装插件就会
 * 自动重建；带着它反而可能把旧版本的平台声明灌进新机器。也不带
 * `providers.json`（用户自己配的供应商）—— 账号与供应商是两件事。
 *
 * `providers: []` 是必须给的空数组：Go 的 `Bundle.Providers` 不是指针，
 * 少这个键与给空数组在 `Restore` 里都是「不动」，但给全了更像一份完整的
 * 备份，别的工具读起来不会当成截断的文件。
 *
 * @param {string} root magpie 数据根（`~/.config/magpie`）
 * @param {{app?: string}} [options]
 * @returns {Promise<object>} 可交给 `seal` 的 bundle
 */
export async function collectAccounts(root, options = {}) {
    const auth = await readJson(join(root, ACCOUNTS_FILE));
    const logins = await readJson(join(root, LOGINS_FILE));
    const plugins = await readJson(join(root, PLUGINS_FILE));
    const signIns = {};
    if (auth !== null && typeof auth === 'object' && !Array.isArray(auth) && Object.keys(auth).length > 0)
        signIns.plugins = auth;
    if (Array.isArray(logins) && logins.length > 0)
        signIns.logins = logins;
    const bundle = {
        version: BUNDLE_VERSION,
        created: new Date().toISOString(),
        app: typeof options.app === 'string' && options.app !== '' ? options.app : 'dsh-magpie-hub',
        // 账号就是凭据本身，所以这里的策略位永远是 true：不写 true 的话
        // magpie 那边会以为这是「备份时不带密钥」的那一种。
        keys: true,
        providers: [],
    };
    if (Object.keys(signIns).length > 0)
        bundle.signIns = signIns;
    // 我们的插件清单挂在自定义键上。Go 的 `json.Unmarshal` 忽略未知字段，
    // 所以 magpie 导入同一份文件不会报错，只是用不上这一项。
    if (Array.isArray(plugins?.plugins) && plugins.plugins.length > 0)
        bundle.hubPlugins = { plugins: plugins.plugins };
    return bundle;
}

/** 这次导入做了什么，面板上要据此说一句话。 */
export function describeApply(summary) {
    const parts = [];
    if (summary.accounts > 0)
        parts.push(`${summary.accounts} 个账号`);
    if (summary.logins > 0)
        parts.push(`${summary.logins} 个订阅账号`);
    if (summary.plugins > 0)
        parts.push(`${summary.plugins} 个插件`);
    return parts.join('、');
}

/**
 * 把 bundle 里的账号写进本机。
 *
 * 合并策略是「本机没有就加，本机有就按导入的覆盖」——单向的「桌面 → 手机」
 * 场景里这是用户期望的结果（手机上本来就该和电脑上一样）。与 magpie 的
 * `Restore` 不同，这里不做「谁更新」的比较：手机端没有刷新令牌的时间戳
 * 可比，猜错反而会把能用的凭据换掉。
 *
 * @param {string} root magpie 数据根
 * @param {object} bundle `open` 出来的内容
 * @param {{install?: (spec: string) => Promise<unknown>}} [options]
 *        `install` 给了就顺手把缺的插件包装上
 * @returns {Promise<{accounts: number, logins: number, plugins: number, missing: string[]}>}
 */
export async function applyAccounts(root, bundle, options = {}) {
    const signIns = bundle?.signIns !== null && typeof bundle?.signIns === 'object' ? bundle.signIns : {};
    const summary = { accounts: 0, logins: 0, plugins: 0, missing: [] };
    // 平台账号：按 key 合并，导入的覆盖本机同 key 的。
    const incomingAuth = signIns.plugins;
    if (incomingAuth !== null && typeof incomingAuth === 'object' && !Array.isArray(incomingAuth)) {
        const current = await readJson(join(root, ACCOUNTS_FILE));
        const merged = current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
        for (const [key, value] of Object.entries(incomingAuth)) {
            if (value === null || typeof value !== 'object')
                continue;
            merged[key] = value;
            summary.accounts += 1;
        }
        if (summary.accounts > 0)
            await writeJson(join(root, ACCOUNTS_FILE), merged);
    }
    // 订阅账号：按「agent + 账号标识」去重后追加。`logins.json` 里每条都有
    // 自己的 `id`，但不同机器上同一个账号的 id 可能不同，所以按内容判重。
    const incomingLogins = signIns.logins;
    if (Array.isArray(incomingLogins) && incomingLogins.length > 0) {
        const current = await readJson(join(root, LOGINS_FILE));
        const list = Array.isArray(current) ? current.slice() : [];
        const seen = new Set(list.map(loginKey));
        for (const item of incomingLogins) {
            if (item === null || typeof item !== 'object')
                continue;
            const key = loginKey(item);
            if (seen.has(key))
                continue;
            seen.add(key);
            list.push(item);
            summary.logins += 1;
        }
        if (summary.logins > 0)
            await writeJson(join(root, LOGINS_FILE), list);
    }
    // 插件清单：缺的补上，并（可选）立刻装包 —— 不装包的话平台还是不会出现。
    // `plugins: false` 时整段跳过：手机只想要账号，而它那个目录里没有这些包，
    // 写进 plugins.json 只会让每次启动都报「装载失败」。
    const incomingPlugins = options.plugins === false
        ? []
        : Array.isArray(bundle?.hubPlugins?.plugins)
            ? bundle.hubPlugins.plugins
            : [];
    if (incomingPlugins.length > 0) {
        const current = await readJson(join(root, PLUGINS_FILE));
        const list = Array.isArray(current?.plugins) ? current.plugins.slice() : [];
        const bySpec = new Map(list.map(item => [typeof item?.spec === 'string' ? item.spec : '', item]));
        const added = [];
        for (const item of incomingPlugins) {
            const spec = typeof item?.spec === 'string' ? item.spec : '';
            if (spec === '')
                continue;
            if (bySpec.has(spec))
                continue;
            list.push(item);
            bySpec.set(spec, item);
            added.push(item);
            summary.plugins += 1;
        }
        if (summary.plugins > 0)
            await writeJson(join(root, PLUGINS_FILE), { ...(current ?? {}), plugins: list });
        if (typeof options.install === 'function') {
            for (const item of added) {
                try {
                    await options.install(item.spec);
                }
                catch {
                    // 装不上不算导入失败：账号已经落地，插件可以回头在商店里点。
                    summary.missing.push(item.spec);
                }
            }
        }
        else {
            summary.missing = added.map(item => item.spec);
        }
    }
    return summary;
}

/** `logins.json` 里一条账号的判重键：agent + 邮箱/用户名。 */
function loginKey(item) {
    const agent = typeof item?.agent === 'string' ? item.agent : '';
    const who = typeof item?.user === 'string' ? item.user
        : typeof item?.email === 'string' ? item.email
            : typeof item?.name === 'string' ? item.name
                : typeof item?.id === 'string' ? item.id : '';
    return `${agent}|${who.toLowerCase()}`;
}

/** 读一个备份文件并解开（面板的导入入口用）。 */
export async function openFile(file, pass) {
    return open(await readFile(file), pass);
}
