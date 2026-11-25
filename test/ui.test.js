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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  /** 签到结果（每次 setup 一份，测试之间不串） */
  const checkinStore = new Map()
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
      checkinOf: async () => ({ outcome: 'claimed', credit: 30, streak: 3 }),
    },
    // 签到：内存里存「最近一次结果」，与宿主里的 checkinResults 同形
    lastCheckin: (key) => checkinStore.get(key),
    recordCheckin: (provider, key, r) => {
      checkinStore.set(key, {
        day: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
        outcome: r.outcome,
        by: `plugin:${provider}`,
        ...(r.credit === undefined ? {} : { credit: r.credit }),
        ...(r.streak === undefined ? {} : { streak: r.streak }),
      });
    },
    providerOfKey: () => 'p1',
    providerName: () => '测试平台',
    setCheckinAuto: async () => {},
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
    // 用量流水（`usage/requests` / `usage/heatmap` 读它），两条覆盖成功与失败
    usageRows: () => [
      { provider: 'p1', model: 'm-a', status: 'ok', ms: 1200, tokens: 1000, cost: 0.02, accountKey: 'p1#1', at: Date.now() - 60_000 },
      { provider: 'p1', model: 'm-b', status: 'error', ms: 300, accountKey: 'p1#1', error: 'boom', at: Date.now() - 26 * 3600_000 },
    ],
    refreshQuota: async () => {},
    reload: async () => {}, refresh: async () => {},
    market: {},
    log: () => {},
  }
  const stop = mount(scoped, { handlers: makeUiHandlers(deps), log: () => {} })
  return { dir, scoped, checkinStore, getRoute: () => captured, getRoutes: () => routes ?? [], stop }
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

// ── 每日签到 ────────────────────────────────────────────────────────────
//
// 桌面 UI 的签到有三个入口（app.js:22494 / 22528 / checkinnow.js 的
// ciNowSend），形状错一个整段页面就不画或抛异常，所以逐条钉住。

