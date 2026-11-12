/**
 * 面板视图的行为测试（`src/panel.js`）。
 *
 * 这里只测**能在快照形状上判定**的东西：节点类型、页签数量、打码是否生效、
 * 时间是否被翻成人话、进度条形态。像素与观感仍然要真机截图看，那部分不进单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelView } from '../src/panel.js';

/** 一个最小快照：一个平台、一个账号、一个额度窗口、一份用量。 */
function snapshot(overrides = {}) {
    const provider = {
        id: 'wps-lingxi',
        name: 'WPS 灵犀 Lingxi',
        accounts: [{ key: 'wps-lingxi', accountId: 'wps-1234567890', plan: 'Pro', signIn: 'kept' }],
        methods: [
            { index: 0, type: 'oauth', label: '浏览器登录' },
            { index: 1, type: 'oauth', label: '导入本机客户端' },
            { index: 2, type: 'api', label: 'API Key' },
        ],
        models: { 'deepseek-v4.1-flash': {} },
        ...overrides.provider,
    };
    return {
        providers: [provider],
        usage: [{
                provider: 'wps-lingxi',
                // 真实 magpie 里 accountKey 常常就等于 provider id，`user` 才是账号。
                accountKey: 'wps-lingxi',
                label: 'wps-lingxi',
                user: 'WPS_1000000001',
                plan: 'Pro',
                balance: '2,299',
                until: '2026-12-07T15:49:04+08:00',
                windows: [{ name: '智点', used: 99.96, amount: 2299, limit: 2300, unit: '' }],
            }],
        stats: {
            period: 'today',
            tokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            calls: 0,
            errors: 0,
            cost: undefined,
            unpriced: 0,
            retried: 0,
            series: [],
            byProvider: [],
        },
        routing: [],
        // 与真实快照同形：`package` 是包名、`installed` 决定落在哪一段
        // 插件页的数据源（buildSnapshot 的真实形状）
        plugins: [
            {
                spec: 'wps-lingxi',
                packageName: 'wps-lingxi',
                name: 'WPS 灵犀 Lingxi',
                version: '1.4.2',
                providers: ['wps-lingxi'],
            },
            {
                spec: '@magpie-community/opencode-catpaw-auth',
                packageName: '@magpie-community/opencode-catpaw-auth',
                name: '妙手 CatPaw',
                version: '1.0.0',
                providers: ['catpaw'],
            },
        ],
        pluginFailures: [],
        store: [
            { package: 'wps-lingxi', name: 'WPS 灵犀', installed: true },
            { package: '@magpie-community/opencode-catpaw-auth', name: '妙手 CatPaw', installed: false },
        ],
        ...overrides,
    };
}

/** 递归找所有节点（返平数组）。 */
function flatten(node, out = []) {
    if (Array.isArray(node)) {
        for (const item of node)
            flatten(item, out);
        return out;
    }
    if (node === null || typeof node !== 'object')
        return out;
    out.push(node);
    for (const value of Object.values(node))
        if (value !== null && typeof value === 'object')
            flatten(value, out);
    return out;
}

function texts(view) {
    return flatten(view).filter(n => n.type === 'text').map(n => n.text);
}
/**
 * 页面上**看得见的文字**：text 段落 + list 行的三段 + keyValue。
 *
 * 账号、套餐、到期现在都在 list 行的 title/subtitle 里（行式布局），
 * 只收集 `text` 节点会把它们全部漏掉，让「账号应原文显示」这类断言假通过。
 */
function visibleTexts(view) {
    const out = [...texts(view)];
    for (const node of flatten(view)) {
        if (node.type === 'list' && Array.isArray(node.items)) {
            for (const row of node.items) {
                if (row.title) out.push(String(row.title));
                if (row.subtitle) out.push(String(row.subtitle));
                if (row.trailing) out.push(String(row.trailing));
            }
        }
        // 操作按钮（`actions`）的文字也看得见；插件侧统一用 App 真按钮后，
        // 「检查更新」「刷新额度」这些都在这里，不再走 list 行。
        if (node.type === 'actions' && Array.isArray(node.items)) {
            for (const item of node.items)
                if (item.label) out.push(String(item.label));
        }
        // 表单的提交按钮（`form.submitLabel`）是实心的主操作按钮，文字也看得见。
        // 空 children 的 form 就是拿来当纯按钮用的（见 panel.js 的 solidButton）。
        if (node.type === 'form' && node.submitLabel) out.push(String(node.submitLabel));
        // keyValue 的键值也看得见（空态自证的诊断信息就是 keyValue）。
        if (node.type === 'keyValue' && Array.isArray(node.items)) {
            for (const row of node.items) {
                if (row.key) out.push(String(row.key));
                if (row.value !== undefined) out.push(String(row.value));
            }
        }
    }
    return out;
}

