/**
 * 插件目录的**热重载**。
 *
 * ## 解决什么
 *
 * 装/改/删一个 magpie 插件之后，原先必须重启 DSH 才会生效：宿主只在 `apply()`
 * 里扫一次目录，`node_modules` 变了它不知道。用户改一次插件代码就重启一次，
 * 一个下午能重启十几次。
 *
 * 这里做两件事：
 * 1. **监听** `<root>/node_modules` 与 `plugins.json`（装了/删了插件就写它）；
 * 2. 变化后**防抖重载**（默认 400ms）——`npm i` 会一连串写很多文件，
 *    逐个重载会把 CPU 打满。
 *
 * 配合 `runtime.ts` 的 `hotUrl()`（按 mtime 绕开 ESM 模块缓存），改完代码
 * 存盘即生效。
 *
 * ## 为什么不用 chokidar
 *
 * 不引入新依赖：`node:fs.watch` 的 `recursive` 在 Windows 与 macOS 上原生支持
 * （本项目的两个目标平台）。Linux 上 recursive 不可用 —— 那时退回「只监听
 * 顶层 + 靠手动重载按钮」，**不静默失败**：`onError` 会说明原因。
 *
 * ## 为什么监听 `node_modules` 而不是每个包目录
 *
 * 包目录会在运行时被整体替换（`npm i` 先写临时目录再 rename），盯住具体
 * 子目录的 watcher 会在替换后失效且不再触发 —— 那是「watch 还活着但不工作」
 * 的经典形态。盯父目录只会多几次事件，代价小得多。
 */
import { watch } from 'node:fs';
/**
 * 起一个热重载监听。
 *
 * @param options 见 {@link HotReloadOptions}
 * @returns 句柄；`stop()` 必须调（否则 `ctx.effect` 的清理不会收敛）
 */
export function installHotReload(options) {
    const { dir, file, reload, log, onError } = options;
    const debounceMs = typeof options.debounceMs === 'number' && options.debounceMs >= 0
        ? options.debounceMs
        : 400;
    const watchers = [];
    let timer;
    let stopped = false;
    /** 有重载在跑（同步闸门，见 `run` 里那段注释）。 */
    let busy = false;
    /** 跑完之后还要再来一次。 */
    let queued = false;
    /** 正在跑的这一次（`trigger()` 要能 await 到它）。 */
    let current;
    let reloads = 0;
    /**
     * 串行执行重载：`npm i` 期间可能连来多个事件，重载本身是异步的。
     *
     * ⚠️⚠️ **不能写成 `running = (async () => {...})()` 那种形状**（这里踩过一次，
     * 由 `tests/hotreload.spec.ts` 的「抛错后仍继续监听」用例抓住）：
     *
     * `reload` **同步抛出**时（配置错、路径不存在），async 函数体会在同一 tick 里
     * 走完 catch 与 finally —— 于是 `finally` 里的 `running = undefined` 先执行，
     * 之后外层那句赋值才把 `running` 设成一个**已经 resolve 的 Promise**。此后
     * 每次 `run()` 都看到 `running !== undefined`、以为「正在重载」，只置一个
     * pending 就返回 —— **监听器从此永久失效，而且一个字都不报**。
     *
     * 所以改用「先同步置位、finally 清除」的布尔闸门（`busy`），排队在循环里消化，
     * 不递归。
     */
    const run = async () => {
        if (stopped)
            return;
        if (busy) {
            // 正在重载：记一个「完事再来一次」，不要并行起第二份
            queued = true;
            return current;
        }
        busy = true;
        const task = (async () => {
            do {
                queued = false;
                try {
                    await reload();
                    reloads += 1;
                }
                catch (e) {
                    // 重载失败不该杀掉监听：下一次文件变化还要能触发
                    onError?.(`重载失败：${e instanceof Error ? e.message : String(e)}`);
                }
                if (stopped)
                    break;
            } while (queued);
        })();
        current = task;
        try {
            await task;
        }
        finally {
            busy = false;
            current = undefined;
        }
    };
    const schedule = () => {
        if (stopped)
            return;
        if (timer !== undefined)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            void run();
        }, debounceMs);
        timer.unref?.();
    };
    const listen = (target, recursive) => {
        try {
            const watcher = watch(target, { recursive, persistent: false }, () => { schedule(); });
            // 有的平台在目录消失后 emit error；吞掉即可（下一次 install 会重建）
            watcher.on('error', (e) => { log?.(`watch 出错（${target}）：${e.message}`); });
            watchers.push(watcher);
        }
        catch (e) {
            onError?.(`无法监听 ${target}：${e instanceof Error ? e.message : String(e)}`);
        }
    };
    listen(dir, true);
    if (typeof file === 'string' && file !== '')
        listen(file, false);
    return {
        stop() {
            stopped = true;
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            for (const watcher of watchers.splice(0)) {
                try {
                    watcher.close();
                }
                catch {
                    // 已关闭
                }
            }
        },
        trigger: () => run(),
        get reloads() {
            return reloads;
        },
    };
}
//# sourceMappingURL=hotreload.js.map