test('/api/settings 带签到三件套（checkinPlugins / checkinAccounts / checkinAt）', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/settings`)
    assert.equal(res.statusCode, 200)
    const s = JSON.parse(res.body.toString('utf8'))
    // 设置页的「预热」段读 checkinPlugins；没有就是空数组，不能是 undefined
    assert.ok(Array.isArray(s.checkinPlugins), 'checkinPlugins 必须是数组')
    assert.equal(s.checkinPlugins.length, 1)
    assert.equal(s.checkinPlugins[0].id, 'p1')
    assert.equal(s.checkinPlugins[0].name, '测试平台')
    assert.equal(s.checkinPlugins[0].on, false, '默认不开自动签到')
    // 额度卡的账号级开关读 checkinAccounts
    assert.ok(Array.isArray(s.checkinAccounts), 'checkinAccounts 必须是数组')
    assert.equal(s.checkinAccounts[0].by, 'plugin:p1')
    assert.equal(s.checkinAccounts[0].on, true)
    // 全局签到时刻：空串＝每个厂商日一到就签
    assert.equal(s.checkinAt, '')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('settings/plugin-checkin 打开后落盘，且回的是完整 prefs', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/settings/plugin-checkin`, 'POST', { provider: 'p1', on: true })
    assert.equal(res.statusCode, 200)
    const s = JSON.parse(res.body.toString('utf8'))
    // 前端 `prefs = await writingPrefs(api(...))` 直接拿它重画，所以必须回全量
    assert.equal(s.checkinPlugins[0].on, true)
    assert.ok(Array.isArray(s.checkinAccounts), '必须回全量（含 checkinAccounts）')
    // 落盘位置与上游一致：settings.json 的 pluginCheckins
    const disk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.deepEqual(disk.pluginCheckins, { p1: true })
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('settings/checkin-account 把账号排除后 on=false，且不进「全部签到」', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/settings/checkin-account`, 'POST', { key: 'p1#1', on: false })
    assert.equal(res.statusCode, 200)
    const s = JSON.parse(res.body.toString('utf8'))
    assert.equal(s.checkinAccounts[0].on, false)
    const disk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.deepEqual(disk.checkinOffAccounts, ['p1#1'])
    // 「全部签到」的批次不能把它带上，否则设置里关掉的会被这一下签回来
    const off = JSON.parse((await get(getRoute(), `${MOUNT}/api/usage/checkins/off`)).body.toString('utf8'))
    assert.deepEqual(off, [], '被排除的账号不该出现在待签到列表')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('usage/checkin-account 立刻签一次并回单个结果对象', async () => {
  const { getRoute, dir, stop, checkinStore } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/usage/checkin-account`, 'POST', { by: 'plugin:p1', key: 'p1#1' })
    assert.equal(res.statusCode, 200)
    const r = JSON.parse(res.body.toString('utf8'))
    // checkinnow.js 的 ciNowSend 只读这几个字段
    assert.equal(r.outcome, 'claimed')
    assert.equal(r.by, 'plugin:p1')
    assert.equal(r.asked, true)
    assert.equal(r.credit, 30)
    assert.equal(r.streak, 3)
    // 结果要落进「最近一次」，下一屏的额度卡才显示得出「今天已签」
    assert.equal(checkinStore.get('p1#1')?.outcome, 'claimed')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('签到失败也不抛：outcome=failed 也要回对象（页面据此显示原因）', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    // 这个平台的 checkinOf 抛异常 → 宿主已转成 {outcome:'failed'}，这里直接验空 key 的分支
    const r = await get(getRoute(), `${MOUNT}/api/usage/checkin-account`, 'POST', { key: '' })
    assert.equal(r.statusCode, 500, '缺 key 应当报错而不是静默')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('usage/requests 回一页 ledger：行、合计、序列都在', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/usage/requests?period=today&limit=100`)
    assert.equal(res.statusCode, 200)
    const l = JSON.parse(res.body.toString('utf8'))
    // page.js 直接读这几个；缺一个就是 undefined 参与运算
    assert.ok(Array.isArray(l.rows), 'rows 必须是数组')
    assert.equal(typeof l.total, 'number')
    assert.equal(typeof l.offset, 'number')
    assert.ok(Array.isArray(l.series), 'series 必须是数组')
    // 今天的窗口只该有那条成功记录
    assert.equal(l.rows.length, 1)
    assert.equal(l.rows[0].provider, 'p1')
    assert.equal(l.rows[0].status, 'ok')
    assert.equal(l.tokens, 1000)
    // 表头四列（page.js:1617）读这几个键，缺一个就是 NaN
    for (const k of ['input', 'output', 'cache_read', 'cache_write']) {
      assert.equal(typeof l[k], 'number', `缺少 ${k}`)
    }
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('usage/requests 的 failed=1 只留失败行', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/usage/requests?period=all&failed=1`)
    const l = JSON.parse(res.body.toString('utf8'))
    assert.equal(l.rows.length, 1)
    assert.equal(l.rows[0].status, 'error')
    assert.equal(l.rows[0].err, 'boom')
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('usage/heatmap 回 {from,to,days}，days 每天都有 date', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/usage/heatmap?tz=Asia/Shanghai`)
    assert.equal(res.statusCode, 200)
    const h = JSON.parse(res.body.toString('utf8'))
    assert.match(h.from, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(h.to, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(Array.isArray(h.days) && h.days.length > 0, 'days 不能为空')
    for (const d of h.days) {
      assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/)
      assert.equal(typeof d.calls, 'number')
      assert.equal(typeof d.tokens, 'number')
    }
    // 今天那条成功记录应当落在最后一格
    assert.ok(h.days[h.days.length - 1].calls >= 1)
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('usage/arrange 写进 settings.json 并回全四个键', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const res = await get(getRoute(), `${MOUNT}/api/usage/arrange`, 'POST', { order: ['p1', 'p2'] })
    assert.equal(res.statusCode, 200)
    const s = JSON.parse(res.body.toString('utf8'))
    assert.deepEqual(s.usageOrder, ['p1', 'p2'])
    // 页面用返回值整体覆盖 state.settings，四个键一个都不能少
    for (const k of ['usageOrder', 'panelUsageHidden', 'usageAgentsHidden', 'clientAgents']) {
      assert.ok(k in s, `缺少 ${k}`)
    }
    const disk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.deepEqual(disk.usageOrder, ['p1', 'p2'])
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})

test('tune / context 回空 agents 而不是 501（页面显示「调用太少」而不是挂红条）', async () => {
  const { getRoute, dir, stop } = setup()
  try {
    const t = await get(getRoute(), `${MOUNT}/api/tune?days=7`)
    assert.equal(t.statusCode, 200)
    assert.deepEqual(JSON.parse(t.body.toString('utf8')), { days: 7, agents: [] })
    const c = await get(getRoute(), `${MOUNT}/api/context?days=30`)
    assert.equal(c.statusCode, 200)
    assert.deepEqual(JSON.parse(c.body.toString('utf8')), { days: 30, agents: [], series: [] })
  } finally { stop?.(); rmSync(dir, { recursive: true, force: true }) }
})