/**
 * 顶部导航（`chips`）。App 的 `tabs` 会按宽度折成 3+1，所以页面切换改成了
 * 插件自绘的 chips（`Wrap` 横排换行，见 panel.js 的 navChips）。
 */
function navOf(view) {
    const chips = flatten(view).find(n => n.type === 'chips');
    assert.ok(chips, '视图应有 chips 导航');
    return chips;
}
/** 当前页的正文节点（导航之后的所有节点）。 */
function pageOf(view) {
    assert.equal(view.children[0].type, 'chips', '第一个子节点应是导航');
    return view.children.slice(1);
}

test('导航是自绘 chips，五个页面：平台 / 额度 / 用量 / 插件 / 设置', () => {
    const nav = navOf(panelView(snapshot(), { locale: 'zh' }));
    // 固定 5 个：App 的 `DshUiChips` 是 Wrap 自动换行，6 个中文标签会折成 5+1，
    // 「设置」掉到第二行看起来像另一组控件（真机确认过）。所以商店并进插件页。
    assert.deepEqual(nav.options.map(o => o.label), ['平台', '额度', '用量', '插件', '设置']);
    assert.deepEqual(nav.options.map(o => o.value), ['agents', 'quotas', 'usage', 'plugins', 'settings']);
    // 控件只有带 bind 才可写（App 侧 readOnly = bind == null || …）
    assert.equal(nav.bind, 'data.ui.page');
    assert.equal(nav.onChange.id, 'switchPage');
    assert.equal(nav.value, 'agents', '默认落在平台页');
});

test('请求记录并入用量页；已装包搬去商店页（平台页不再混这两件事）', () => {
    const usage = flatten(pageOf(panelView(snapshot(), { locale: 'zh' }, { page: 'usage' })))
        .filter(n => n.type === 'text').map(n => n.text);
    assert.ok(usage.includes('**请求记录**'), '用量页应有「请求记录」小节（Markdown 粗体）');
    const agents = flatten(pageOf(panelView(snapshot(), { locale: 'zh' }, { page: 'agents' })))
        .filter(n => n.type === 'text').map(n => n.text);
    assert.ok(!agents.includes('**已装的包**'), '平台页不该再有「已装的包」');
    const plugins = flatten(pageOf(panelView(snapshot(), { locale: 'zh' }, { page: 'plugins' })))
        .filter(n => n.type === 'text' && typeof n.text === 'string').map(n => n.text);
    assert.ok(plugins.some(t => t.includes('已安装的插件')), '插件页应有「已安装的插件」小节');
    assert.ok(plugins.includes('**可安装**'), '插件页应有「可安装」小节（商店已并进来）');
});

test('额度窗口用 bar 而不是 ring（手机上条状省高度且接近满额也看得出）', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'quotas' });
    const bars = flatten(view).filter(n => n.type === 'progress');
    assert.ok(bars.length > 0, '应至少有 1 个 progress');
    for (const node of bars) {
        assert.equal(node.shape, 'bar');
        assert.equal(node.max, 100);
    }
});

test('额度条尾给「剩多少」而不是百分比', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'quotas' });
    const bar = flatten(view).find(n => n.type === 'progress');
    assert.equal(bar.label, '智点');
    assert.equal(bar.caption, '剩 1 / 2,300');
    // 条画的是**剩余**比例：2300 里只剩 1，即 0.04%，属于危险 → bad。
    assert.equal(bar.tone, 'bad');
    assert.equal(bar.value, 0, '2,299/2,300 用掉后剩余百分比四舍五入是 0');
});

