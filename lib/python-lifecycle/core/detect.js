// python-lifecycle · core/detect.js — Python 命令探测 + 依赖检查
// 样板来源：闲不住 lib/fengling.js 的 detectPython / checkFenglingDeps（竹简 zhujian.js 几乎同款复制）

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_CANDIDATES = [
  "C:\\Python314\\python.exe",
  "C:\\Python313\\python.exe",
  "C:\\Python312\\python.exe",
  "python",
  "python3",
  "py", // Windows Python Launcher（无 -3 前缀：现代 Windows 默认就是 Python 3）
];

let _cachedPython = null;

/**
 * 探测可用的 Python 命令：
 * - 绝对路径候选：existsSync 直接查
 * - PATH 命令候选：spawnSync --version 真实执行探测（existsSync 查不到 PATH 里的命令）
 * 全都不行返回兜底 "python"（让后续 spawn 报错时给友好提示，而不是在这里炸）。
 * 结果有模块级缓存（插件生命周期内只探测一次）。
 */
export function detectPython({ candidates = DEFAULT_CANDIDATES, timeoutMs = 3000 } = {}) {
  if (_cachedPython) return _cachedPython;
  const list = Array.isArray(candidates) && candidates.length ? candidates : DEFAULT_CANDIDATES;
  for (const p of list) {
    if (/[\\/]/.test(p)) {
      if (fs.existsSync(p)) {
        _cachedPython = p;
        return p;
      }
    } else {
      try {
        const result = spawnSync(p, ["--version"], { timeout: timeoutMs, windowsHide: true });
        if (result.status === 0) {
          _cachedPython = p;
          return p;
        }
      } catch {
        // 继续下一个候选
      }
    }
  }
  _cachedPython = "python";
  return _cachedPython;
}

/** 清空探测缓存（测试用 / 用户新装了 Python 后重探） */
export function resetPythonCache() {
  _cachedPython = null;
}

/**
 * 依赖检查：跑一段探测代码（如 import PyQt6），带超时和结果缓存。
 * 返回 { ok, python, error }；cacheMs 内重复调用直接回缓存。
 * 探测代码必须能干净退出（exit 0 = 通过）。
 */
export function checkDeps({
  python,
  probeCode = "import sys; sys.exit(0)",
  timeoutMs = 15000,
  cacheMs = 30000,
  candidates,
} = {}) {
  const py = python || detectPython({ candidates });
  if (_depsCache && _depsCache.python === py && Date.now() - _depsCacheTime < cacheMs) {
    return Promise.resolve(_depsCache);
  }
  return runProbe(py, probeCode, timeoutMs).then((result) => {
    _depsCache = { ...result, python: py };
    _depsCacheTime = Date.now();
    return _depsCache;
  });
}

let _depsCache = null;
let _depsCacheTime = 0;

/** 清空依赖检查缓存（测试用） */
export function resetDepsCache() {
  _depsCache = null;
  _depsCacheTime = 0;
}

/** 核心：spawn 跑一段代码，等退出，超时 kill。不缓存，checkDeps 负责缓存。 */
export function runProbe(python, code, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ["-c", code], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, error: "无法启动 Python" });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, error: "依赖检查超时" });
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, error: "Python 不存在或无法执行" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? null : `探测代码退出码 ${code}` });
    });
  });
}

/**
 * 跑一个脚本文件并收集 stdout（一次性探测脚本模式：全屏检测 / 环境检查等）。
 * spawn + 限长收集 + 超时 kill；退出码非 0 不算异常（调用方按业务判断，如 check_env 用退出码区分全屏）。
 * 返回 { ok, stdout, exitCode, error }；ok 仅表示 exitCode === 0。不缓存。
 */
export function runScript(python, scriptPath, args = [], { timeoutMs = 15000, maxOutput = 65536 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [scriptPath, ...(Array.isArray(args) ? args : [])], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, stdout: "", exitCode: null, error: "无法启动 Python" });
      return;
    }
    let output = "";
    child.stdout.on("data", (chunk) => {
      if (output.length < maxOutput) {
        output += chunk.toString().slice(0, maxOutput - output.length);
      }
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, stdout: output, exitCode: null, error: "脚本执行超时" });
    }, timeoutMs);
    child.on("error", () => {
      finish({ ok: false, stdout: output, exitCode: null, error: "Python 不存在或无法执行" });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout: output, exitCode: code, error: code === 0 ? null : `脚本退出码 ${code}` });
    });
  });
}
