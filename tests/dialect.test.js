import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DIALECTS, DIALECT_LIST,
  getDialect, buildDialectPrompt, buildDialectPersona,
  buildDialectEcho, BOOST_EXAMPLES, isWorkTalk, shouldBoostRound,
  readDialectConfig, writeDialectConfig, getAgentDialectSetting,
  applyDialectToIshiki, removeDialectFromIshiki, readDialectFromIshiki,
  syncDialectToIshiki, reconcileDialectToIshiki,
  appendDialectLog, readDialectLog,
  agentIshikiPath,
  _resetDialectCache,
} from '../lib/dialect.js';

// ── 测试隔离：每次把配置路径指向临时文件，绝不碰正式配置 ──
// （回归：测试曾直接写正式 data/dialect-config.json，把用户的配置覆盖丢了）
// v0.28.0：同时隔离日志文件（apply/remove 默认联动配置，会写配置和日志）
const tempConfigFiles = [];
function useTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-dialect-test-'));
  process.env.BIAOQINGBAO_DIALECT_CONFIG = path.join(dir, 'dialect-config.json');
  process.env.BIAOQINGBAO_DIALECT_LOG = path.join(dir, 'dialect-log.json');
  tempConfigFiles.push(dir);
  _resetDialectCache();
  return process.env.BIAOQINGBAO_DIALECT_CONFIG;
}

