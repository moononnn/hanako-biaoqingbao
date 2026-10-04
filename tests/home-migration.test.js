import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const sharedUrl = new URL('../lib/shared.js', import.meta.url).href;
const coreUrl = new URL('../lib/ball-core.js', import.meta.url).href;

function probe(home) {
  const script = `
    import { HANA_HOME, DATA_DIR, STICKERS_DIR } from ${JSON.stringify(sharedUrl)};
    import { safeStickerPath } from ${JSON.stringify(coreUrl)};
    console.log(JSON.stringify({ home: HANA_HOME, data: DATA_DIR, root: STICKERS_DIR,
      image: safeStickerPath(STICKERS_DIR, 'sample.png'),
      escape: safeStickerPath(STICKERS_DIR, 'linked/secret.png'),
      newEscape: safeStickerPath(STICKERS_DIR, 'linked/new.png') }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HANA_HOME: home }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-home-migration-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function junction(t, target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Cannot create directory link: ${error.code}`);
      return false;
    }
    throw error;
  }
  return true;
}

test('whole-home relocation resolves only the sticker home and keeps internal escape checks', (t) => {
  const base = fixture(t);
  const home = path.join(base, 'new-home');
  const oldHome = path.join(base, 'old-home');
  const root = path.join(home, 'plugin-data', 'biaoqingbao', 'stickers');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'sample.png'), 'image');
  fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
  if (!junction(t, home, oldHome) || !junction(t, outside, path.join(root, 'linked'))) return;
  const result = probe(oldHome);
  const realHome = fs.realpathSync.native(home);
  const realRoot = path.join(realHome, 'plugin-data', 'biaoqingbao', 'stickers');
  assert.equal(result.home, oldHome);
  assert.equal(result.data, path.join(oldHome, 'plugin-data', 'biaoqingbao'));
  assert.equal(result.root, realRoot);
  assert.equal(result.image, path.join(realRoot, 'sample.png'));
  assert.equal(result.escape, null);
  assert.equal(result.newEscape, null);
});

test('a separately redirected sticker root is still rejected', (t) => {
  const base = fixture(t);
  const home = path.join(base, 'home');
  const data = path.join(home, 'plugin-data', 'biaoqingbao');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sample.png'), 'secret');
  if (!junction(t, outside, path.join(data, 'stickers'))) return;
  assert.equal(probe(home).image, null);
});

test('a not-yet-created home keeps its original path', (t) => {
  const home = path.join(fixture(t), 'future-home');
  const result = probe(home);
  assert.equal(result.home, home);
  assert.equal(result.root, path.join(home, 'plugin-data', 'biaoqingbao', 'stickers'));
});
