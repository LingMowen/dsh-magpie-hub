/**
 * Magpie 插件宿主 —— 类型定义（M1-M20 契约的 TS 面）。
 *
 * 依据：`tmp-magpie/scaffold/HOOKS.md`（1339 行字段级契约）+ 官方
 * https://usemagpie.ai/docs/zh/plugins + 参考实现
 * `tmp-magpie/community-plugins/packages/codearts/index.mjs`。
 *
 * ⚠️ 本文件是**只读契约的 TS 投影**：字段名与形状必须照抄 magpie，
 * 不改名、不省略。任何「顺手美化」都会让真插件静默少一块能力。
 */
/** OpenAI/Anthropic/Google SDK 包名 —— 决定 API 形状与 apiKey 头。 */
export const SDK_OPENAI_COMPATIBLE = '@ai-sdk/openai-compatible';
export const SDK_OPENAI = '@ai-sdk/openai';
export const SDK_ANTHROPIC = '@ai-sdk/anthropic';
export const SDK_GOOGLE = '@ai-sdk/google';
/** `sdkHeaders(npm, key)` 契约原文的四种分派。 */
export function sdkHeaders(npm, key) {
    if (key === undefined || key === '')
        return {};
    if (npm === SDK_ANTHROPIC || npm === '@ai-sdk/google-vertex/anthropic') {
        return { 'x-api-key': key };
    }
    if (npm === SDK_GOOGLE)
        return { 'x-goog-api-key': key };
    return { authorization: `Bearer ${key}` };
}
/** `whoOf`：账号名三级回退。 */
export function whoOf(auth) {
    if (auth === undefined)
        return '';
    if (typeof auth.accountId === 'string' && auth.accountId !== '')
        return auth.accountId;
    const email = auth.metadata?.['email'] ?? auth.email;
    return typeof email === 'string' ? email : '';
}
/** `hintOf`：API key 类型没有 accountId 时，显示 key 最后 4 位。 */
export function hintOf(auth) {
    if (auth === undefined || auth.type !== 'api')
        return '';
    const key = auth.key;
    return typeof key === 'string' && key.length >= 12 ? key.slice(-4) : '';
}
//# sourceMappingURL=types.js.map