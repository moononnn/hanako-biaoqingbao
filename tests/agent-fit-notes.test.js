// 伙伴配图自评账本回归：独立记账、只降不升、开关关闭即失效、删图清理。
// 覆盖 lib/agent-fit-notes.js 与 shared.prefsScoreBonus 的接入点。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyAgentFitNote,
  readAgentFits,
  readAgentFitNotes,
  listAgentFitNotes,
  removeAgentFitEntry,
  removeStickerAgentFitNotes,
  isAgentSelfNoteEnabled,
  agentFitPenalty,
} from '../lib/agent-fit-notes.js';
import { prefsScoreBonus } from '../lib/shared.js';
import { buildStickerArchiveText } from '../tools/express.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-agent-fit-'));
}

function disableSelfNote(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'display-config.json'), JSON.stringify({ agentSelfNote: false }));
}

test('自评按伙伴和情绪隔离，off/on 分别计数', async () => {
  const dataDir = tempDir();
  await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a', fit: 'off' });
  await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a', fit: 'off' });
  await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '开心', stickerId: 'stk_a', fit: 'off' });
  await applyAgentFitNote({ dataDir, agentId: 'yumi', emotion: '委屈', stickerId: 'stk_a', fit: 'off' });
  await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_b', fit: 'on' });

  const hanakoSad = readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '委屈' });
  assert.equal(hanakoSad.stk_a, 2);
  assert.equal(hanakoSad.stk_b, undefined, 'on 不参与降权');
  assert.deepEqual(readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }), { stk_a: 1 });
  assert.deepEqual(readAgentFits({ dataDir, agentId: 'yumi', contextEmotion: '委屈' }), { stk_a: 1 });
  assert.deepEqual(readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '得意' }), {});
});

test('off 计数封顶：再标也不继续加码', async () => {
  const dataDir = tempDir();
  for (let i = 0; i < 6; i += 1) {
    await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '无语', stickerId: 'stk_a', fit: 'off' });
  }
  assert.equal(readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '无语' }).stk_a, 3);
});

test('降权只减不增，且不吃用户的偏好权重', async () => {
  assert.equal(prefsScoreBonus('stk_a', { agentFits: { stk_a: 1 } }), -4);
  assert.equal(prefsScoreBonus('stk_a', { agentFits: { stk_a: 3 } }), -12);
  assert.equal(prefsScoreBonus('stk_a', { agentFits: { stk_a: 9 } }), -12, '超过上限仍按上限算');
  assert.equal(prefsScoreBonus('stk_a', { agentFits: {} }), 0);
  assert.equal(prefsScoreBonus('stk_a', { agentFits: { stk_b: 3 } }), 0, '不影响别的图');
  // 用户的喜欢照旧加分，两者互不覆盖
  assert.equal(prefsScoreBonus('stk_a', { preferred: ['stk_a'], agentFits: { stk_a: 1 } }), 6);
  // 伙伴自评不会把用户拉黑的图重新捞回来：vetoed 依旧是硬排除，这里只验证分值仍显著为负
  assert.ok(prefsScoreBonus('stk_a', { vetoed: ['stk_a'], agentFits: { stk_a: 1 } }) < 0);
  assert.equal(agentFitPenalty(2), 8);
  assert.equal(agentFitPenalty(99), 12);
});

test('用户关掉开关后：不再记录、不再生效，但已记的账保留', async () => {
  const dataDir = tempDir();
  await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a', fit: 'off' });
  assert.equal(isAgentSelfNoteEnabled({ dataDir }), true);

  disableSelfNote(dataDir);
  assert.equal(isAgentSelfNoteEnabled({ dataDir }), false);
  assert.deepEqual(readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '委屈' }), {}, '关闭后不生效');
  const blocked = await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a', fit: 'off' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 403);
  assert.equal(readAgentFitNotes({ dataDir }).byAgent.hanako['委屈'].stk_a.off, 1, '数据没有被清掉');

  fs.rmSync(path.join(dataDir, 'display-config.json'));
  assert.equal(readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '委屈' }).stk_a, 1, '重开后原记录恢复生效');
});

test('开关只在明确写 false 时才关闭，其他字段的旧配置视为开启', async () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'display-config.json'), JSON.stringify({ smallImageFit: true, sizeMode: 'auto' }));
  assert.equal(isAgentSelfNoteEnabled({ dataDir }), true);
  fs.writeFileSync(path.join(dataDir, 'display-config.json'), 'not-json');
  assert.equal(isAgentSelfNoteEnabled({ dataDir }), true);
});

