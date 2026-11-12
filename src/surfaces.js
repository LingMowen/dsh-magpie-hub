/**
 * 按 locale 二选一。
 *
 * 抽成独立模块后不能再用 `index.js` 的 `text()`（同一文件里互相 import 会循环），
 * 所以这里留一份最简实现。
 */
function text(locale, zh, en) {
    return typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? zh : en;
}

/**
 * 状态条（`composer.strip`）与回合脚注（`turn.note`）的文案。
 *
 * 单独成文件的理由和 `deadline.js` 一样：`index.js` 会连带 import
 * `adapter.js`，而后者要 `@deepseek-ai/dsh-llm`（只有 profile 的
 * node_modules 里才有），测试环境 import 不了。这里是纯函数，可独立测。
 *
 * 字数上限是硬的：脚注每段 16 字、状态条 24 字，超了桥接直接截断
 * （`kit-lib-bridge-limits.js` 的 `textChars.turnNote` / `stripText`）。
 */

/**
 * 平台名的短名（状态条一行只给 24 字，全名放不下）。
 *
 * 规则：按空格切段，取第一段**含中文**的（`WPS 灵犀 Lingxi` → `灵犀`）；
 * 一段中文都没有就取第一段（`CodeArts` → `CodeArts`）；仍超 6 字就截断。
 */
export function shortProviderName(snapshot, providerId) {
    const rows = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
    const hit = rows.find((p) => p?.id === providerId);
    const name = typeof hit?.name === 'string' && hit.name !== '' ? hit.name : String(providerId ?? '');
    const parts = name.split(' ').filter((p) => p !== '');
    const zh = parts.find((p) => /[一-鿿]/.test(p));
    const short = zh ?? parts[0] ?? name;
    // 中文短名控在 6 字（一行只有 24 字）；英文名本来就短，硬截会截出
    // 「CodeAr」这种半截词，所以放宽到 10 字。
    const cap = /[一-鿿]/.test(short) ? 6 : 10;
    return [...short].slice(0, cap).join('');
}

/** 数字压成「1.2万」「3.4亿」，放得进一行。 */
export function compactAmount(value) {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (n >= 1e8)
        return `${(n / 1e8).toFixed(1)}亿`;
    if (n >= 1e4)
        return `${Math.round(n / 1e4)}万`;
    // 千分位自己写：`groupDigits` 在 `panel.js` 里，index 侧拿不到
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 状态条上要显示哪个平台。
 *
 * 取「最近一次调用用的平台」—— 那就是实际在干活的那个（用户切了模型以后
 * 下一次调用就会反映过来）。还没调用过就给第一个有账号的平台。
 * DSH 没有向插件暴露「当前选中模型」的服务，所以不装作知道。
 */
export function currentProviderId(snapshot, rows) {
    const ledger = Array.isArray(rows) ? rows : [];
    for (let i = ledger.length - 1; i >= 0; i -= 1) {
        const row = ledger[i];
        if (typeof row?.provider === 'string' && row.provider !== '')
            return row.provider;
    }
    const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
    const first = providers.find((p) => Array.isArray(p.accounts) && p.accounts.length > 0);
    return typeof first?.id === 'string' ? first.id : '';
}

/**
 * 回合脚注：`平台 · 用量`。
 *
 * 每段只有 16 字（`kit-lib-bridge-util.js` 的 `textChars.turnNote`），所以平台
 * 用短名、数字用压缩写法。没有 token 统计时写耗时 —— 总比空着强。
 */
/** `12K` / `1.2M`：纯 ASCII，宽度只有中文的一半，脚注才放得下。 */
export function asciiTokens(tokens) {
    if (tokens >= 1_000_000)
        return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
    if (tokens >= 1_000)
        return `${Math.round(tokens / 1_000)}K`;
    return String(tokens);
}

export function noteLine(row, snapshot) {
    // 只写本次消耗，不重复平台名：状态条（`composer.strip`）一直显示着当前平台与
    // 剩余额度，脚注再写一遍会把整行挤到放不下 —— 而 App 的降级链是「放不下就
    // 整条丢掉 note」（`turn_footnote.dart` 的 `variants`），结果就是脚注永远不出现。
    if (row?.status === 'error')
        return '失败';
    const tokens = typeof row?.tokens === 'number' && row.tokens > 0 ? row.tokens : undefined;
    if (tokens !== undefined)
        return asciiTokens(tokens);
    const cost = typeof row?.cost === 'number' && row.cost > 0 ? row.cost : undefined;
    if (cost !== undefined)
        return `$${cost.toFixed(2)}`;
    const ms = typeof row?.ms === 'number' ? Math.round(row.ms) : undefined;
    return ms === undefined ? '' : `${ms}ms`;
}

/**
 * 额度状态条：`平台 · 剩 N`。
 *
 * 24 字上限（`kit-lib-bridge-limits.js` 的 `stripText`）。额度取该平台第一个
 * 带 `limit`+`amount` 的窗口算剩余；没有额度数据就只显示平台名。
 */
/**
 * 脚注的另一种写法：显示**这个平台当前的剩余额度**。
 *
 * 用户要的是「每次消耗的额度」，但桥接只把每次调用的 token 数交给我们，
 * 额度（`auth.usage` 的窗口）是按账号查的余额，扣减明细拿不到。所以这里给
 * 当前剩余 —— 与状态条同源，但只写数字、前缀 `q` 区分于 token 数。
 *
 * 与 `noteLine` 一样必须**纯 ASCII 且短**：`turn_footnote.dart` 的降级链在
 * 整行放不下时会把 note 整条丢掉，中文字符宽度更大、更容易被丢。
 */
export function noteQuota(row, snapshot) {
    if (row?.status === 'error')
        return 'fail';
    const rows = Array.isArray(snapshot?.usage) ? snapshot.usage : [];
    const mine = rows.filter((u) => u?.provider === row?.provider);
    for (const item of mine) {
        const win = (item.windows ?? []).find((w) => typeof w.limit === 'number' && w.limit > 0
            && typeof w.amount === 'number');
        if (win === undefined)
            continue;
        return `q${asciiTokens(Math.max(0, win.limit - win.amount))}`;
    }
    return '';
}
export function stripLine(snapshot, providerId, locale) {
    const who = shortProviderName(snapshot, providerId);
    const rows = Array.isArray(snapshot?.usage) ? snapshot.usage : [];
    const mine = rows.filter((u) => u?.provider === providerId);
    for (const item of mine) {
        const win = (item.windows ?? []).find((w) => typeof w.limit === 'number' && w.limit > 0
            && typeof w.amount === 'number');
        if (win === undefined)
            continue;
        const left = Math.max(0, win.limit - win.amount);
        return `${who} · ${text(locale, '剩', 'left')} ${compactAmount(left)}`;
    }
    return who === '' ? text(locale, '额度', 'Quota') : who;
}

