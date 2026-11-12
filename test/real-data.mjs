/**
 * 真实数据验证：数据根定位 + 从真实 magpie 数据目录装载供应商插件。
 *
 * 这是「本插件能否取代 magpie 桌面程序」的最小证据链：
 *   找到数据根 → 读 plugins.json → 解析 spec → 载入插件 → 得到 provider 与登录方式
 *
 * 运行：node test/real-data.mjs
 * 不依赖 @deepseek-ai/*（那只需要 DSH 运行时），所以能在工程目录直接跑。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadAll } from '../src/runtime.js';
import { hostPaths } from '../src/store.js';

/** 与 src/index.js 的 configRoot() 同一套回退链（那里不导出，这里复刻以做验证）。 */
function configRoot() {
  const home = process.env.DSH_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const user = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const xdg = process.env.XDG_CONFIG_HOME;
  const candidates = [
    process.env.MAGPIE_HUB_ROOT,
    xdg === undefined || xdg === '' ? undefined : join(xdg, 'magpie'),
    user === '' ? undefined : join(user, '.config', 'magpie'),
    join(home, 'magpie'),
    home,
    user === '' ? undefined : join(user, '.dsh', 'magpie'),
    user === '' ? undefined : join(user, '.dsh'),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue;
    for (const name of ['plugins.json', 'plugin-providers.json', 'plugin-auth.json']) {
      if (existsSync(join(candidate, name))) return candidate;
    }
  }
  return join(home, 'magpie');
}

const root = configRoot();
const paths = hostPaths(root);
console.log('数据根 =', root);
console.log('命中文件 =', ['plugins.json', 'plugin-providers.json', 'plugin-auth.json']
  .filter((n) => existsSync(join(root, n))).join(', ') || '(无)');
console.log('模块目录 =', paths.modules, existsSync(paths.modules) ? '(存在)' : '(不存在)');

/** 真实 plugins.json 的条目（`{spec, enabled?, options?}`）。 */
function installedOf(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.plugins;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const installed = installedOf(paths.plugins);
console.log(`plugins.json = ${installed.length} 条`);

/**
 * magpie 插件拿到的上下文。
 *
 * 真实宿主由 `src/index.js` 的 `pluginContext` 提供（含 `client.auth.set` 等真实现）。
 * 这里只做**装载验证**，所以给一个最小退化版：插件工厂会解构 `input.client`，
 * 传 `null` 会直接抛 `Cannot destructure property 'client' of 'input' as it is null`
 * ——那是测试自己的问题，不是插件的问题。
 */
const pluginContext = {
  client: {
    auth: {
      async set() {},
      async remove() {},
    },
    app: { log() {} },
    tui: { showToast() {} },
    config: { async get() { return {}; } },
  },
  directory: root,
  worktree: root,
  project: { id: 'dsh-magpie-hub', worktree: root },
  magpie: { option: () => undefined },
};

const result = await loadAll(installed, paths, pluginContext);
console.log(`装载结果：loaded=${result.loaded.length} failed=${result.failed.length}`);

const providerRows = [];
for (const plugin of result.loaded) {
  const hooks = plugin.hooks ?? {};
  const providers = plugin.providers ?? [];
  const methods = Array.isArray(hooks.auth?.methods) ? hooks.auth.methods : [];
  console.log(`  插件 ${plugin.spec}`);
  console.log(`    providers = ${JSON.stringify(providers)}`);
  console.log(`    hooks = ${Object.keys(hooks).join(', ') || '(无)'}`);
  for (const m of methods) console.log(`    登录方式：${m.type} · ${m.label}`);
  for (const id of providers) providerRows.push(id);
}
for (const failure of result.failed) {
  console.log(`  失败 ${failure.spec}: ${failure.error}`);
}

console.log(`\n可用 provider 共 ${providerRows.length} 个：${providerRows.join(', ')}`);
process.exit(result.loaded.length > 0 ? 0 : 1);
