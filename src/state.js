/**
 * 面板上的「策略」状态：模型开关、供应商启停、隐藏账号、账号别名、路由规则。
 *
 * 这些**不是** magpie 的插件数据，而是本插件自己的用户选择，所以统一存在
 * `<数据根>/hub-settings.json` 里（与 magpie 的 settings.json 分开，互不干扰）。
 *
 * 为什么单开一层而不是散在各处：
 * - 适配器（`listModels`）要按它过滤模型；
 * - 快照（面板）要按它决定显示什么；
 * - RPC 与手机动作要改它。
 * 三处读同一份状态，否则「面板能开关模型、路由里却还在用」这类不一致必然出现。
 *
 * 存储形状（都是纯 JSON，能跨进程安全读写）：
 * ```json
 * {
 *   "disabledModels": ["wps-lingxi/GLM-5.3"],
 *   "offProviders":   ["catpaw"],
 *   "hiddenAccounts": ["wps-lingxi#example-account"],
 *   "accountAliases": { "wps-lingxi#example-account": "工作号" },
 *   "routeStrategy":  "first" | "fastest" | "cheapest",
 *   "routeGroups":    { "deepseek-v4-pro": ["wps-lingxi/deepseek-v4-pro-0813"] }
 * }
 * ```
 */
import { SettingsStore } from './store.js';

/** 模型键：`<provider>/<model>`。 */
export function modelKey(provider, model) {
    return `${provider}/${model}`;
}

export class PolicyStore {
    settings;
    cache;

    constructor(paths) {
        this.settings = new SettingsStore(paths);
    }

    async load() {
        if (this.cache !== undefined)
            return this.cache;
        const all = await this.settings.all();
        this.cache = {
            disabledModels: asSet(all.disabledModels),
            offProviders: asSet(all.offProviders),
            hiddenAccounts: asSet(all.hiddenAccounts),
            accountAliases: asRecord(all.accountAliases),
            accountModels: asGroups(all.accountModels),
            routeStrategy: typeof all.routeStrategy === 'string' ? all.routeStrategy : 'first',
            routeGroups: asGroups(all.routeGroups),
        };
        return this.cache;
    }

    /**
     * 同步读缓存（可能还没 `load()` 过 → 给空值）。
     *
     * 用途：高频、且**不能 await** 的渲染路径（比如给 48 个供应商算模型开关）。
     * 调用方必须能接受「第一次可能为空」。
     */
    cached() {
        return this.cache ?? {
            disabledModels: new Set(),
            offProviders: new Set(),
            hiddenAccounts: new Set(),
            accountAliases: {},
            accountModels: {},
            routeStrategy: 'first',
            routeGroups: {},
        };
    }

    /** 一次性拿到全部状态（快照与适配器都读它）。 */
    async get() {
        return this.load();
    }

    // ── 模型 ────────────────────────────────────────────────────────────────
    /** 这个模型被禁用了没。 */
    async isModelDisabled(provider, model) {
        return (await this.load()).disabledModels.has(modelKey(provider, model));
    }

    /** 启停一个模型。`off = true` 表示禁用。 */
    async setModelDisabled(provider, model, off) {
        const key = modelKey(provider, model);
        return this.#toggle('disabledModels', key, off);
    }

    /** 批量：`models` 是 `[{provider, model}]`，或 `provider` 前缀下的全部。 */
    async setModelsDisabled(entries, off) {
        const state = await this.load();
        const next = new Set(state.disabledModels);
        for (const { provider, model } of entries) {
            const key = modelKey(provider, model);
            if (off)
                next.add(key);
            else
                next.delete(key);
        }
        return this.#commit('disabledModels', [...next]);
    }