test('账号默认按原文显示（不打码），且平台名不靠它再出现一次', () => {
    // 账号已搬进「平台详情」视图（点卡片才进），所以这里要带 focus
    const view = panelView(snapshot(), { locale: 'zh' }, { focus: 'wps-lingxi' });
    const all = visibleTexts(view).join('\n');
    assert.ok(all.includes('wps-1234567890'), `详情页账号应原文显示，实际：${all}`);
    // 额度段的 `WPS_1000000001` 已不再塞进详情页（它属于「额度」页那一屏），
    // 详情页只保留账号列表里那一个身份，避免同一账号一屏出现两次。
    const quota = panelView(snapshot(), { locale: 'zh' }, { page: 'quotas' });
    const quotaText = visibleTexts(quota).join(' ');
    assert.ok(quotaText.includes('WPS_1000000001'), '额度页仍应显示 usage 账号');
    // 额度页不再用 provider id 当账号身份：那一屏里它只该作为小节标题出现
    assert.ok(!all.includes('wps-lingxi —'), '不应出现「provider id — ...」形式的身份行');
});

test('额度页不再重复平台名（provider 名只作小节标题出现）', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'quotas' });
    const all = visibleTexts(view).join('\n');
    const hits = all.split('WPS 灵犀 Lingxi').length - 1;
    // 平台页折叠标题 + 额度页小节标题 = 2，不能再多
    assert.ok(hits <= 2, `平台名出现 ${hits} 次，应 ≤2`);
});

test('额度页：套餐名与平台标题重复时省略，余额与条尾不重复', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'quotas' });
    const quota = pageOf(view);
    const row = flatten(quota).find(n => n.type === 'list')?.items?.[0];
    assert.ok(row, '额度页应有账号行');
    // fixture 里 plan 与 provider 名相同 -> 不该再出现在副标题
    assert.ok(!String(row.subtitle ?? '').includes('WPS 灵犀 Lingxi'), `副标题不该重复平台名：${row.subtitle}`);
    // 有 limit/amount 时余额交给条尾，副标题不再写「余额」
    assert.ok(!String(row.subtitle ?? '').includes('余额'), `副标题不该再写余额：${row.subtitle}`);
    assert.ok(String(row.subtitle ?? '').includes('天'), '到期时间应保留');
});
test('到期时间翻成人话，不吐 ISO 串', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'quotas' });
    const all = visibleTexts(view).join('\n');
    assert.ok(!all.includes('2026-12-07T15:49:04+08:00'), '不该出现原始 ISO 时间');
    assert.ok(/还有 \d+ 天|月\d+日到期|已到期/.test(all), `应出现人话时间，实际：${all}`);
});

test('用量页：周期选择在数字之后（首屏直接是数据）', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'usage' });
    const usage = pageOf(view);
    const first = usage[0];
    assert.equal(first.type, 'row', '第一块应该是指标');
    const flat = flatten(usage);
    const types = flat.map(n => n.type);
    const optionIndex = types.indexOf('options');
    const lastMetricIndex = types.lastIndexOf('metric');
    assert.ok(optionIndex > 0, '应有周期选择');
    assert.ok(lastMetricIndex >= 0, '应有指标卡');
    assert.ok(optionIndex > lastMetricIndex, 'options 应排在指标之后');
    assert.equal(flat[optionIndex].id, 'statsPeriod');
});

test('没有数据的指标显示「暂无」，真 0 显示 0', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'usage' });
    const usage = pageOf(view);
    const metrics = flatten(usage).filter(n => n.type === 'metric');
    const byLabel = Object.fromEntries(metrics.map(m => [m.label, m.value]));
    assert.equal(byLabel['Token'], '0', '真 0 要显示 0');
    // 费用与命中率已从大卡片挪进明细行（省首屏高度）
    const kv = Object.fromEntries(flatten(usage).filter(n => n.type === 'keyValue').flatMap(n => n.items));
    assert.equal(kv['费用'], '暂无', '拿不到的费用要显示暂无');
    assert.equal(kv['缓存命中率'], '暂无', '分母为 0 的命中率要显示暂无');
});

