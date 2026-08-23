// ipc-server · core/server.js — 本地 HTTP IPC 服务
// 样板来源：闲不住 lib/fengling.js 的 startProxy（随机 token + Bearer 校验 + 127.0.0.1 + 无 CORS），
//           接个话 lib/zhujian.js 几乎同款（端口 18903）。
// 安全基线（与风铃一致并强化）：
//   - 只绑 127.0.0.1（不对外网卡暴露）
//   - 随机 token 鉴权：Authorization: Bearer <token>，不匹配一律 401
//   - 默认无 CORS（本地进程不走浏览器 CORS；任意网页无法跨域调用）
//   - body 限长（默认 1MB），非法 JSON 400，超限 413

import http from "node:http";
import crypto from "node:crypto";

const DEFAULT_MAX_BODY = 1024 * 1024; // 1MB

/**
 * const ipc = new LocalIpcServer({
 *   port: 18902,                                   // 省略或 0 = 自动选空闲端口
 *   token: "hex",                                  // 省略自动生成（crypto.randomBytes(24)）
 *   cors: false,                                   // 默认无 CORS；true = 浏览器调试用
 *   maxBodyBytes: 1024 * 1024,
 *   log: (line) => console.log(line),
 * });
 * ipc.route("POST", "/api/visit", async ({ body }) => {
 *   if (!body?.to) return { status: 400, body: { ok: false, error: "缺 to" } };
 *   return { ok: true, message: "done" };          // 直接返回对象 = 200 JSON
 * });
 * await ipc.start();                               // 幂等
 * ipc.url    // "http://127.0.0.1:18902"
 * ipc.token  // 传给 python 子进程（env 注入）
 * await ipc.stop();
 */
export class LocalIpcServer {
  constructor({ port = 0, host = "127.0.0.1", token, cors = false, maxBodyBytes = DEFAULT_MAX_BODY, log } = {}) {
    this.port = port;
    this.host = host;
    this.token = token || crypto.randomBytes(24).toString("hex");
    this.cors = Boolean(cors);
    this.maxBodyBytes = maxBodyBytes || DEFAULT_MAX_BODY;
    this.log = typeof log === "function" ? log : () => {};
    this._routes = []; // { method, path, handler }
    this._server = null;
    this._started = false;
    this._actualPort = null;
  }

  /** 注册路由：method 大写（"GET"/"POST"/...），path 精确匹配，handler 返回对象自动 JSON */
  route(method, path, handler) {
    if (typeof handler !== "function") throw new Error("ipc-server: handler 必须是函数");
    this._routes.push({ method: String(method).toUpperCase(), path, handler });
  }

  /** 启动（幂等）。端口被占返回 { ok:false, error }，不抛。 */
  start() {
    if (this._started) return Promise.resolve({ ok: true, message: "已在运行" });
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on("error", (err) => {
        this._server = null;
        this._started = false;
        if (err.code === "EADDRINUSE") {
          resolve({ ok: false, error: `端口 ${this.port} 已被占用` });
        } else {
          resolve({ ok: false, error: err.message });
        }
      });
      server.listen(this.port, this.host, () => {
        this._server = server;
        this._started = true;
        this._actualPort = server.address().port;
        resolve({ ok: true, message: `已监听 ${this.host}:${this._actualPort}` });
      });
    });
  }

  /** 停止（幂等）。未启动返回 ok。 */
  stop() {
    if (!this._server) return Promise.resolve({ ok: true, message: "未在运行" });
    return new Promise((resolve) => {
      this._server.close(() => {
        this._server = null;
        this._started = false;
        resolve({ ok: true, message: "已停止" });
      });
      // close 等现有连接结束；超时强制释放（防止 keep-alive 挂住）
      setTimeout(() => {
        if (this._server) {
          try { this._server.closeAllConnections?.(); } catch { /* ignore */ }
        }
      }, 3000).unref?.();
    });
  }

  /** 当前地址（start 之后可用） */
  get url() {
    return `http://${this.host}:${this._actualPort || this.port}`;
  }

  get running() {
    return this._started;
  }

  _handle(req, res) {
    const send = (status, obj) => {
      const body = JSON.stringify(obj ?? {});
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        ...(this.cors ? {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        } : {}),
      });
      res.end(body);
    };

    // 鉴权：Bearer token
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${this.token}`) {
      send(401, { ok: false, error: "unauthorized" });
      return;
    }

    // CORS preflight（仅 cors 开启时）
    if (req.method === "OPTIONS") {
      if (!this.cors) {
        send(404, { ok: false, error: "not found" });
        return;
      }
      send(204, null);
      return;
    }

    // 路由匹配
    const route = this._routes.find((r) => r.method === req.method && r.path === req.url.split("?")[0]);
    if (!route) {
      send(404, { ok: false, error: "not found" });
      return;
    }

    this._readBody(req).then(({ bodyText, error, status }) => {
      if (error) {
        send(status, { ok: false, error });
        return;
      }
      let parsed = undefined;
      if (bodyText) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          send(400, { ok: false, error: "body 不是合法 JSON" });
          return;
        }
      }
      return Promise.resolve()
        .then(() => route.handler({
          body: parsed,
          headers: req.headers,
          method: req.method,
          url: req.url,
        }))
        .then(
        (result) => {
          if (result && typeof result === "object" && "status" in result && "body" in result) {
            send(result.status, result.body);
          } else {
            send(200, result ?? { ok: true });
          }
        },
        (err) => {
          this.log(`[ipc-server] 路由异常: ${err?.message || err}`);
          send(500, { ok: false, error: "内部错误" });
        }
      );
    });
  }

  _readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          // 超限：不再累积，丢弃后续数据并响应 413。
          // 不能 req.destroy()——会掐断连接，客户端 fetch 收不到响应直接报 socket 错误。
          req.removeAllListeners("data");
          req.on("data", () => {});
          resolve({ error: "body 太大", status: 413 });
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve({ bodyText: Buffer.concat(chunks).toString("utf-8") }));
      req.on("error", () => resolve({ error: "读取 body 失败", status: 400 }));
    });
  }
}