test.after(() => {
  for (const dir of tempConfigFiles) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('方言库完整性：10 种方言齐全（9 种地方话 + 学我说话），字段非空，难度标注仅新疆话保留', () => {
  assert.equal(DIALECT_LIST.length, 10);
  assert.ok(getDialect('userstyle'), '应包含 userstyle（学我说话）');
  const ids = new Set(DIALECT_LIST.map(d => d.id));
  for (const d of DIALECT_LIST) {
    // v0.30.0：学我说话是动态模板方言，不走固定字段断言（无 markers/particles/examples）
    if (d.id === 'userstyle') continue;
    assert.ok(d.name, `${d.id} 缺 name`);
    assert.ok(d.people, `${d.id} 缺 people`);
    assert.ok(d.tagline, `${d.id} 缺 tagline`);
    assert.ok(['easy', 'medium', 'hard'].includes(d.difficulty), `${d.id} 难度标注无效`);
    // v0.26.0：新疆话普通版效果一般（模型语料少），保留提示引导开加浓；其余方言不标注
    if (d.id === 'xinjiang') {
      assert.ok(d.difficultyNote && d.difficultyNote.includes('建议开加浓'), '新疆话应保留「效果一般，建议开加浓」提醒');
    } else {
      assert.ok(!d.difficultyNote, `${d.id} 不应标注效果难度`);
    }
    assert.ok(Array.isArray(d.markers) && d.markers.length >= 4, `${d.id} 标志词不足`);
    assert.ok(Array.isArray(d.particles) && d.particles.length >= 2, `${d.id} 语气词不足`);
    assert.ok(Array.isArray(d.examples) && d.examples.length >= 3, `${d.id} 例句不足`);
    // 弱方言加料：medium ≥ 5 句、hard ≥ 6 句，给模型更多示范
    if (d.difficulty === 'medium') assert.ok(d.examples.length >= 5, `${d.id} medium 例句应 ≥5`);
    if (d.difficulty === 'hard') assert.ok(d.examples.length >= 6, `${d.id} hard 例句应 ≥6`);
  }
  for (const id of ids) {
    assert.ok(getDialect(id), `getDialect(${id}) 应命中`);
  }
});

test('习惯式文案：身份化、锚定起头、质量声明、零指令词、强调打字场景、正事不压制', () => {
  // easy/medium：整句方言模式（v0.26.0：新疆话走 personaNormal 特制文案，见下方单独断言）
  for (const id of ['dongbei', 'taiwan', 'beijing', 'henan']) {
    const text = buildDialectPersona(id, 'on');
    assert.ok(text, `${id} 文案不应为空`);
    assert.ok(text.includes('土生土长的'), `${id} 文案应为身份化断言`);
    assert.ok(text.includes('说话本能'), `${id} 文案应强调「说话本能」`);
    assert.ok(text.includes('打字'), `${id} 文案应强调「打字」场景`);
    assert.ok(text.includes('打字也带着'), `${id} 整句模式应说「打字也带着X味」`);
    // v0.23.0：锚定机制（接话时用方言词起头，钉住每轮第一句）
    assert.ok(text.includes('接话时爱用'), `${id} 文案应有起头锚定`);
    assert.ok(text.includes('起头'), `${id} 文案应说「起头」`);
    assert.ok(text.includes('句尾偶尔落个'), `${id} 文案应有句尾频率控制`);
    // v0.23.0：质量优先级声明（方言只是措辞，正事不降智的保险丝）
    assert.ok(text.includes('方言只是你的措辞'), `${id} 文案应有质量声明`);
    assert.ok(text.includes('不影响内容的质量与严谨'), `${id} 文案质量声明应明确`);
    // 正事不是压制而是自然带出
    assert.ok(text.includes('正事闲聊都一个样'), `${id} 文案应说正事闲聊都自然带`);
    // 零指令词
    for (const bad of ['注意', '不要', '请', '必须', '应该', '记住', '尽量']) {
      assert.ok(!text.includes(bad), `${id} 文案不应含指令词「${bad}」`);
    }
  }
  // v0.26.0：新疆话普通版为特制文案（模型语料少，需内置整句示范；加强版靠回响层，普通版只能写进文案）
  const xjNormal = buildDialectPersona('xinjiang', 'on');
  assert.ok(xjNormal.includes('土生土长的'), '新疆话普通版应为身份化断言');
  assert.ok(xjNormal.includes('说话本能'), '新疆话普通版应强调说话本能');
  assert.ok(xjNormal.includes('打字也带着'), '新疆话普通版应强调打字场景');
  assert.ok(xjNormal.includes('接话时爱用'), '新疆话普通版应有起头锚定');
  assert.ok(xjNormal.includes('句尾偶尔落个'), '新疆话普通版应有句尾频率控制');
  assert.ok(xjNormal.includes('饭吃了么？'), '新疆话普通版应内置语序整句示范');
  assert.ok(xjNormal.includes('这事儿歹得很！'), '新疆话普通版应内置夸赞整句示范');
  assert.ok(xjNormal.includes('走撒，吃拌面去'), '新疆话普通版应内置邀约整句示范');
  assert.ok(xjNormal.includes('方言只是你的措辞'), '新疆话普通版应有质量声明');
  for (const bad of ['注意', '不要', '请', '必须', '应该', '记住', '尽量']) {
    assert.ok(!xjNormal.includes(bad), `新疆话普通版不应含指令词「${bad}」`);
  }
  // 按难度引用例句：easy 2 句、medium 3 句（hard 彩蛋模式用标志词，不引用例句）
  assert.equal(buildDialectPersona('dongbei', 'on').split('「').length - 1, 2, 'easy 方言应引用 2 句例句');
  assert.equal(buildDialectPersona('henan', 'on').split('「').length - 1, 3, 'medium 方言应引用 3 句例句');
  assert.ok(buildDialectPersona('xinjiang', 'on').includes('饭吃了么'), '新疆话普通版应含语序示范例句（特制文案不走模板）');
  // 北京话不出现「诶呦喂」式表演词，新疆话不出现馕言文式夸张比喻
  const bj = buildDialectPersona('beijing', 'on');
  assert.ok(!bj.includes('诶呦喂') && !bj.includes('真地道'), '北京话文案不应有表演腔');
  // 北京话 markers 含「不儿」（平级词，不强制出现）
  assert.ok(DIALECTS.beijing.markers.includes('不儿'), '北京话标志词应含「不儿」');
  // 替换词应避开起头词，不重复
  const dongbei = buildDialectPersona('dongbei', 'on');
  assert.equal(dongbei.split('拉倒吧').length - 1, 1, '起头词不应在替换词里重复出现');
  const xj = buildDialectPersona('xinjiang', 'on');
  assert.ok(!xj.includes('雄鹰') && !xj.includes('豹子'), '新疆话文案不应有馕言文夸张比喻');
  // 台湾腔写清楚中国台湾
  assert.ok(buildDialectPersona('taiwan', 'on').includes('中国台湾人'), '台湾腔文案应写明「中国台湾人」');
  // buildDialectPrompt 兼容别名
  assert.equal(buildDialectPrompt('dongbei', 'on'), buildDialectPersona('dongbei', 'on'));
});

test('人格文案：无效方言返回空，任何档位参数都返回文案（开关式）', () => {
  assert.equal(buildDialectPersona('xx', 'normal'), '');
  assert.equal(buildDialectPersona('dongbei', 'none'), buildDialectPersona('dongbei', 'on'), '开启状态与档位参数无关');
  assert.equal(buildDialectPersona('', 'normal'), '');
  assert.ok(buildDialectPersona('dongbei', 'light').length > 0, '老档位参数 light 也返回文案');
  assert.ok(buildDialectPersona('dongbei', 'heavy').length > 0, '老档位参数 heavy 也返回文案');
});

test('配置归一化：只保留有效配置，非法值丢弃', () => {
  useTempConfig();
  const config = writeDialectConfig({
    version: 2,
    agents: {
      hanako: { dialect: 'dongbei', enabled: true },
      agentB: { dialect: '不存在的方言', enabled: true },
      xingxing: { dialect: 'henan', density: 'max' }, // 老格式非法浓度 → 丢弃
      '__proto__': { dialect: 'henan', enabled: true },
      ok2: null,
    },
  });
  assert.deepEqual(config.agents, { hanako: { dialect: 'dongbei', enabled: true } });
});

test('配置：关闭档不保存（enabled:false / density:none 迁移均不存），读回返回 null', () => {
  useTempConfig();
  writeDialectConfig({
    version: 2,
    agents: {
      a: { dialect: 'henan', enabled: false },
      b: { dialect: 'henan', density: 'none' }, // 老格式关闭
    },
  });
  assert.equal(getAgentDialectSetting('a'), null);
  assert.equal(getAgentDialectSetting('b'), null);
  assert.equal(getAgentDialectSetting('不存在的助手'), null);
});

test('配置：老版三档浓度自动迁移为 enabled（light/normal/heavy → 开启）', () => {
  useTempConfig();
  writeDialectConfig({
    version: 1,
    agents: {
      a: { dialect: 'dongbei', density: 'light' },
      b: { dialect: 'henan', density: 'normal' },
      c: { dialect: 'taiwan', density: 'heavy' },
    },
  });
  const read = readDialectConfig();
  assert.deepEqual(read.agents, {
    a: { dialect: 'dongbei', enabled: true },
    b: { dialect: 'henan', enabled: true },
    c: { dialect: 'taiwan', enabled: true },
  });
  assert.equal(read.version, 3);
});

test('配置：读写往返一致（新格式）', () => {
  useTempConfig();
  writeDialectConfig({
    version: 2,
    agents: {
      hanako: { dialect: 'taiwan', enabled: true },
      agentB: { dialect: 'sichuan', enabled: true },
    },
  });
  const read = readDialectConfig();
  assert.deepEqual(read.agents, {
    hanako: { dialect: 'taiwan', enabled: true },
    agentB: { dialect: 'sichuan', enabled: true },
  });
  assert.deepEqual(getAgentDialectSetting('hanako'), { dialect: 'taiwan', enabled: true });
});

test('配置：清缓存后从磁盘真实读取（回归：fs 未导入被缓存掩盖）', () => {
  useTempConfig();
  writeDialectConfig({
    version: 2,
    agents: { hanako: { dialect: 'dongbei', enabled: true } },
  });
  _resetDialectCache();
  const read = readDialectConfig();
  assert.deepEqual(read.agents, { hanako: { dialect: 'dongbei', enabled: true } });
  assert.deepEqual(getAgentDialectSetting('hanako'), { dialect: 'dongbei', enabled: true });
});

// ── 人格文件写入（用户主动开启才写，关闭即删）──

function makeTempAgentsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-agents-'));
}

test('applyDialectToIshiki：新建文件写入人格块', () => {
  const root = makeTempAgentsRoot();
  // v0.28.0：纯人格行为测试传 syncConfig:false，隔离配置联动（联动行为有专属测试覆盖）
  const res = applyDialectToIshiki('hanako', 'dongbei', 'normal', root, 'normal', { syncConfig: false });
  assert.equal(res.ok, true);
  const content = fs.readFileSync(path.join(root, 'agents', 'hanako', 'ishiki.md'), 'utf-8');
  assert.ok(content.includes('<!-- biaoqingbao-dialect:start -->'));
  assert.ok(content.includes('<!-- biaoqingbao-dialect:end -->'));
  assert.ok(content.includes('东北话'));
});

test('applyDialectToIshiki：保留已有内容，追加人格块', () => {
  const root = makeTempAgentsRoot();
  const filePath = path.join(root, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# 人格定义\n\n- 你是一个温暖的人\n', 'utf-8');

  applyDialectToIshiki('hanako', 'henan', 'on', root, 'normal', { syncConfig: false });
  const content = fs.readFileSync(filePath, 'utf-8');
  assert.ok(content.startsWith('# 人格定义\n\n- 你是一个温暖的人'), '原有内容应保留');
  assert.ok(content.includes('土生土长的河南人'), '应为身份化习惯式描述');
  assert.ok(content.includes('biaoqingbao-dialect:start'), '应含方言块');
});

test('applyDialectToIshiki：重复写入幂等，只保留一个块', () => {
  const root = makeTempAgentsRoot();
  applyDialectToIshiki('agentB', 'sichuan', 'on', root, 'normal', { syncConfig: false });
  applyDialectToIshiki('agentB', 'sichuan', 'on', root, 'normal', { syncConfig: false });
  const content = fs.readFileSync(path.join(root, 'agents', 'agentB', 'ishiki.md'), 'utf-8');
  const starts = content.split('<!-- biaoqingbao-dialect:start -->').length - 1;
  const ends = content.split('<!-- biaoqingbao-dialect:end -->').length - 1;
  assert.equal(starts, 1);
  assert.equal(ends, 1);
  assert.ok(content.includes('土生土长的四川人'), '应为习惯式文案');
});

test('removeDialectFromIshiki：移除块且保留其他内容', () => {
  const root = makeTempAgentsRoot();
  const filePath = path.join(root, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# 人格定义\n\n- 你是一个温暖的人\n\n<!-- biaoqingbao-dialect:start -->\n你是地道的东北人\n<!-- biaoqingbao-dialect:end -->\n', 'utf-8');

  const res = removeDialectFromIshiki('hanako', root, { syncConfig: false });
  assert.equal(res.ok, true);
  assert.equal(res.removed, true);
  const content = fs.readFileSync(filePath, 'utf-8');
  assert.ok(!content.includes('biaoqingbao-dialect'), '方言块应被移除');
  assert.ok(content.includes('# 人格定义'), '原有内容应保留');
});

test('removeDialectFromIshiki：无块时返回 removed=false，不报错', () => {
  const root = makeTempAgentsRoot();
  const res = removeDialectFromIshiki('hanako', root, { syncConfig: false }); // 文件不存在
  assert.equal(res.ok, true);
  assert.equal(res.removed, false);
});

test('readDialectFromIshiki：读回写入的人格文案', () => {
  const root = makeTempAgentsRoot();
  applyDialectToIshiki('hanako', 'taiwan', 'light', root, 'normal', { syncConfig: false });
  const persona = readDialectFromIshiki('hanako', root);
  assert.ok(persona.includes('台湾'));
  assert.ok(persona.includes('超'));
});

// ── v0.28.0「焊死门」：apply/remove 默认联动配置+日志，杜绝配置与人格漂移 ──
// 背景：曾出现手动 apply 写人格但配置停留在旧方言的漂移（人格生效、配置落后），
// 根因是写人格文件存在绕过配置的旁路。现在默认联动，任何路径写人格都会同步配置。

test('焊死门：applyDialectToIshiki 默认联动——写人格同时更新配置+日志（advanced 带 boost）', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  const res = applyDialectToIshiki('hanako', 'beijing', 'on', root, 'advanced');
  assert.equal(res.ok, true);
  const config = readDialectConfig();
  assert.deepEqual(config.agents.hanako, { dialect: 'beijing', enabled: true, boost: true }, '配置应同步为北京话+加强版');
  const logs = readDialectLog(10);
  assert.equal(logs.length, 1, '应有 1 条保存日志');
  assert.deepEqual(logs[0].changed, [{ agentId: 'hanako', from: '未配置', to: 'beijing' }]);
});

test('焊死门：同方言重复调用不新增日志，换方言记一条且 normal 不带 boost', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  applyDialectToIshiki('hanako', 'beijing', 'on', root, 'advanced');
  applyDialectToIshiki('hanako', 'beijing', 'on', root, 'advanced'); // 无变化
  assert.equal(readDialectLog(10).length, 1, '同方言重复写入不应新增日志');
  applyDialectToIshiki('hanako', 'shanghai', 'on', root); // 换方言，默认 normal
  const config = readDialectConfig();
  assert.deepEqual(config.agents.hanako, { dialect: 'shanghai', enabled: true }, '切普通版应不带 boost');
  const logs = readDialectLog(10);
  assert.equal(logs.length, 2, '换方言应新增 1 条日志');
  assert.deepEqual(logs[1].changed, [{ agentId: 'hanako', from: 'beijing', to: 'shanghai' }]);
});

test('焊死门：removeDialectFromIshiki 默认联动——移除人格同时从配置删除+记日志', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  applyDialectToIshiki('hanako', 'beijing', 'on', root, 'advanced');
  const res = removeDialectFromIshiki('hanako', root);
  assert.equal(res.ok, true);
  assert.equal(res.removed, true);
  const config = readDialectConfig();
  assert.ok(!config.agents.hanako, '配置应移除该助手');
  const logs = readDialectLog(10);
  assert.equal(logs.length, 2, '关闭应新增 1 条日志');
  assert.deepEqual(logs[1].changed, [{ agentId: 'hanako', from: 'beijing', to: '关闭' }]);
  assert.equal(readDialectFromIshiki('hanako', root), '', '人格块应已移除');
});

