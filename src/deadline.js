/**
 * 「等一下，但最多等这么久」—— 给可选数据加硬上限。
 *
 * 为什么需要：模型选择器是**串行读全部平台**的，任何一个平台的目录请求卡住，
 * 整页就停在「更新中」且不可点（`dsh-Go/app/lib/state/models_state.dart:59-67`）。
 * 目录是装饰，能先选模型比列表更全重要，所以超时就用静态表。
 *
 * 单独成文件是为了能被单测覆盖：`adapter.js` 要 import `@deepseek-ai/dsh-llm`，
 * 而工程目录里没有这份依赖（它只在 profile 的 node_modules 下）。
 */

/** 单个平台目录的等待上限（毫秒）。正常平台几百毫秒，4 秒是给慢网留的余量。 */
export const CATALOG_TIMEOUT_MS = 4_000;

/**
 * `promise` 在 `ms` 内没有结果就用 `fallback`。
 *
 * ⚠ 迟到的结果直接丢弃，且要清掉定时器 —— 否则一个已决的 Promise 会留下
 * 一个空的 `setTimeout`，在手机端常年运行的面板里累计成定时器泄漏。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export function withDeadline(promise, ms, fallback) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            resolve(fallback);
        }, ms);
        promise.then((value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(fallback);
        });
    });
}
