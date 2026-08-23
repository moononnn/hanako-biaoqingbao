// atomic-store · 原子配置存储积木
// 用法见 README.md；测试：cd atomic-store && node --test tests/

import { JsonStore } from "./core/store.js";
export { JsonStore };
export { stripBOM, writeFileAtomic } from "./core/atomic.js";

/**
 * 便捷工厂：不需要继承/引类时的最简入口。
 * 返回 { read, write, update, filePath, backupPath }
 */
export function createJsonStore(opts) {
  const store = new JsonStore(opts);
  return {
    read: () => store.read(),
    write: (data) => store.write(data),
    update: (mutator) => store.update(mutator),
    filePath: store.filePath,
    backupPath: store.backupPath,
  };
}