test('焊死门：remove 无配置时不写配置不记日志，sync 内部路径不产生额外日志', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  const res = removeDialectFromIshiki('nobody', root);
  assert.equal(res.ok, true);
  assert.equal(readDialectLog(10).length, 0, '配置里没有该助手时不应记日志');

  // sync 内部传 syncConfig:false：配置由调用方统一管，不应重复写日志
  writeDialectConfig({ version: 3, agents: { hanako: { dialect: 'beijing', enabled: true, boost: true } } });
  const syncRes = syncDialectToIshiki(readDialectConfig(), root);
  assert.ok(syncRes.hanako && syncRes.hanako.ok, 'sync 应成功');
  assert.equal(readDialectLog(10).length, 0, 'sync 内部不应写配置日志');
  const persona = readDialectFromIshiki('hanako', root);
  assert.ok(persona.includes('吃了吗您'), '加强版北京话文案应写入（回响/人格联动一致）');
});

test('syncDialectToIshiki：有配置写入、无配置移除（隔离目录，不碰真实人格文件）', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  writeDialectConfig({
    version: 2,
    agents: {
      hanako: { dialect: 'dongbei', enabled: true },
    },
  });
  const results = syncDialectToIshiki({ version: 2, agents: { hanako: { dialect: 'dongbei', enabled: true } } }, root);
  assert.equal(typeof results, 'object');
  assert.ok(results.hanako && results.hanako.ok, 'hanako 应写入成功');
  // 验证写入的是隔离目录（回归：此前 sync 内部写真实 HANA_HOME，测试跑完把真实人格文件覆盖了）
  const persona = readDialectFromIshiki('hanako', root);
  assert.ok(persona.includes('土生土长的东北人'), '隔离目录应有方言块');
});