test('登录方式是 App 真按钮（actions），动作形状带 provider 与 index', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { focus: 'wps-lingxi' });
    const groups = flatten(view).filter(n => n.type === 'actions');
    const login = groups.find(g => g.items.some(i => i.action?.id === 'signIn'));
    assert.ok(login, '应有登录按钮');
    const buttons = login.items.filter(i => i.action?.id === 'signIn');
    assert.equal(buttons.length, 2, '两个 oauth 方式各一个按钮');
    // 动作形状必须是 {id, args}（App 的 _pluginAction 认这个）
    assert.equal(buttons[0].action.args.provider, 'wps-lingxi');
    assert.equal(buttons[0].action.args.index, 0);
    // 按钮文字不再带「登录：」前缀
    assert.equal(buttons[0].label, '浏览器登录');
});
test('诊断信息在设置页，平台页只给下一步去哪', () => {
    // 普通用户打开面板看到的应该是能用的界面 + 一条去插件页的路；
    // 数据目录、登记数这些排障信息归到设置页，不占平台页。
    const bare = {
        providers: [], usage: [], plugins: [], pluginFailures: [], store: [], routing: [],
        diagnostics: {
            root: '/root/.config/magpie',
            declared: 11,
            loaded: 0,
            failed: 3,
            firstError: 'Cannot find module @magpie-community/x',
        },
    };
    const agents = visibleTexts(panelView(bare, { locale: 'zh' })).join(' ');
    assert.match(agents, /还没有安装 magpie 插件/);
    assert.match(agents, /去插件页安装/);
    assert.equal(agents.includes('/root/.config/magpie'), false, '平台页不露数据目录');
    const settings = visibleTexts(panelView(bare, { locale: 'zh' }, { page: 'settings' })).join(' ');
    assert.match(settings, /这次扫描的结果/);
    assert.match(settings, /root\/\.config\/magpie/);
    assert.match(settings, /登记的插件/);
    assert.match(settings, /Cannot find module/);
    const plain = panelView({ providers: [] }, { locale: 'zh' }, { page: 'settings' });
    assert.equal(visibleTexts(plain).join(' ').includes('这次扫描的结果'), false);
});


test('平台页是一列卡片，点卡片进详情（openProvider 带平台 id）', () => {
    const view = panelView(snapshot(), { locale: 'zh' });
    const rows = pageOf(view).flatMap(n => (n.type === 'list' ? n.items : []));
    const card = rows.find(r => r.action && r.action.id === 'openProvider');
    assert.ok(card, '平台要以可点的卡片出现');
    assert.equal(card.action.args.provider, 'wps-lingxi');
    assert.match(card.title, /WPS 灵犀/);
    assert.match(card.subtitle, /账号/);
});

test('卡片右侧额度摘要只写剩 N，不写已用', () => {
    const view = panelView(snapshot(), { locale: 'zh' });
    const rows = pageOf(view).flatMap(n => (n.type === 'list' ? n.items : []));
    const card = rows.find(r => r.action && r.action.id === 'openProvider');
    assert.match(card.trailing, /剩/);
    assert.equal(card.trailing.includes('已用'), false);
});

test('详情视图有返回行，且用 collapse 图标（App 没有左箭头图标）', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { focus: 'wps-lingxi' });
    const rows = flatten(view).filter(n => n.type === 'list').flatMap(n => n.items);
    const back = rows.find(r => r.action === 'closeProvider');
    assert.ok(back, '详情页要有返回入口');
    assert.equal(back.icon, 'collapse', 'chevron-left 不在合法图标集里，会画成默认图标');
    assert.match(back.title, /^‹ /);
});

test('详情视图的焦点指向不存在的平台时退回列表', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { focus: 'nope' });
    assert.equal(view.children[0].type, 'chips', '退回列表时导航仍在');
    const rows = flatten(view).filter(n => n.type === 'list').flatMap(n => n.items);
    assert.ok(rows.some(r => r.action && r.action.id === 'openProvider'), '应该看到平台卡片');
});

test('搜索是一个常显的扁输入框，走 onChange 而不是提交按钮', () => {
    const view = panelView(snapshot(), { locale: 'zh' });
    const field = pageOf(view).find(n => n.type === 'textField');
    assert.ok(field, '平台页顶部要有搜索框');
    assert.equal(field.bind, 'data.search.query');
    assert.equal(field.onChange.id, 'searchProviders');
    assert.equal(pageOf(view).some(n => n.type === 'form'), false, '不要满宽提交按钮');
});

