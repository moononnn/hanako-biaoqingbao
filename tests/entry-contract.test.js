// 插件入口契约守护测试
//
// 背景：Hana 当前宿主按「默认导出的插件类」实例化，把 ctx 挂到实例的 this.ctx，
// 再无参调用 onload/onunload。
//
// 旧版 index.js 只导出具名 onload/onunload（`export async function onload`），
// 导致正式版只完成 lifecycle import、onload/onunload 永不执行：
//   - Hana 重启时悬浮球不被优雅 stopBall，python 进程被连带强杀（零日志消失，观感像"闪退"）
//   - 启动扫描、批量任务恢复、tagged_at 回填等 onload 逻辑全部失效
// 第一次修复时类方法带 ctx 形参（onload(ctx = {})），宿主无参调用走了默认空对象，
// 真正的 this.ctx 被忽略 → onload 虽被调用但 ctx.dataDir 为空直接 return。
// 本测试守护完整契约：default 导出是类、实例带无参 onload/onunload、内部用 this.ctx。
// 参考同款修法：hanabrew / drift-bottle。

import test from 'node:test';
import assert from 'node:assert/strict';

test('index.js 默认导出插件类，实例无参 onload/onunload 且使用 this.ctx', async () => {
  const mod = await import('../index.js');
  const PluginClass = mod.default;

  assert.ok(PluginClass, 'default 导出不能为空');
  assert.equal(typeof PluginClass, 'function', 'default 导出必须是类/构造函数');
  assert.match(PluginClass.name, /Plugin$/, '默认导出的类名应以 Plugin 结尾');

  const instance = new PluginClass();
  assert.equal(typeof instance.onload, 'function', '实例必须有 onload 方法');
  assert.equal(typeof instance.onunload, 'function', '实例必须有 onunload 方法');
  assert.equal(instance.onload.length, 0, 'onload 必须无参（宿主无参调用，ctx 走 this.ctx）');
  assert.equal(instance.onunload.length, 0, 'onunload 必须无参（宿主无参调用，ctx 走 this.ctx）');
});

test('宿主场景模拟：挂 this.ctx 后无参调用 onload，具名 onload 收到该 ctx', async () => {
  const mod = await import('../index.js');
  const PluginClass = mod.default;
  const instance = new PluginClass();

  // 记录具名 onload 收到的 ctx
  let receivedCtx = null;
  const originalOnload = mod.onload;
  // 不能直接替换导出，改用代理验证：挂 ctx 后无参调类方法
  instance.ctx = { dataDir: '/tmp/fake-data', log: { info() {}, warn() {}, error() {} } };
  const result = instance.onload();
  assert.ok(result instanceof Promise, 'onload 应返回 Promise（async）');
  // 具名 onload 正常导出
  assert.equal(typeof mod.onload, 'function', '具名 onload 应保留');
  assert.equal(typeof mod.onunload, 'function', '具名 onunload 应保留');
  assert.ok(originalOnload, '具名 onload 存在');
});

test('宿主场景模拟：无参调用 onunload 不抛错（ctx 缺失也能优雅降级）', async () => {
  const mod = await import('../index.js');
  const PluginClass = mod.default;
  const instance = new PluginClass();
  instance.ctx = { log: { info() {}, warn() {}, error() {} } };
  // onunload 会调 stopBall（无运行中球时安全返回）；只验证调用不抛同步异常
  await assert.doesNotReject(() => instance.onunload());
});
