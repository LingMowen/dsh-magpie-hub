/**
 * 查真实账号的「订阅」信息：契约里对应 `auth.usage` 的
 * `plan`（套餐）/ `until`（到期）/ `renew`（自动续费）/ `resets`（重置规则）。
 *
 * 运行：node test/real-subscription.mjs
 * 不依赖 @deepseek-ai/*（只用宿主与存储层），所以能在工程目录直接跑。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { MagpieHost } from '../src/host.js';
import { loadAll } from '../src/runtime.js';
import { AuthStore, PluginStore, hostPaths } from '../src/store.js';

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

const pluginContext = {
  client: {
    auth: { async set() {}, async remove() {} },
    app: { log() {} },
    tui: { showToast() {} },
    config: { async get() { return {}; } },
  },
  directory: root,
  worktree: root,
  project: { id: 'dsh-magpie-hub', worktree: root },
  magpie: { option: () => undefined },
};

const plugins = new PluginStore(paths);
// ⚠ AuthStore 收的是**整个 paths**（内部自己取 paths.auth），不是 paths.auth。
const auth = new AuthStore(paths);
const host = new MagpieHost(paths, auth);

const result = await loadAll(await plugins.list(), paths, pluginContext);
await host.assemble(result.loaded, result.failed);
console.log(`装载：${result.loaded.length} 个插件，provider ${host.providerIds().length} 个\n`);

let withUsage = 0;
for (const id of host.providerIds()) {
  const keys = await host.accountKeys(id);
  if (keys.length === 0) continue;
  if (!host.declares(id, 'usage')) {
    console.log(`■ ${id}（${keys.length} 账号，未声明 usage 钩子）`);
    continue;
  }
  for (const key of keys) {
    const usage = await host.usageOf(id, key);
    if (usage === undefined) continue;
    withUsage += 1;
    console.log(`■ ${id} · ${key}`);
    console.log(`    plan   = ${JSON.stringify(usage.plan)}`);
    console.log(`    user   = ${JSON.stringify(usage.user)}`);
    console.log(`    until  = ${JSON.stringify(usage.until)}`);
    console.log(`    renew  = ${JSON.stringify(usage.renew)}`);
    console.log(`    balance= ${JSON.stringify(usage.balance)}`);
    console.log(`    resets = ${JSON.stringify(usage.resets)}`);
    console.log(`    error  = ${JSON.stringify(usage.error)}`);
    const windows = Array.isArray(usage.windows) ? usage.windows : [];
    console.log(`    windows= ${windows.length} 个`);
    for (const w of windows.slice(0, 6)) {
      console.log(`      · ${w.name}: used=${w.used} display=${JSON.stringify(w.display)} resetsAt=${JSON.stringify(w.resetsAt)} aside=${w.aside ?? false}`);
    }
  }
}
console.log(`\n有订阅/额度数据的账号：${withUsage} 个`);
process.exit(0);
