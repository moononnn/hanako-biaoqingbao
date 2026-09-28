import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'assets', 'sticker-manager.js'), 'utf8');

test('茶话会记录提供直接编辑标签入口，并绑定指定 stickerId', () => {
  assert.match(source, /data-act="open-editor"/);
  assert.match(source, /data-sticker=.*cr\.stickerId/);
  assert.match(source, /if \(editSticker\) openEditor\(editSticker\)/);
});

test('编辑标签保存后刷新图库与茶话会记录', () => {
  assert.match(source, /await loadStickers\(\);\s*await refreshPreferences\(\);/);
});
