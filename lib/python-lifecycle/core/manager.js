// python-lifecycle · core/manager.js — Python 子进程生命周期管理
// 样板来源：闲不住 lib/fengling.js / 接个话 lib/zhujian.js（两份几乎相同的 start/stop/状态跟踪代码）

import fs from "node:fs";
import { spawn } from "node:child_process";
import { detectPython } from "./detect.js";

/**
 * Python 子进程管理器。
 *
 * const proc = new PythonProcess({
 *   name: "风铃",                          // 日志前缀（[风铃]）
 *   script: "/path/fengling_app.py",       // 脚本绝对路径
 *   args: ["--duration", "90"],           // 可选，追加给脚本的命令行参数
 *   cwd: "/path/python",                   // 工作目录（脚本所在目录）
 *   env: { XIANBUZHU_API: "http://..." },  // 附加环境变量（合并进 process.env）
 *   python: "C:\\Python314\\python.exe",   // 可选，不传自动探测
 *   log: (line) => console.log(line),      // 日志回调（默认 console.log）
 * });
 *
 * await proc.start();    // 幂等：已在运行直接返回 ok
 * await proc.stop();     // kill + 等退出
 * proc.status();         // { running, startedAt, exitCode, error }
 * proc.onExit(cb);       // 注册退出回调
 */
export class PythonProcess {
  constructor({ name = "python", script, args = [], cwd, env = {}, python, log } = {}) {
    if (!script) throw new Error("python-lifecycle: script 必填");
    this.name = name;
    this.script = script;
    this.args = Array.isArray(args) ? args : [];
    this.cwd = cwd;
    this.env = env;
    this.python = python || null;
    this.log = typeof log === "function" ? log : (line) => console.log(line);
    this.child = null;
    this.state = { running: false, startedAt: null, exitCode: null, error: null };
    this._exitHandlers = [];
    this._outBuffer = "";
    this._errBuffer = "";
  }

  /** 启动（幂等：已在运行直接返回 ok）。脚本不存在返回 { ok:false, error } */
  start() {
    if (this.child) return Promise.resolve({ ok: true, message: "已在运行" });
    if (!fs.existsSync(this.script)) {
      return Promise.resolve({ ok: false, error: `${this.script} 不存在` });
    }
    const python = this.python || detectPython();
    const env = { ...process.env, ...this.env, PYTHONDONTWRITEBYTECODE: "1" };

    let child;
    try {
      child = spawn(python, [this.script, ...this.args], {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
    } catch (e) {
      this.state = { running: false, startedAt: null, exitCode: null, error: e.message };
      return Promise.resolve({ ok: false, error: `无法启动 Python：${e.message}` });
    }

    this.child = child;
    this.state = { running: true, startedAt: Date.now(), exitCode: null, error: null };
    this._outBuffer = "";
    this._errBuffer = "";

    child.stdout?.on("data", (chunk) => this._onChunk(chunk, "out"));
    child.stderr?.on("data", (chunk) => this._onChunk(chunk, "err"));

    child.on("error", (err) => {
      this.state.running = false;
      this.state.error = err.message;
      this._emitExit(err.code || null, err.message);
    });
    child.on("exit", (code) => {
      this.state.running = false;
      this.state.exitCode = code;
      this._flushBuffers();
      this._emitExit(code, null);
    });

    return Promise.resolve({ ok: true, message: "已启动" });
  }

  /** 停止：kill 进程，等退出（最多 timeoutMs）。已在停止/未运行幂等。 */
  stop({ timeoutMs = 5000 } = {}) {
    const child = this.child;
    if (!child) return Promise.resolve({ ok: true, message: "未在运行" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.state.error = "停止超时";
        resolve({ ok: false, error: "停止超时" });
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve({ ok: true, message: "已停止" });
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        this.state.error = "kill 失败";
        resolve({ ok: false, error: "kill 失败" });
      }
    });
  }

  /** 当前状态快照 */
  status() {
    return { running: this.state.running, startedAt: this.state.startedAt, exitCode: this.state.exitCode, error: this.state.error };
  }

  /** 注册退出回调（进程崩溃/退出时通知，可用于自动重启等） */
  onExit(cb) {
    if (typeof cb === "function") this._exitHandlers.push(cb);
  }

  _emitExit(code, error) {
    const handlers = this._exitHandlers;
    this._exitHandlers = [];
    this.child = null;
    for (const cb of handlers) {
      try { cb({ exitCode: code, error }); } catch { /* 回调异常不阻塞 */ }
    }
  }

  _onChunk(chunk, kind) {
    const text = chunk.toString("utf-8");
    const buf = kind === "out" ? this._outBuffer : this._errBuffer;
    const flush = kind === "out" ? () => this._outBuffer = "" : () => this._errBuffer = "";
    const lines = (buf + text).split("\n");
    const last = lines.pop(); // 最后一段可能不完整，留到下一块
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed) this.log(`[${this.name}] ${trimmed}`);
    }
    if (kind === "out") this._outBuffer = last; else this._errBuffer = last;
  }

  _flushBuffers() {
    for (const [buf, kind] of [[this._outBuffer, "out"], [this._errBuffer, "err"]]) {
      const trimmed = buf.replace(/\r$/, "");
      if (trimmed) this.log(`[${this.name}] ${trimmed}`);
    }
    this._outBuffer = "";
    this._errBuffer = "";
  }
}