test('搜索关键词只留匹配的平台', () => {
    const two = snapshot({
        providers: [
            { id: 'wps-lingxi', name: 'WPS 灵犀 Lingxi', accounts: [], methods: [], models: {} },
            { id: 'catpaw', name: '妙手 CatPaw', accounts: [], methods: [], models: {} },
        ],
    });
    const view = panelView(two, { locale: 'zh' }, { query: 'catpaw' });
    const names = flatten(view).filter(n => n.type === 'list').flatMap(n => n.items)
        .filter(r => r.action && r.action.id === 'openProvider').map(r => r.title);
    assert.equal(names.length, 1);
    assert.match(names[0], /CatPaw/);
});

test('插件页：已装的行进配置页，可装的行触发安装', () => {
    const base = snapshot({
        store: [
            { package: 'wps-lingxi', name: 'WPS 灵犀', installed: true },
            { package: '@magpie-community/opencode-catpaw-auth', name: '妙手 CatPaw', installed: false },
            { package: 'lodash', name: 'lodash', installed: false },
        ],
    });
    const view = panelView(base, { locale: 'zh' }, { page: 'plugins' });
    const rows = flatten(view).filter(n => n.type === 'list').flatMap(n => n.items);
    const installed = rows.find(r => r.action && r.action.id === 'openPlugin');
    assert.ok(installed, '已装插件要能点进配置页');
    assert.equal(installed.action.args.spec, 'wps-lingxi');
    const installable = rows.find(r => r.action && r.action.id === 'installPlugin');
    assert.ok(installable, '可装包要能一键安装');
});

test('插件页有检查更新实心按钮，且更新全部常显', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'plugins' });
    const nodes = flatten(view);
    const submits = nodes.filter(n => n.type === 'form').map(n => n.submit);
    assert.ok(submits.includes('checkUpdates'), '检查更新是主操作，用实心 form 按钮');
    const actions = nodes.filter(n => n.type === 'actions').flatMap(n => n.items);
    assert.ok(actions.some(i => i.action === 'updateAllPlugins'), '更新全部常显');
});

test('插件配置页：运行选项走 form 提交（actions 按钮拿不到输入值）', () => {
    const base = snapshot();
    base.plugins = [{
        spec: 'wps-lingxi', packageName: 'wps-lingxi', name: 'WPS 灵犀',
        version: '1.4.2', providers: ['wps-lingxi'], options: { a: 1 },
    }];
    const view = panelView(base, { locale: 'zh' }, { page: 'plugins', plugin: 'wps-lingxi' });
    const form = flatten(view).find(n => n.type === 'form' && n.submit === 'savePluginOptions');
    assert.ok(form, '保存选项必须是 form 提交');
    const field = flatten(form).find(n => n.type === 'textField');
    assert.equal(field.bind, 'data.plugin.options');
    const buttons = flatten(view).filter(n => n.type === 'actions').flatMap(n => n.items);
    assert.ok(buttons.some(b => b.action === 'enablePlugin'), '要有启用');
    assert.ok(buttons.some(b => b.action === 'disablePlugin'), '要有停用');
    assert.ok(buttons.some(b => b.action === 'removePlugin'), '要有移除');
});

test('插件配置页：状态行是数据绑定，启停后能即时更新', () => {
    const base = snapshot();
    base.plugins = [{
        spec: 'wps-lingxi', packageName: 'wps-lingxi', name: 'WPS 灵犀',
        version: '1.4.2', providers: [], off: true,
    }];
    const view = panelView(base, { locale: 'zh' }, { page: 'plugins', plugin: 'wps-lingxi' });
    const bound = flatten(view).find(n => n.type === 'text' && n.text && n.text.$ === 'data.pluginStateLine');
    assert.ok(bound, '状态行必须走数据绑定，否则后台动作完成后视图不会重建');
});

test('插件配置页：没有保存过选项时用包里的示例填初值', () => {
    const base = snapshot();
    base.plugins = [{
        spec: 'wps-lingxi', packageName: 'wps-lingxi', name: 'WPS 灵犀',
        version: '1.4.2', providers: [], optionsExample: { key: 'value' },
    }];
    const view = panelView(base, { locale: 'zh' }, { page: 'plugins', plugin: 'wps-lingxi' });
    const field = flatten(view).find(n => n.type === 'textField');
    assert.match(field.value, /"key": "value"/);
});