test('关闭方言后 sync 应移除人格块（回归：POST 保存后缓存已刷成新配置，旧配置必须显式传入）', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  // 第一次保存：开启方言，写入人格块
  const first = { version: 2, agents: { hanako: { dialect: 'taiwan', enabled: true } } };
  writeDialectConfig(first);
  syncDialectToIshiki(first, root, null);
  assert.ok(readDialectFromIshiki('hanako', root).includes('台湾'), '开启后应有方言块');
  // 第二次保存：关闭方言（配置里不再有该助手）。模拟 POST 流程：
  // 先 writeDialectConfig（缓存刷成新配置）再 sync，previousConfig 传旧配置
  const second = { version: 2, agents: {} };
  writeDialectConfig(second);
  const results = syncDialectToIshiki(second, root, first);
  assert.ok(results.hanako && results.hanako.removed === true, '关闭后应移除方言块');
  assert.equal(readDialectFromIshiki('hanako', root), '', '人格文件里不应再有方言块');
  // 不传 previousConfig 的旧行为（读缓存）应保留：配置里本就没有的助手不会被误删别人的块
  const otherRoot = makeTempAgentsRoot();
  const withAgent = { version: 2, agents: { agentB: { dialect: 'sichuan', enabled: true } } };
  writeDialectConfig(withAgent);
  syncDialectToIshiki(withAgent, otherRoot, null);
  assert.ok(readDialectFromIshiki('agentB', otherRoot).includes('四川'), '正常开启流程不受影响');
});