    /**
     * 把某个 provider 下的**指定**模型批量启停。
     *
     * 必须显式传 `models`：这里不查目录。查目录要走宿主钩子（可能是网络），
     * 放在状态层会让「切一个开关」变成一次网络请求；而且目录随时会变，
     * 拿旧目录算出来的「全部」会漏掉新加的模型。
     */
    async setProviderModels(provider, models, off) {
        const list = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m !== '') : [];
        if (list.length === 0)
            return (await this.load()).disabledModels.size;
        await this.setModelsDisabled(list.map((model) => ({ provider, model })), off);
        return (await this.load()).disabledModels.size;
    }

    // ── 供应商 ──────────────────────────────────────────────────────────────
    async isProviderOff(provider) {
        return (await this.load()).offProviders.has(provider);
    }

    async setProviderOff(provider, off) {
        return this.#toggle('offProviders', provider, off);
    }

    // ── 账号 ────────────────────────────────────────────────────────────────
    async isAccountHidden(key) {
        return (await this.load()).hiddenAccounts.has(key);
    }

    async setAccountHidden(key, hidden) {
        return this.#toggle('hiddenAccounts', key, hidden);
    }

    /** 账号显示名（别名优先；没有就返回 undefined，由调用方回退到真实名字）。 */
    async aliasOf(key) {
        const alias = (await this.load()).accountAliases[key];
        return typeof alias === 'string' && alias !== '' ? alias : undefined;
    }

    async setAccountAlias(key, name) {
        const state = await this.load();
        const next = { ...state.accountAliases };
        const trimmed = typeof name === 'string' ? name.trim() : '';
        // 空名字 = 删掉别名（回到真实名字），不留空串
        if (trimmed === '')
            delete next[key];
        else
            next[key] = trimmed.slice(0, 60);
        return this.#commit('accountAliases', next);
    }

    /**
     * 这个账号可以用哪些模型（`undefined` = 不限，全部可用）。
     *
     * 用途：一个供应商登录了多个账号、套餐不同。让某个账号只跑它套餐里的模型，
     * 取号时就会跳过它，而不是「取到了再被上游 403」。
     */
    async modelsOfAccount(key) {
        const list = (await this.load()).accountModels[key];
        return Array.isArray(list) && list.length > 0 ? list : undefined;
    }

    /** 设置账号的可用模型清单（`[]` = 取消限制，回到「全部可用」）。 */
    async setAccountModels(key, models) {
        const state = await this.load();
        const next = { ...state.accountModels };
        const list = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m !== '').slice(0, 200) : [];
        if (list.length === 0)
            delete next[key];
        else
            next[key] = list;
        return this.#commit('accountModels', next);
    }

    // ── 路由 ────────────────────────────────────────────────────────────────
    async strategy() {
        return (await this.load()).routeStrategy;
    }

    /** 只接受三种策略；别的值保持原样不动（不猜用户意思）。 */
    async setStrategy(strategy) {
        if (strategy !== 'first' && strategy !== 'fastest' && strategy !== 'cheapest') {
            return (await this.load()).routeStrategy;
        }
        await this.#commit('routeStrategy', strategy);
        return strategy;
    }

    async groups() {
        return (await this.load()).routeGroups;
    }

    /** 覆盖某个聚合键的候选列表（`[]` = 清掉这组）。 */
    async setGroup(key, candidates) {
        const state = await this.load();
        const next = { ...state.routeGroups };
        const list = Array.isArray(candidates)
            ? candidates.filter((x) => typeof x === 'string' && x !== '').slice(0, 32)
            : [];
        if (list.length === 0)
            delete next[key];
        else
            next[key] = list;
        return this.#commit('routeGroups', next);
    }

    // ── 内部 ────────────────────────────────────────────────────────────────
    async #toggle(field, value, on) {
        const state = await this.load();
        const set = new Set(state[field]);
        if (on)
            set.add(value);
        else
            set.delete(value);
        return this.#commit(field, [...set]);
    }

    /** 写盘并同步内存（写失败就抛，别让内存与磁盘悄悄分叉）。 */
    async #commit(field, value) {
        const state = await this.load();
        // 内存里三个字段是 Set，其余是原样（对象 / 字符串）。
        // 显式按字段名映射，不靠「是不是数组」去猜类型——猜错会让缓存与
        // 磁盘分叉，而读侧只会安静地少一个开关。
        const next = { ...state };
        if (SET_FIELDS.has(field)) {
            next[field] = new Set(Array.isArray(value) ? value : []);
        }
        else {
            next[field] = value;
        }
        await this.settings.set(field, value);
        this.cache = next;
        return value;
    }
}

/** 内存里用 Set 存的字段（其余字段保持磁盘上的形状）。 */
const SET_FIELDS = new Set(['disabledModels', 'offProviders', 'hiddenAccounts']);

const asSet = (value) => new Set(Array.isArray(value) ? value.filter((x) => typeof x === 'string') : []);
const asRecord = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {});
/** 路由分组：`{ 聚合键: [候选…] }`，值必须是字符串数组。 */
function asGroups(value) {
    const out = {};
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return out;
    for (const [key, list] of Object.entries(value)) {
        if (Array.isArray(list))
            out[key] = list.filter((x) => typeof x === 'string');
    }
    return out;
}
