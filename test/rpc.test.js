/**
 * RPC 层测试：直接调 `registerInScope`，用一个假的 `connection` 捕获处理器，
 * 再自己构造请求信封喂进去。
 *
 * 为什么不用真 HTTP：真实例要起 48 个插件、还会被端口/资源问题干扰；
 * 这层的正确性（信封校验、方法路由、参数校验）与网络无关，直接测更准也更快。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerInScope, MAGPIE_HUB_ENDPOINT } from '../src/rpc.js';
import { PolicyStore } from '../src/state.js';
import { hostPaths } from '../src/store.js';

/** 造一个能捕获路由的假 connection。 */
function fakeConnection() {
  let captured;
  return {
    get captured() { return captured; },
    connection: {
      fetch: {
        register(route) { captured = route; return () => { captured = undefined } },
      },
    },
  };
}

/** 假宿主：只要 RPC 用到的那几个方法。 */
function fakeDeps(dir, overrides = {}) {
  const policy = new PolicyStore(hostPaths(dir));
  const providerIds = ['p1']
  const deps = {
    host: {
      providerIds: () => providerIds,
      providerConfig: () => ({ name: '测试平台', models: { 'm-a': {}, 'm-b': {} } }),
      accountKeys: async () => ['p1#1'],
      ensureFresh: async () => ({ access: 'x' }),
      declares: () => false,
      usageOf: async () => ({ plan: 'Pro', windows: [{ name: 'w', used: 30 }] }),
      modelsOf: async () => ({ 'm-a': {}, 'm-b': {} }),
      accountKeysOf: async () => ['p1#1'],
      loaded: [{}],
      loadFailures: [],
    },
    auth: { remove: async () => {} },
    policy,
    adapter: {
      catalogRows: async (p) => [{ id: 'm-a', disabled: false }, { id: 'm-b', disabled: true }],
      invalidateCatalog: () => {},
    },
    plugins: { list: async () => [{ spec: '@magpie-community/opencode-x-auth@latest' }] },
    moduleNameOf: (s) => s.replace(/@latest$/, ''),
    modulesDir: join(dir, 'plugins', 'node_modules'),
    snapshot: async () => ({ providers: [] }),
    reload: async () => ({ loaded: 1, failed: 0 }),
    setPeriod: async () => {},
    period: () => 'today',
    summary: () => '',
    marketListings: async () => [],
    marketInstall: async () => ({ ok: true }),
    marketUninstall: async () => {},
    checkin: async () => ({ claimed: 0 }),
    checkinSchedule: async (enabled) => ({ enabled: enabled === true, nextAt: 0 }),
    clearQuota: () => {},
    log: () => {},
    entry: async () => 'sidebar',
    setEntry: async () => {},
    ...overrides,
  }
  return deps
}

/** 按真实信封格式构造请求。 */
function request(method, payload) {
  return new Request('http://x/api/magpie-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'test-1',
      method: MAGPIE_HUB_ENDPOINT,
      payload: { method, payload },
    }),
  })
}

async function call(route, method, payload) {
  const res = await route.fetch(request(method, payload))
  const body = await res.json()
  return body.result ?? body
}

function setup(overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-'))
  const conn = fakeConnection()
  const deps = fakeDeps(dir, overrides)
  const stop = registerInScope(conn, deps)
  return { dir, conn, deps, stop }
}