test('已删除方言（闽南话）残留的人格块会被清理（回归：normalize 过滤后 remove 分支拿不到）', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  // 模拟 v0.22 时代：用户配过闽南话，ishiki.md 已写入 minnan 块（老文案直接用标记块构造）
  const filePath = path.join(root, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# 人格定义\n\n<!-- biaoqingbao-dialect:start -->\n你是土生土长的闽南人，打字带闽南味\n<!-- biaoqingbao-dialect:end -->\n', 'utf-8');
  const oldConfig = { version: 2, agents: { hanako: { dialect: 'minnan', enabled: true } } };
  assert.ok(readDialectFromIshiki('hanako', root), '前置：minnan 块应存在');
  // 升级到 v0.23：保存时 previousConfig 显式传入旧配置（含已删除的 minnan）
  const newConfig = { version: 2, agents: {} };
  writeDialectConfig(newConfig);
  const results = syncDialectToIshiki(newConfig, root, oldConfig);
  assert.ok(results.hanako && results.hanako.removed === true, 'minnan 助手应走 remove 分支');
  assert.equal(readDialectFromIshiki('hanako', root), '', '人格文件里不应再有 minnan 块');
  // 顺带：同一保存里换成新方言时不应误删（旧 minnan → 新 dongbei 应写入新块）
  const swapRoot = makeTempAgentsRoot();
  const swapPath = path.join(swapRoot, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(swapPath), { recursive: true });
  fs.writeFileSync(swapPath, '# 人格定义\n\n<!-- biaoqingbao-dialect:start -->\n你是土生土长的闽南人\n<!-- biaoqingbao-dialect:end -->\n', 'utf-8');
  const swapped = syncDialectToIshiki({ version: 2, agents: { hanako: { dialect: 'dongbei', enabled: true } } }, swapRoot, oldConfig);
  assert.ok(swapped.hanako && swapped.hanako.ok, '换方言应写入成功');
  const swappedText = readDialectFromIshiki('hanako', swapRoot);
  assert.ok(swappedText.includes('东北'), '应是东北话块而非残留');
  assert.ok(!swappedText.includes('闽南'), '不应残留 minnan 文案');
});

test('reconcileDialectToIshiki：配置有但文件缺块时补写，有块不动，无配置不碰', () => {
  const root = makeTempAgentsRoot();
  // agentB：配置有，但文件里没有块 → 应补写
  // hanako：配置有，文件已有块 → 不动
  const hanakoPath = path.join(root, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(hanakoPath), { recursive: true });
  fs.writeFileSync(hanakoPath, '# 人格定义\n\n<!-- biaoqingbao-dialect:start -->\n你是地道的东北人\n<!-- biaoqingbao-dialect:end -->\n', 'utf-8');

  const res = reconcileDialectToIshiki({
    version: 2,
    agents: {
      hanako: { dialect: 'dongbei', enabled: true },
      agentB: { dialect: 'taiwan', enabled: true },
    },
  }, root);

  assert.deepEqual(res.fixed, ['agentB'], '应只补写缺块的 agentB');
  assert.deepEqual(res.failed, []);
  // agentB 补写成功
  assert.ok(readDialectFromIshiki('agentB', root).includes('台湾'));
  // hanako 内容未被改动（无重复块）
  const hanakoContent = fs.readFileSync(hanakoPath, 'utf-8');
  assert.equal(hanakoContent.split('biaoqingbao-dialect:start').length - 1, 1, 'hanako 不应被重复写块');
  // 再次 reconcile 幂等
  const res2 = reconcileDialectToIshiki({
    version: 2,
    agents: {
      hanako: { dialect: 'dongbei', enabled: true },
      agentB: { dialect: 'taiwan', enabled: true },
    },
  }, root);
  assert.deepEqual(res2.fixed, [], '第二次应无补写');
});

test('方言保存日志：写入读取往返，保留最近 200 条', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-dialect-log-'));
  const file = path.join(dir, 'dialect-log.json');
  appendDialectLog({ changed: [{ agentId: 'hanako', from: 'dongbei', to: 'henan' }], config: { version: 2 } }, file);
  appendDialectLog({ changed: [{ agentId: 'agentB', from: '未配置', to: 'taiwan' }], config: { version: 2 } }, file);
  const logs = readDialectLog(20, file);
  assert.equal(logs.length, 2);
  assert.ok(logs[0].ts, '应记录时间');
  assert.deepEqual(logs[1].changed[0], { agentId: 'agentB', from: '未配置', to: 'taiwan' });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('方言保存日志：读取不存在的文件返回空数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-dialect-log-'));
  const logs = readDialectLog(20, path.join(dir, 'nope.json'));
  assert.deepEqual(logs, []);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('方言库：每种方言例句里包含标志词的味道（抽查）', () => {
  const checks = {
    dongbei: ['搁', '咋'],
    henan: ['中', '嘞'],
    shanghai: ['阿拉', '伐'],
    cantonese: ['咁', '嘅'],
    taiwan: ['啦', '超'],
    sichuan: ['啥子', '巴适'],
    shaanxi: ['额', '咧'],
    beijing: ['得嘞', '倍儿'],
    xinjiang: ['歹', '谝'],
  };
  for (const [id, words] of Object.entries(checks)) {
    const joined = DIALECTS[id].examples.join(' ');
    for (const w of words) {
      assert.ok(joined.includes(w), `${id} 例句应包含「${w}」`);
    }
  }
});

// ── v0.24.0 加强版（四川话首发精修）──

