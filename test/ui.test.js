/**
 * UI 托管测试：用假的 `webServer` 捕获前缀路由，直接喂 Node 的 req/res 假对象。
 *
 * 验的是三件事：
 *   1. `/magpie-hub/` 能出 index.html（整条路的前提）
 *   2. 静态资源带正确的 content-type（否则浏览器不执行 app.js）
 *   3. `/magpie-hub/api/*` 走处理器；未实现的回 501 且说明缺哪个
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { mount, MOUNT } from '../src/ui.js';
import { makeUiHandlers } from '../src/ui-api.js';
import { PolicyStore } from '../src/state.js';
import { hostPaths } from '../src/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 假 res：收集 status / headers / body。 */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(code, headers) { res.statusCode = code; Object.assign(res.headers, headers ?? {}) },
    end(chunk) {
      if (chunk === undefined) { res.body = Buffer.alloc(0); return }
      res.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    },
  };
  return res;
}

/** 假 req：够用即可（method/url/异步迭代）。 */
function fakeReq(url, method = 'GET', body) {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  return stream;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ui-'))
  const policy = new PolicyStore(hostPaths(dir))
  let captured
  let routes
  const scoped = {
    webServer: {
      // 现在会注册 3 条：prefix + 两条 exact（`/magpie-hub`、`/magpie-hub/`）
      register(route) { (routes ||= []).push(route); captured = route; return () => {} },
    },
  }
  const deps = {
    root: dir,
    host: {
      providerIds: () => ['p1'],
      providerConfig: () => ({ name: '测试平台', models: { 'm-a': {}, 'm-b': {} } }),
      accountKeys: async () => ['p1#1'],
      ensureFresh: async () => ({ accountId: 'acc1' }),
      declares: () => true,
    },
    policy,
    adapter: { catalogRows: async () => [] },
    auth: {},
    plugins: { list: async () => [] },
    snapshot: async () => ({
      providers: [{ id: 'p1', name: '测试平台', accounts: [{ key: 'p1#1', accountId: 'acc1' }], models: 3, hasUsage: true, off: false }],
      usage: [],
      stats: { period: 'today', tokens: 0, calls: 0, errors: 0, cost: 0, unpriced: 0, series: [], byProvider: [] },
      routing: [],
      store: [],
    }),
    reload: async () => {}, refresh: async () => {},
    market: {},
    log: () => {},
  }
  const stop = mount(scoped, { handlers: makeUiHandlers(deps), log: () => {} })
  return { dir, scoped, getRoute: () => captured, getRoutes: () => routes ?? [], stop }
}

async function get(route, url, method = 'GET', body) {
  const res = fakeRes()
  await route.handler(fakeReq(url, method, body), res)
  return res
}

test('挂载了前缀路由 + 两条根 exact 路由', () => {
  const { getRoutes, dir, stop } = setup()
  try {
    const list = getRoutes()
    assert.equal(list.length, 3, '应为 prefix + 两条 exact')
    const prefix = list.find((r) => r.kind === 'prefix')
    assert.ok(prefix, '应有 prefix 路由')
    assert.equal(prefix.path, MOUNT)
    // ⚠ 关键：裸根路径实测不落 prefix，必须另有 exact
    const exacts = list.filter((r) => r.kind === 'exact').map((r) => r.path)
    assert.deepEqual(exacts.sort(), [MOUNT, `${MOUNT}/`].sort())
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('/magpie-hub/ 返回 index.html', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/`)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/html/)
    const text = res.body.toString('utf8')
    assert.ok(text.includes('<html') || text.includes('<!doctype'), '应该是 HTML')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('app.js 以 javascript 返回（否则浏览器不执行）', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/app.js`)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /javascript/)
    assert.ok(res.body.length > 1000, 'app.js 不该是空的')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('app.css 以 css 返回', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/app.css`)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/css/)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('不存在的静态文件 404', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/nope-does-not-exist.js`)
    assert.equal(res.statusCode, 404)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('目录穿越被挡住', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/../../package.json`)
    assert.ok(res.statusCode === 400 || res.statusCode === 404, `应被拒，实际 ${res.statusCode}`)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('/api/state 返回 magpie 形状的数据', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/state`)
    assert.equal(res.statusCode, 200)
    const json = JSON.parse(res.body.toString('utf8'))
    // 页面启动就要的字段
    for (const key of ['agents', 'clients', 'profiles', 'settings', 'fx']) {
      assert.ok(key in json, `state 缺字段 ${key}`)
    }
    assert.equal(json.agents.length, 1, '应有一个账号')
    assert.equal(json.agents[0].provider, 'p1')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('/api/providers 返回供应商', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/providers`)
    assert.equal(res.statusCode, 200)
    const json = JSON.parse(res.body.toString('utf8'))
    assert.equal(json.providers.length, 1)
    // magpie 的账号字段叫 user（不是 name），形状要对齐 providersJSON。
    // ⚠ 列表里 user 取的是 key：真实账号名要走 `ensureFresh`（会触发续期），
    // 48 个供应商时那是 17 秒的代价，所以列表不查、详情里才取。
    assert.equal(json.providers[0].accounts[0].user, 'p1#1')
    // 顶层必须给全，页面 await fresh 之后会直接读这些
    for (const key of ['presets', 'excluded', 'gateway', 'plugins']) {
      assert.ok(key in json, `providers 响应缺字段 ${key}`)
    }
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('未实现的接口回 501 并说明缺哪个', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/sessions`)
    assert.equal(res.statusCode, 501)
    const json = JSON.parse(res.body.toString('utf8'))
    assert.equal(json.error, 'not-implemented')
    assert.equal(json.api, 'sessions')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})
