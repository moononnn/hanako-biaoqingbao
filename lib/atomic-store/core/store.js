// atomic-store · JsonStore：可靠的 JSON 配置读写
// 三个能力：
//   1. 写入不写坏 —— 原子写（临时文件 + rename），崩溃也不留半截文件
//   2. 并发不打架 —— 所有写入走串行队列，读-改-写整段排队，不怕互相覆盖（坑 47）
//   3. 坏了能自愈 —— 写前备份旧文件（顺序正确版，坑 48）；读时损坏自动用备份顶上，
//      再不行用默认值；损坏文件改名留档，绝不删除用户数据

import fs from "node:fs";
import { stripBOM, writeFileAtomic } from "./atomic.js";

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(stripBOM(text)) };
  } catch {
    return { ok: false };
  }
}

export class JsonStore {
  /**
   * @param {string}  filePath 配置文件绝对路径（放插件 data 目录，别放代码目录）
   * @param {object}  defaults 文件不存在 / 损坏且无备份时返回的默认值
   * @param {boolean} backup   写前是否把旧文件备份成 <file>.bak（默认 true）
   */
  constructor({ filePath, defaults = {}, backup = true }) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.backup = backup;
    this.backupPath = `${filePath}.bak`;
    this._queue = Promise.resolve(); // 写入串行队列
  }

  /**
   * 同步读取当前值。
   * 原子写保证读到的总是完整文件（要么旧要么新），所以读取不需要排队。
   * 文件不存在 → defaults 副本；损坏 → 备份顶上 / defaults 兜底，损坏文件留档。
   */
  read() {
    if (!fs.existsSync(this.filePath)) {
      return clone(this.defaults);
    }
    const parsed = tryParse(fs.readFileSync(this.filePath, "utf-8"));
    if (parsed.ok) return parsed.value;

    // 主文件损坏 → 试备份
    if (this.backup && fs.existsSync(this.backupPath)) {
      const bak = tryParse(fs.readFileSync(this.backupPath, "utf-8"));
      if (bak.ok) {
        this._stashCorrupt(this.filePath);
        // 顺手用备份内容把主文件修回来，下次读就是好的（原子写，不阻塞读取）
        try { writeFileAtomic(this.filePath, JSON.stringify(bak.value, null, 2) + "\n"); } catch { /* ignore */ }
        return bak.value;
      }
    }
    // 备份也没有 / 也坏了 → 默认值兜底
    this._stashCorrupt(this.filePath);
    return clone(this.defaults);
  }

  /** 整体覆盖写入（走队列）。返回 Promise，完成后才落盘。 */
  write(data) {
    const run = this._queue.then(() => {
      this._writeNow(data);
    });
    // 单次失败不能卡死后续写入
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * 读-改-写：mutator 就地修改最新值后自动保存。
   * 整段在队列里执行，天然防「两个 update 基于同一个旧对象互相覆盖」（坑 47）。
   */
  update(mutator) {
    const run = this._queue.then(() => {
      const current = this._readRaw();
      mutator(current);
      this._writeNow(current);
    });
    this._queue = run.catch(() => {});
    return run;
  }

  /** 队列内直接读文件拿最新值；损坏时走 read() 的自愈逻辑 */
  _readRaw() {
    if (!fs.existsSync(this.filePath)) return clone(this.defaults);
    const parsed = tryParse(fs.readFileSync(this.filePath, "utf-8"));
    if (parsed.ok) return parsed.value;
    return this.read();
  }

  _writeNow(data) {
    const content = JSON.stringify(data, null, 2) + "\n";
    if (this.backup && fs.existsSync(this.filePath)) {
      // 坑 48 教训：先备份旧文件，再写新文件。
      // 顺序反了的话 .bak 就变成刚写入的内容，损坏时完全没法回退。
      try { fs.copyFileSync(this.filePath, this.backupPath); } catch { /* 备份失败不阻塞写入 */ }
    }
    writeFileAtomic(this.filePath, content);
  }

  /** 损坏文件改名留档：<file>.corrupt-<时间戳>，绝不删除用户数据 */
  _stashCorrupt(filePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${stamp}`);
    } catch { /* 留档失败不阻塞 */ }
  }
}
