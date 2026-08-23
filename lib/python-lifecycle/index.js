// python-lifecycle · Python 子进程管理积木
// 用法见 README.md；测试：cd python-lifecycle && node --test tests/

export {
  detectPython,
  resetPythonCache,
  checkDeps,
  resetDepsCache,
  runProbe,
  runScript,
} from "./core/detect.js";
export { PythonProcess } from "./core/manager.js";