test('加强版文案：四川话存在、身份化、零指令词、含语气词情绪表与正事分寸', () => {
  assert.ok(DIALECTS.sichuan.personaAdvanced, '四川话应有 personaAdvanced');
  const advanced = buildDialectPersona('sichuan', 'on', 'advanced');
  const normal = buildDialectPersona('sichuan', 'on');
  assert.ok(advanced, '加强版文案不应为空');
  assert.notEqual(advanced, normal, '加强版应与普通版不同');
  assert.ok(advanced.length > normal.length, '加强版应比普通版更厚');
  assert.ok(advanced.includes('土生土长的四川人'), '应为身份化断言');
  assert.ok(advanced.includes('情绪的开关'), '应含语气词情绪表（川剧变脸式）');
  assert.ok(advanced.includes('香腾了'), '应含程度补语示范');
  assert.ok(advanced.includes('要得不'), '正事示例应含正反问句式');
  assert.ok(advanced.includes('夸张的词收着用'), '应说明正事分寸（收夸张词不收方言）');
  assert.ok(advanced.includes('方言只是你的措辞'), '应含质量声明');
  for (const bad of ['注意', '不要', '请', '必须', '应该', '记住', '尽量']) {
    assert.ok(!advanced.includes(bad), `加强版不应含指令词「${bad}」`);
  }
});

test('加强版文案：全部方言都有 personaAdvanced，通用硬性约束通过', () => {
  for (const d of DIALECT_LIST) {
    if (d.id === 'userstyle') continue; // v0.30.0：学我说话是动态模板方言，无固定文案
    const advanced = buildDialectPersona(d.id, 'on', 'advanced');
    const normal = buildDialectPersona(d.id, 'on');
    assert.ok(d.personaAdvanced, `${d.id} 应有 personaAdvanced`);
    assert.ok(advanced, `${d.id} 加强版文案不应为空`);
    assert.notEqual(advanced, normal, `${d.id} 加强版应与普通版不同`);
    assert.ok(advanced.length > normal.length, `${d.id} 加强版应比普通版更厚`);
    assert.ok(advanced.includes(`土生土长的${d.people}`), `${d.id} 应为身份化断言`);
    assert.ok(advanced.includes('说话本能'), `${d.id} 应强调「说话本能」`);
    assert.ok(advanced.includes('打字也带着'), `${d.id} 应强调「打字」场景`);
    assert.ok(advanced.includes('情绪的开关'), `${d.id} 应含语气词情绪表`);
    assert.ok(advanced.includes('一个字顶十句表情包'), `${d.id} 应有情绪表收尾`);
    assert.ok(advanced.includes('给人意见会说'), `${d.id} 应有给意见正事示例`);
    assert.ok(advanced.includes('跟人解释东西也一样'), `${d.id} 应有科普正事示例`);
    assert.ok(advanced.includes('夸张的词收着用'), `${d.id} 应说明正事分寸`);
    assert.ok(advanced.includes('方言只是你的措辞'), `${d.id} 应含质量声明`);
    for (const bad of ['注意', '不要', '请', '必须', '应该', '记住', '尽量']) {
      assert.ok(!advanced.includes(bad), `${d.id} 加强版不应含指令词「${bad}」`);
    }
  }
});

test('加强版二轮增量：各方言语序/音调/情绪特征抽查（2026-08-04 深挖）', () => {
  const checks = {
    sichuan: ['得不得行嘛', '吃都吃了', '闹热'],
    dongbei: ['可劲造', '皮儿片儿', '乐呵儿的'],
    henan: ['得劲死了', '嘞吧'],
    shanghai: ['格么', '煞煞齐', '帮帮忙好伐'],
    cantonese: ['俾本书我', '你去唔去先', '好mean'],
    taiwan: ['有在看', '穿看看', '不错吃'],
    shaanxi: ['克里马擦', '日塌啦'],
    // v0.28.0：北京话加强版新增「您」后置、呢还倒装、口头禅；v0.28.1 对照式写法（普通话→北京话）
    beijing: ['得嘞您呐', '不儿道', '吃了吗您', '还没吃呢还', '可说呢', '歇着吧您内', '普通话问'],
    xinjiang: ['给给我', '外江'],
  };
  for (const [id, words] of Object.entries(checks)) {
    const t = buildDialectPersona(id, 'on', 'advanced');
    for (const w of words) {
      assert.ok(t.includes(w), `${id} 加强版应含增量特征「${w}」`);
    }
  }
});

test('加强版特有断言：台湾腔写中国台湾、新疆话有语序特征无馕言文比喻', () => {
  const taiwan = buildDialectPersona('taiwan', 'on', 'advanced');
  assert.ok(taiwan.includes('中国台湾人'), '台湾腔加强版应写明「中国台湾人」');
  assert.ok(taiwan.includes('波浪号'), '台湾腔应含波浪号尾音特征');
  // 新疆话：正经语序路线（拍板不整活），有语序特征、无馕言文夸张比喻
  const xj = buildDialectPersona('xinjiang', 'on', 'advanced');
  assert.ok(xj.includes('饭吃了'), '新疆话加强版应含宾语前置语序特征');
  assert.ok(xj.includes('歹得很'), '新疆话应含夸赞词');
  assert.ok(!xj.includes('雄鹰') && !xj.includes('豹子'), '新疆话加强版不应有馕言文夸张比喻');
});

test('加强版文案：四川话精修保留原特征断言', () => {
  const advanced = buildDialectPersona('sichuan', 'on', 'advanced');
  assert.ok(advanced.includes('香腾了'), '四川话应含程度补语示范');
  assert.ok(advanced.includes('要得不'), '四川话正事示例应含正反问句式');
});