test('非法参数与缺失字段一律拒绝，不写脏数据', async () => {
  const dataDir = tempDir();
  assert.equal((await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: '', fit: 'off' })).ok, false);
  assert.equal((await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '', stickerId: 'stk_a', fit: 'off' })).ok, false);
  assert.equal((await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a', fit: 'maybe' })).ok, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'agent-fit-notes.json')), false);
});

test('并发写入不丢记录（写队列串行化）', async () => {
  const dataDir = tempDir();
  await Promise.all([
    applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a', fit: 'off' }),
    applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_b', fit: 'off' }),
    applyAgentFitNote({ dataDir, agentId: 'yumi', emotion: '委屈', stickerId: 'stk_a', fit: 'on' }),
    applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '开心', stickerId: 'stk_a', fit: 'off' }),
  ]);
  const hanakoSad = readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '委屈' });
  assert.equal(hanakoSad.stk_a, 1);
  assert.equal(hanakoSad.stk_b, 1);
  assert.equal(readAgentFits({ dataDir, agentId: 'yumi', contextEmotion: '委屈' }).stk_a, undefined);
  assert.equal(readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }).stk_a, 1);
});

test('删图清理所有伙伴、所有情境下的自评引用', async () => {
  const dataDir = tempDir();
  await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a', fit: 'off' });
  await applyAgentFitNote({ dataDir, agentId: 'yumi', emotion: '无语', stickerId: 'stk_a', fit: 'on' });
  await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_b', fit: 'off' });
  const result = await removeStickerAgentFitNotes({ dataDir, stickerId: 'stk_a' });
  assert.equal(result.removed, true);
  assert.deepEqual(readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '委屈' }), { stk_b: 1 });
  assert.equal(readAgentFits({ dataDir, agentId: 'yumi', contextEmotion: '无语' }).stk_a, undefined);
});

test('管理页移除单条是整条删除；列表按时间倒序、带 note', async () => {
  const dataDir = tempDir();
  await applyAgentFitNote({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a', fit: 'off', note: '画面太闹', now: 1000 });
  await applyAgentFitNote({ dataDir, agentId: 'yumi', emotion: '得意', stickerId: 'stk_b', fit: 'on', now: 2000 });
  const rows = listAgentFitNotes({ dataDir });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stickerId, 'stk_b', '最近的在最前');
  assert.equal(rows[0].agentId, 'yumi');
  assert.equal(rows[1].note, '画面太闹');

  const removed = await removeAgentFitEntry({ dataDir, agentId: 'hanako', emotion: '委屈', stickerId: 'stk_a' });
  assert.equal(removed.removed, true);
  assert.equal(listAgentFitNotes({ dataDir }).length, 1);
  assert.deepEqual(readAgentFits({ dataDir, agentId: 'hanako', contextEmotion: '委屈' }), {});
});

test('express 回包：给档案、给归属、给退路，不再暴露匹配分', () => {
  const sticker = {
    id: 'stk_473',
    description: '古装小人趴着嘟嘴半眯眼，委屈倔强',
    semantic_description: '适合想表达委屈又嘴硬时发',
    tags: { emotion: ['委屈', '倔强', '傲娇'], scene: ['被搭讪'], keywords: ['古装', '汉服'] },
  };
  const text = buildStickerArchiveText(sticker, '委屈');
  assert.ok(text.includes('画面：古装小人趴着嘟嘴半眯眼，委屈倔强'));
  assert.ok(text.includes('适合表达：适合想表达委屈又嘴硬时发'));
  assert.ok(text.includes('情绪：委屈、倔强、傲娇'));
  assert.ok(text.includes('不用交代来历'));
  assert.ok(text.includes('note_sticker_fit'));
  assert.ok(!text.includes('匹配度'), '分数不再外露');
  assert.ok(!text.includes('stk_473'), '内部 ID 不外露');
  assert.ok(!text.includes('汉服'), 'keywords 全量不给');

  // 缺语义描述时不硬凑空行
  const bare = buildStickerArchiveText({ id: 'stk_x', description: '一张图', tags: {} }, '开心');
  assert.ok(!bare.includes('适合表达：'));
  assert.ok(!bare.includes('情绪：'));
});

test('伙伴名对照缺省时列表仍可用（只影响展示，不影响记账）', async () => {
  const dataDir = tempDir();
  await applyAgentFitNote({ dataDir, agentId: 'unknown-agent', emotion: '开心', stickerId: 'stk_a', fit: 'on' });
  const rows = listAgentFitNotes({ dataDir });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, 'unknown-agent');
  assert.equal(rows[0].on, 1);
});