test('信封必须完整：缺 method/type/payload 时拒绝', async () => {
  const { dir, conn, stop } = setup()
  try {
    // 缺 payload
    const bad = await conn.captured.fetch(new Request('http://x/api/magpie-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'a', method: MAGPIE_HUB_ENDPOINT }),
    }))
    const body = await bad.json()
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'bad-request')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('content-type 不是 json 时 415', async () => {
  const { dir, conn, stop } = setup()
  try {
    const res = await conn.captured.fetch(new Request('http://x/api/magpie-hub', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    assert.equal(res.status, 415)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('未知方法返回 unknown-method', async () => {
  const { dir, conn, stop } = setup()
  try {
    const r = await call(conn.captured, 'no.such.method', {})
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'unknown-method')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('model.toggle：禁用→true，恢复→false', async () => {
  const { dir, conn, stop, deps } = setup()
  try {
    const off = await call(conn.captured, 'model.toggle', { provider: 'p1', model: 'm-a', off: true })
    assert.equal(off.value.disabled, true)
    assert.equal(await deps.policy.isModelDisabled('p1', 'm-a'), true)

    const on = await call(conn.captured, 'model.toggle', { provider: 'p1', model: 'm-a', off: false })
    assert.equal(on.value.disabled, false)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('model.toggle：缺参数被拒', async () => {
  const { dir, conn, stop } = setup()
  try {
    const r = await call(conn.captured, 'model.toggle', { provider: 'p1' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'bad-request')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('model.setMany：批量禁用', async () => {
  const { dir, conn, stop, deps } = setup()
  try {
    const r = await call(conn.captured, 'model.setMany', { provider: 'p1', models: ['m-a', 'm-b'], off: true })
    assert.equal(r.value.count, 2)
    assert.equal(await deps.policy.isModelDisabled('p1', 'm-a'), true)
    assert.equal(await deps.policy.isModelDisabled('p1', 'm-b'), true)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('model.clearDead：清掉目录里已没有的禁用键，保留还存在的', async () => {
  const { dir, conn, stop, deps } = setup()
  try {
    await deps.policy.setModelDisabled('p1', 'm-a', true)   // 目录里还有
    await deps.policy.setModelDisabled('p1', 'gone', true)  // 目录里没了
    const r = await call(conn.captured, 'model.clearDead', {})
    assert.equal(r.value.cleared, 1)
    assert.equal(await deps.policy.isModelDisabled('p1', 'm-a'), true, '还存在的不能清')
    assert.equal(await deps.policy.isModelDisabled('p1', 'gone'), false, '失效的要清掉')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('provider.setOff：写入状态并触发重载', async () => {
  let reloaded = 0
  const { dir, conn, stop, deps } = setup({ reload: async () => { reloaded += 1; return { loaded: 1, failed: 0 } } })
  try {
    const r = await call(conn.captured, 'provider.setOff', { provider: 'p1', off: true })
    assert.equal(r.value.off, true)
    assert.equal(reloaded, 1, '停用后必须重载，否则路由表不变')
    assert.equal(await deps.policy.isProviderOff('p1'), true)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('account.rename / setHidden / setModels', async () => {
  const { dir, conn, stop, deps } = setup()
  try {
    const renamed = await call(conn.captured, 'account.rename', { key: 'p1#1', name: '工作号' })
    assert.equal(renamed.value.alias, '工作号')

    const hidden = await call(conn.captured, 'account.setHidden', { key: 'p1#1', hidden: true })
    assert.equal(hidden.value.hidden, true)
    assert.equal(await deps.policy.isAccountHidden('p1#1'), true)

    const models = await call(conn.captured, 'account.setModels', { key: 'p1#1', models: ['m-a'] })
    assert.deepEqual(models.value.models, ['m-a'])
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('route.strategy：只接受三种值', async () => {
  const { dir, conn, stop, deps } = setup()
  try {
    const ok = await call(conn.captured, 'route.strategy', { strategy: 'cheapest' })
    assert.equal(ok.value.strategy, 'cheapest')
    const bad = await call(conn.captured, 'route.strategy', { strategy: 'magic' })
    assert.equal(bad.ok, false)
    assert.equal(await deps.policy.strategy(), 'cheapest', '非法值不得改动状态')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('route.setGroup：设置与清空', async () => {
  const { dir, conn, stop } = setup()
  try {
    const set = await call(conn.captured, 'route.setGroup', { key: 'g', candidates: ['p1/m-a', 'p2/m-b'] })
    assert.deepEqual(set.value.candidates, ['p1/m-a', 'p2/m-b'])
    const clear = await call(conn.captured, 'route.setGroup', { key: 'g', candidates: [] })
    assert.deepEqual(clear.value.candidates, [])
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('account.retest：返回额度窗口数，失败也是结果', async () => {
  const { dir, conn, stop } = setup()
  try {
    const r = await call(conn.captured, 'account.retest', { provider: 'p1', key: 'p1#1' })
    assert.equal(r.ok, true)
    assert.equal(r.value.provider, 'p1')
    assert.equal(r.value.windows, 1)
    assert.equal(r.value.plan, 'Pro')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('account.resetQuota：调用清理钩子', async () => {
  const seen = []
  const { dir, conn, stop } = setup({ clearQuota: (p, k) => seen.push(`${p}#${k}`) })
  try {
    const r = await call(conn.captured, 'account.resetQuota', { provider: 'p1', key: 'p1#1' })
    assert.equal(r.ok, true)
    assert.deepEqual(seen, ['p1#p1#1'], '钩子应收到 provider 与 key')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('plugins.versions：本地路径 spec 不拼进 node_modules', async () => {
  const { dir, conn, stop } = setup({
    plugins: { list: async () => [{ spec: 'E:\\some\\local\\plugin' }, { spec: '@magpie-community/opencode-x-auth@latest' }] },
  })
  try {
    const r = await call(conn.captured, 'plugins.versions', {})
    assert.equal(r.value.total, 2)
    const local = r.value.plugins.find((p) => p.spec.startsWith('E:'))
    assert.equal(local.source, 'local', '绝对路径应标记为 local')
    const npm = r.value.plugins.find((p) => p.spec.startsWith('@magpie'))
    assert.equal(npm.source, 'npm')
    assert.equal(npm.name, '@magpie-community/opencode-x-auth', '应剥掉 @latest')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('catalog.rows：返回含禁用标记的目录', async () => {
  const { dir, conn, stop } = setup()
  try {
    const r = await call(conn.captured, 'catalog.rows', { provider: 'p1' })
    assert.equal(r.ok, true)
    assert.equal(r.value.rows.length, 2)
    assert.equal(r.value.rows[1].disabled, true)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('checkin.schedule：读写开关', async () => {
  const { dir, conn, stop } = setup()
  try {
    const on = await call(conn.captured, 'checkin.schedule', { enabled: true })
    assert.equal(on.value.enabled, true)
    const off = await call(conn.captured, 'checkin.schedule', { enabled: false })
    assert.equal(off.value.enabled, false)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})