test('配置归一化：boost 开关保留，旧 mode=advanced 迁移为 boost，非法值降级', () => {
  useTempConfig();
  const config = writeDialectConfig({
    version: 2,
    agents: {
      a: { dialect: 'sichuan', enabled: true, mode: 'advanced' },   // 旧加强版 → 迁移为 boost
      b: { dialect: 'sichuan', enabled: true, mode: 'normal' },      // 普通 → 无 boost
      c: { dialect: 'dongbei', enabled: true, mode: 'advanced' },    // 无精修文案的方言也保留（动态回响）
      d: { dialect: 'sichuan', enabled: true, mode: 'max' },         // 非法值 → 无 boost
      e: { dialect: 'sichuan', enabled: true, boost: true },         // 新开关式直接保留
      f: { dialect: 'sichuan', enabled: true, boost: false },        // 显式关闭 → 不写
    },
  });
  assert.deepEqual(config.agents, {
    a: { dialect: 'sichuan', enabled: true, boost: true },
    b: { dialect: 'sichuan', enabled: true },
    c: { dialect: 'dongbei', enabled: true, boost: true },
    d: { dialect: 'sichuan', enabled: true },
    e: { dialect: 'sichuan', enabled: true, boost: true },
    f: { dialect: 'sichuan', enabled: true },
  });
});

test('applyDialectToIshiki：mode=advanced 写入加强版文案，切回 normal 写普通文案', () => {
  const root = makeTempAgentsRoot();
  applyDialectToIshiki('hanako', 'sichuan', 'on', root, 'advanced', { syncConfig: false });
  const persona = readDialectFromIshiki('hanako', root);
  assert.ok(persona.includes('情绪的开关'), '加强版应写入加强文案');
  applyDialectToIshiki('hanako', 'sichuan', 'on', root, 'normal', { syncConfig: false });
  const persona2 = readDialectFromIshiki('hanako', root);
  assert.ok(persona2.includes('说话本能') && !persona2.includes('情绪的开关'), '切回普通版应写普通文案');
});

test('syncDialectToIshiki：配置 boost=true 时同步写入加强版文案', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  const config = { version: 3, agents: { hanako: { dialect: 'sichuan', enabled: true, boost: true } } };
  writeDialectConfig(config);
  syncDialectToIshiki(config, root);
  const persona = readDialectFromIshiki('hanako', root);
  assert.ok(persona.includes('情绪的开关'), '应写入加强版文案');
  assert.ok(persona.includes('土生土长的四川人'), '身份化断言应保留');
});

// ── v0.25.0 加强版开关 = 动态回响层 ──

test('buildDialectEcho：身份化锚点句 + 加强例句池随机示范（50% 概率），零指令词', () => {
  const noEx = buildDialectEcho('sichuan', 0.7);
  assert.ok(noEx.includes('你打字带着四川话味，这轮也照常。'), '应含身份化锚点句');
  assert.ok(!noEx.includes('像「'), 'random>=0.5 不应附例句');

  const withEx = buildDialectEcho('sichuan', 0.3);
  assert.ok(withEx.includes('像「'), 'random<0.5 应附例句');
  assert.ok(withEx.includes('也像「'), '应附两句示范（句式+情绪覆盖面）');
  const ex = withEx.match(/像「(.+?)」那样/);
  assert.ok(ex && BOOST_EXAMPLES.sichuan.includes(ex[1]), '例句应来自加强版回响例句池');

  for (const bad of ['注意', '不要', '请', '必须', '应该', '记住', '尽量']) {
    assert.ok(!noEx.includes(bad), `锚点句不应含指令词「${bad}」`);
    assert.ok(!withEx.includes(bad), `含例句回声不应含指令词「${bad}」`);
  }
  assert.equal(buildDialectEcho('nope', 0.3), '', '无效方言应返回空串');
});

test('加强版回响例句池：九种地方话齐全、句式级短句、零指令词（学我说话无回响）', () => {
  for (const d of DIALECT_LIST) {
    if (d.id === 'userstyle') continue; // v0.30.0：学我说话不额外回响
    const pool = BOOST_EXAMPLES[d.id];
    assert.ok(pool && pool.length >= 3, `${d.id} 应至少有 3 句加强回响例句`);
    for (const ex of pool) {
      assert.ok(ex.length <= 16, `${d.id} 回响例句「${ex}」应保持句式级短句（≤16 字）`);
      for (const bad of ['注意', '不要', '请', '必须', '应该', '记住', '尽量']) {
        assert.ok(!ex.includes(bad), `${d.id} 回响例句「${ex}」不应含指令词「${bad}」`);
      }
    }
  }
  assert.equal(buildDialectEcho('userstyle', 0.1), '', '学我说话不应有回响');
});

test('isWorkTalk：技术/工作关键词命中正事，闲聊放行', () => {
  const work = [
    '帮我看看这个代码 bug',
    '插件报错了，日志贴给你',
    '把新版本部署到服务器',
    '这个 API 接口返回不对',
    'git 提交冲突了怎么办',
    '测试用例跑不过',
    '帮我写个 npm 脚本',
    '数据库配置改一下',
  ];
  for (const t of work) assert.ok(isWorkTalk(t), `「${t}」应判为正事`);

  const chat = [
    '今天天气真好呀',
    '晚上吃啥',
    '想你啦',
    '哈哈哈哈笑死我了',
    '',
    null,
  ];
  for (const t of chat) assert.ok(!isWorkTalk(t), `「${t}」不应判为正事`);
});