test('商店段最底部是手输包名/链接的安装表单', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'plugins' });
    const install = flatten(view).find(n => n.type === 'form' && n.submit === 'installSpec');
    assert.ok(install, '要有手输安装的表单');
    const field = flatten(install).find(n => n.type === 'textField');
    assert.equal(field.bind, 'data.install.spec');
});

test('设置页：显示偏好是四个带 bind 的 chips，并传给 panelData', async () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'settings' });
    const chips = flatten(view).filter(n => n.type === 'chips' && typeof n.bind === 'string' && n.bind.startsWith('data.display.'));
    const binds = chips.map(c => c.bind);
    for (const want of ['data.display.strip', 'data.display.note', 'data.display.noteKind', 'data.display.models'])
        assert.ok(binds.includes(want), `缺 ${want}`);
    for (const chip of chips)
        assert.equal(chip.onChange.id, 'setDisplay', '改显示偏好走 setDisplay');
    const { panelData } = await import('../src/panel.js');
    const data = panelData(snapshot(), 'zh', Date.now(), {
        page: 'settings',
        display: { strip: false, note: true, noteKind: 'quota', models: 'flat' },
    });
    assert.equal(data.display.strip, 'off');
    assert.equal(data.display.note, 'on');
    assert.equal(data.display.noteKind, 'quota');
    assert.equal(data.display.models, 'flat');
});

test('设置页：密钥表单是两个输入框并排（grid），提交走 saveTokens', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'settings' });
    const form = flatten(view).find(n => n.type === 'form' && n.submit === 'saveTokens');
    assert.ok(form, '要有保存密钥的表单');
    const grid = flatten(form).find(n => n.type === 'grid');
    assert.equal(grid.columns, 2, '两个 token 要并排，不能各占一屏');
    const binds = flatten(grid).filter(n => n.type === 'textField').map(n => n.bind);
    assert.deepEqual(binds, ['data.tokens.github', 'data.tokens.npm']);
});

test('设置页有重扫插件（实心）与刷新数据（描边）', () => {
    const view = panelView(snapshot(), { locale: 'zh' }, { page: 'settings' });
    const nodes = flatten(view);
    const submits = nodes.filter(n => n.type === 'form').map(n => n.submit);
    assert.ok(submits.includes('reloadPlugins'), '重扫插件是主操作');
    const actions = nodes.filter(n => n.type === 'actions').flatMap(n => n.items);
    assert.ok(actions.some(i => i.action === 'refreshStats'), '刷新数据是次操作');
});

test('模型页：按供应商分组用 collapsible，平铺用一个 list', () => {
    const base = snapshot({
        providers: [
            { id: 'wps-lingxi', name: 'WPS 灵犀 Lingxi', accounts: [], methods: [], models: {}, modelIds: ['a', 'b'] },
            { id: 'catpaw', name: '妙手 CatPaw', accounts: [], methods: [], models: {}, modelIds: ['c'] },
            { id: 'empty', name: '空平台', accounts: [], methods: [], models: {}, modelIds: [] },
        ],
    });
    const grouped = panelView(base, { locale: 'zh' }, { page: 'settings', models: true, display: { models: 'group' } });
    const folds = flatten(grouped).filter(n => n.type === 'collapsible');
    assert.equal(folds.length, 2, '只给有模型的平台折叠');
    assert.ok(folds.some(f => /（2）/.test(f.label)), '折叠标题带数量');
    const back = flatten(grouped).filter(n => n.type === 'list').flatMap(n => n.items)
        .find(r => r.action === 'closeModels');
    assert.ok(back, '模型页要有返回设置的路');

    const flat = panelView(base, { locale: 'zh' }, { page: 'settings', models: true, display: { models: 'flat' } });
    assert.equal(flatten(flat).filter(n => n.type === 'collapsible').length, 0, '平铺不折叠');
    const rows = flatten(flat).filter(n => n.type === 'list').flatMap(n => n.items);
    const modelRows = rows.filter(r => r.subtitle && /WPS 灵犀|CatPaw/.test(r.subtitle));
    assert.equal(modelRows.length, 3, '平铺出三个模型');
});
