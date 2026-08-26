import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = fs.readFileSync(path.join(ROOT, 'routes', 'api.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'routes', 'ui.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'assets', 'sticker-manager.js'), 'utf8');
const PICKER = fs.readFileSync(path.join(ROOT, 'lib', 'pick-folder.ps1'), 'utf8');

function pickerRouteSource() {
  const start = API.indexOf("  app.post('/api/export/pick-folder'");
  const end = API.indexOf("  // ═══ GET /api/list", start);
  assert.ok(start >= 0, '导出目录选择路由应存在');
  assert.ok(end > start, '导出目录选择路由应有明确结束位置');
  return API.slice(start, end);
}

test('原生目录选择脚本使用 FolderBrowserDialog，并保留中文路径编码', () => {
  assert.match(PICKER, /FolderBrowserDialog/);
  assert.match(PICKER, /-PathType Container/);
  assert.match(PICKER, /OutputEncoding/);
  assert.match(PICKER, /ShowDialog\(\)/);
  assert.match(PICKER, /Write-Output \$f\.SelectedPath/);
});

test('导出目录路由使用 PowerShell STA，并把取消选择作为正常分支', () => {
  const route = pickerRouteSource();
  assert.match(route, /pick-folder\.ps1/);
  assert.match(API, /\['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA'/);
  assert.match(route, /runFolderPicker\(ps1, initial\)/);
  assert.match(route, /if \(!picked\) return json\(\{ ok: false, error: '没有选择文件夹' \}\)/);
  assert.match(route, /return json\(\{ ok: true, data: \{ directory: outputDir \} \}\)/);
  assert.doesNotMatch(route, /writeLastExportDir/);
});

test('导出目录路由会拒绝无效路径和非文件夹', () => {
  const route = pickerRouteSource();
  assert.match(route, /const outputDir = normalizeOutputDir\(picked\)/);
  assert.match(route, /if \(!outputDir\) return json\(\{ ok: false, error: '选择的路径无效' \}, 400\)/);
  assert.match(route, /stat = fs\.statSync\(outputDir\)/);
  assert.match(route, /!stat\.isDirectory\(\)/);
});

test('导出弹窗接入选择按钮，前端回显所选目录但由正式导出保存最近路径', () => {
  assert.match(UI, /id="export-pick-folder"/);
  assert.match(CLIENT, /API \+ '\/api\/export\/pick-folder'/);
  assert.match(CLIENT, /body: JSON\.stringify\(\{ initial: input \? input\.value\.trim\(\) : '' \}\)/);
  assert.match(CLIENT, /input\.value = directory/);
  assert.match(CLIENT, /addEventListener\('click', pickExportFolder\)/);
  assert.match(CLIENT, /已取消选择文件夹/);
});