test('shouldBoostRound：前 8 条消息必注入，之后按 60% 概率衰减', () => {
  assert.equal(shouldBoostRound(0, 0.99), true, 'warmup 内任意随机值都注入');
  assert.equal(shouldBoostRound(8, 0.99), true, '边界：第 8 条仍在 warmup 内');
  assert.equal(shouldBoostRound(9, 0.3), true, 'warmup 后 random<0.6 注入');
  assert.equal(shouldBoostRound(9, 0.9), false, 'warmup 后 random>=0.6 跳过');
  assert.equal(shouldBoostRound(-1), false, '非法长度不注入');
  assert.equal(shouldBoostRound(NaN), false, 'NaN 长度不注入');
});

// ────────────────────────────────────────────────
//  v0.29.0 路径穿越防护（P0）
//  第一道：normalizeConfig 白名单过滤；第二道：agentIshikiPath resolve 前缀兜底
//  背景：agentId 直接拼进 <agentsRoot>/agents/<agentId>/ishiki.md，
//  以前只排除 __proto__ 等，../../ 能逃出 agents 目录并递归建目录写文件
// ────────────────────────────────────────────────

const ESCAPE_AGENT_IDS = [
  '../evil',
  '..\\evil',
  '.. ',
  '..',
  '.',
  'a/../../b',
  'C:\\x',
  '/abs',
  '\\\\.\\pipe\\x',
  '',
];

const VALID_AGENT_IDS = [
  'hanako',
  'xiaoshenghuo-model-test-agent',
  'A_1-Z',
];

function tmpEscapeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-escape-'));
}

function assertNoEscapeArtifacts(root) {
  const parent = path.resolve(root, '..');
  const evilDir = path.join(parent, 'evil');
  assert.ok(!fs.existsSync(evilDir), 'agents 目录外不应产生目录');
  assert.ok(!fs.existsSync(path.join(root, 'ishiki.md')), 'agents 目录外不应有 ishiki.md');
}

// 第一道：normalizeConfig 白名单（经 writeDialectConfig 保存→读回验证）
test('路径穿越防护：非法 agentId 被过滤，合法 ID 保留，原型污染排除仍生效', () => {
  useTempConfig();
  const agents = {};
  for (const id of ESCAPE_AGENT_IDS) agents[id] = { dialect: 'sichuan', enabled: true };
  agents['__proto__'] = { dialect: 'sichuan', enabled: true };
  for (const id of VALID_AGENT_IDS) agents[id] = { dialect: 'sichuan', enabled: true };

  const saved = writeDialectConfig({ version: 3, agents });
  const ids = Object.keys(saved.agents);
  for (const id of ESCAPE_AGENT_IDS) {
    assert.ok(!ids.includes(id), `非法 agentId ${JSON.stringify(id)} 应被过滤`);
  }
  assert.ok(!ids.includes('__proto__'), '原型污染键仍应被排除');
  for (const id of VALID_AGENT_IDS) {
    assert.ok(ids.includes(id), `合法 agentId ${id} 应保留`);
  }
});

// 第二道：agentIshikiPath 直接对越界 ID 抛错（防绕过 normalizeConfig 的直调）
test('路径穿越防护：agentIshikiPath 对越界 agentId 抛错，合法 ID 落在 agents 目录内', () => {
  const root = tmpEscapeRoot();
  try {
    for (const bad of ESCAPE_AGENT_IDS) {
      assert.throws(() => agentIshikiPath(bad, root), /非法助手ID/, `agentId=${JSON.stringify(bad)} 应被拦下`);
    }
    const okPath = agentIshikiPath('hanako', root);
    assert.ok(okPath.startsWith(path.join(path.resolve(root), 'agents') + path.sep), '合法 ID 应解析在 agents 目录内');
    assert.ok(okPath.endsWith('ishiki.md'), '文件名应保持 ishiki.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 全链路：apply 直调越界 ID 返回结构化失败且不落盘
test('路径穿越防护：applyDialectToIshiki 对越界 agentId 返回 ok:false 且不写文件', () => {
  const root = tmpEscapeRoot();
  try {
    const res = applyDialectToIshiki('../evil', 'sichuan', 'on', root, 'normal', { syncConfig: false });
    assert.equal(res.ok, false, '越界 agentId 应返回失败');
    assert.ok(res.error.includes('非法助手ID'), `错误信息应说明原因，实际: ${res.error}`);
    assertNoEscapeArtifacts(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 全链路：remove 直调越界 ID 同样安全
test('路径穿越防护：removeDialectFromIshiki 对越界 agentId 返回 ok:false 且不碰外部文件', () => {
  const root = tmpEscapeRoot();
  try {
    const res = removeDialectFromIshiki('../../evil', root, { syncConfig: false });
    assert.equal(res.ok, false, '越界 agentId 应返回失败');
    assertNoEscapeArtifacts(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 全链路：sync 恶意配置不逃逸、不炸，合法 ID 正常写入
test('路径穿越防护：syncDialectToIshiki 对恶意配置不逃逸，合法 ID 正常写入', () => {
  useTempConfig();
  const root = tmpEscapeRoot();
  try {
    const results = syncDialectToIshiki(
      {
        version: 3,
        agents: {
          '../evil': { dialect: 'sichuan', enabled: true },
          '..\\evil': { dialect: 'sichuan', enabled: true },
          'hanako': { dialect: 'sichuan', enabled: true },
        },
      },
      root,
    );
    assert.ok(!('..' in results) && !results['../evil'] && !results['..\\evil'], '恶意 agentId 不应出现在同步结果里');
    assert.ok(results['hanako'] && results['hanako'].ok === true, '合法 agentId 应正常写入');
    assertNoEscapeArtifacts(root);
    assert.ok(fs.existsSync(path.join(root, 'agents', 'hanako', 'ishiki.md')), '合法 ID 应写入 agents 目录内');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
