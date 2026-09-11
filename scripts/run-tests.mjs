// 源码仓库与发布包共用的测试入口。
//
// 发布包排除了 tests/，此时直接跑 `node --test tests/*.test.js` 会得到
// 「tests 0 / pass 0 / fail 0 / exit 0」的假绿灯，骗过自动审查。
// 这里先做存在性检查：找不到测试文件就非零退出，明确报错。

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 锚定到仓库根（脚本上一级），不依赖调用时的当前目录。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_DIR = join(ROOT, 'tests');

if (!existsSync(TEST_DIR)) {
  console.error('[test] 找不到 tests/ 目录。测试只在源码仓库里跑，安装包不包含测试文件。');
  process.exit(1);
}

const files = readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js'));
if (files.length === 0) {
  console.error('[test] tests/ 下没有 *.test.js，拒绝以「零测试」冒充通过。');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', ...files.map((name) => join(TEST_DIR, name))],
  { stdio: 'inherit', cwd: ROOT },
);

process.exit(result.status ?? 1);
