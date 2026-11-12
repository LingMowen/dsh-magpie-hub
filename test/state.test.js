/**
 * 策略层测试：模型开关、供应商启停、隐藏账号、别名、路由策略。
 *
 * 这些是「面板能不能管」的核心状态，写错不会报错、只会静默失灵，
 * 所以每条都测行为而不是测字段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PolicyStore, modelKey } from '../src/state.js';
import { hostPaths } from '../src/store.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  return { dir, policy: new PolicyStore(hostPaths(dir)) };
}

test('modelKey 形如 provider/model', () => {
  assert.equal(modelKey('wps-lingxi', 'GLM-5.3'), 'wps-lingxi/GLM-5.3');
});

test('模型开关：禁用后查询为真，恢复后为假', async () => {
  const { dir, policy } = freshStore();
  try {
    assert.equal(await policy.isModelDisabled('p', 'm1'), false);
    await policy.setModelDisabled('p', 'm1', true);
    assert.equal(await policy.isModelDisabled('p', 'm1'), true);
    await policy.setModelDisabled('p', 'm1', false);
    assert.equal(await policy.isModelDisabled('p', 'm1'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('模型开关：写盘后重建实例仍读得到（跨进程一致）', async () => {
  const { dir, policy } = freshStore();
  try {
    await policy.setModelDisabled('p', 'm1', true);
    const again = new PolicyStore(hostPaths(dir));
    assert.equal(await again.isModelDisabled('p', 'm1'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('批量启停：只动给定模型，别的键不受影响', async () => {
  const { dir, policy } = freshStore();
  try {
    await policy.setModelDisabled('p', 'keep', true);
    await policy.setModelsDisabled([{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }], true);
    assert.equal(await policy.isModelDisabled('p', 'a'), true);
    assert.equal(await policy.isModelDisabled('p', 'b'), true);
    assert.equal(await policy.isModelDisabled('p', 'keep'), true);
    await policy.setModelsDisabled([{ provider: 'p', model: 'a' }], false);
    assert.equal(await policy.isModelDisabled('p', 'a'), false);
    assert.equal(await policy.isModelDisabled('p', 'b'), true, 'b 不该被顺带打开');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('供应商启停', async () => {
  const { dir, policy } = freshStore();
  try {
    assert.equal(await policy.isProviderOff('catpaw'), false);
    await policy.setProviderOff('catpaw', true);
    assert.equal(await policy.isProviderOff('catpaw'), true);
    await policy.setProviderOff('catpaw', false);
    assert.equal(await policy.isProviderOff('catpaw'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('账号别名：设了能读，设空串等于清除', async () => {
  const { dir, policy } = freshStore();
  try {
    assert.equal(await policy.aliasOf('p#1'), undefined);
    await policy.setAccountAlias('p#1', '  工作号  ');
    assert.equal(await policy.aliasOf('p#1'), '工作号', '两边空白要 trim');
    await policy.setAccountAlias('p#1', '');
    assert.equal(await policy.aliasOf('p#1'), undefined, '空串应清除别名而不是存空串');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('账号隐藏', async () => {
  const { dir, policy } = freshStore();
  try {
    await policy.setAccountHidden('p#1', true);
    assert.equal(await policy.isAccountHidden('p#1'), true);
    assert.equal(await policy.isAccountHidden('p#2'), false);
    await policy.setAccountHidden('p#1', false);
    assert.equal(await policy.isAccountHidden('p#1'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('路由策略：默认 first，只接受三种值', async () => {
  const { dir, policy } = freshStore();
  try {
    assert.equal(await policy.strategy(), 'first');
    assert.equal(await policy.setStrategy('fastest'), 'fastest');
    assert.equal(await policy.strategy(), 'fastest');
    // 非法值：保持原值，不猜用户意思
    assert.equal(await policy.setStrategy('whatever'), 'fastest');
    assert.equal(await policy.strategy(), 'fastest');
    assert.equal(await policy.setStrategy('cheapest'), 'cheapest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('路由分组：设置、覆盖、空数组等于删除', async () => {
  const { dir, policy } = freshStore();
  try {
    await policy.setGroup('deepseek-v4-pro', ['p/a', 'q/b']);
    assert.deepEqual((await policy.groups())['deepseek-v4-pro'], ['p/a', 'q/b']);
    await policy.setGroup('deepseek-v4-pro', ['q/b', 'p/a']);
    assert.deepEqual((await policy.groups())['deepseek-v4-pro'], ['q/b', 'p/a']);
    await policy.setGroup('deepseek-v4-pro', []);
    assert.equal((await policy.groups())['deepseek-v4-pro'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写盘形状：三个集合存成数组，别名/分组存成对象', async () => {
  const { dir, policy } = freshStore();
  try {
    await policy.setModelDisabled('p', 'm', true);
    await policy.setProviderOff('x', true);
    await policy.setAccountHidden('p#1', true);
    await policy.setAccountAlias('p#1', '名');
    await policy.setGroup('g', ['p/m']);
    const file = JSON.parse(readFileSync(join(dir, 'hub-settings.json'), 'utf8'));
    assert.ok(Array.isArray(file.disabledModels), 'disabledModels 应是数组');
    assert.ok(Array.isArray(file.offProviders));
    assert.ok(Array.isArray(file.hiddenAccounts));
    assert.equal(typeof file.accountAliases, 'object');
    assert.equal(typeof file.routeGroups, 'object');
    assert.deepEqual(file.disabledModels, ['p/m']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
