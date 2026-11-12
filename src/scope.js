/**
 * 账号作用域：magpie 的 `inScope(provider, key, fn)` 在 TS 里的对应物。
 *
 * 契约原文（host.js）：
 * > Everything a request does runs in its account's scope, so the plugin's
 * > getAuth, client.auth.set and loader see that account alone.
 *
 * 实现用 `AsyncLocalStorage`：作用域跟着 async 调用链走，不用模块变量按
 * provider 存状态（那是插件契约**明文禁止**的做法——同一 provider 多账号时
 * 会互相串号）。magpie 自己也是用 AsyncLocalStorage 做的（host.js 的
 * `via`/`reach`/`listing`/`signInSignal` 四个都是）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
const store = new AsyncLocalStorage();
/** 当前作用域（不在任何账号作用域里时为 undefined）。 */
export function currentScope() {
    return store.getStore();
}
/** 在某个账号的作用域里跑一段代码，并把它返回的 promise 一起纳进作用域。 */
export function runInScope(scope, fn) {
    return store.run(scope, fn);
}
/**
 * 取当前作用域的 login key。没有作用域时抛异常而不是静默用 provider
 * ——静默回退会让多账号场景下「B 账号的请求用了 A 账号的凭据」而不报错。
 */
export function requireScope(what) {
    const scope = store.getStore();
    if (scope === undefined) {
        throw new Error(`magpie-hub: ${what} 必须在账号作用域内调用（当前没有作用域）`);
    }
    return scope;
}
//# sourceMappingURL=scope.js.map