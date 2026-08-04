// 发布前检查：验证 routes/ui.js 里配图卡片模板的内联脚本语法（坑 2.5）
import fs from 'node:fs';

const src = fs.readFileSync('routes/ui.js', 'utf8');
const anchor = 'window.__STICKER__ = ${STICKER_CFG};';
const idx = src.indexOf(anchor);
if (idx < 0) {
  console.log('anchor not found');
  process.exit(1);
}
const scriptStart = src.indexOf('<script>', idx) + '<script>'.length;
const scriptEnd = src.indexOf('</script>', scriptStart);
let code = src.slice(scriptStart, scriptEnd);
// 把模板插值 ${...} 替换为合法占位
code = code.replace(/\$\{([^}]+)\}/g, 'null');
try {
  // eslint-disable-next-line no-new-func
  new Function(code);
  console.log('CARD INLINE SCRIPT SYNTAX OK (' + code.length + ' chars)');
} catch (e) {
  console.log('CARD INLINE SCRIPT SYNTAX FAIL: ' + e.message);
  process.exit(1);
}
