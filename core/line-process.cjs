'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

// 两个官方 CLI 都使用 UTF-8 JSONL；不经过 shell，也不记录原始输出或凭据。
class LineProcess extends EventEmitter {
  constructor(executable, args, cwd, name, environment) {
    super();
    this.name = name;
    this.closed = false;
    this.buffer = '';
    this.child = spawn(executable, args, { cwd, env: environment, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.buffer = this.buffer.slice(index + 1);
        if (!this.readLine(line)) return;
      }
      if (this.buffer.length > 32 * 1024 * 1024) this.fail(new Error(`${name} 返回的数据超过限制。`));
    });
    this.child.stderr.resume();
    this.child.on('error', () => this.fail(new Error(`无法启动 ${name}，请检查可执行文件路径。`)));
    this.child.stdin.on('error', () => this.fail(new Error(`${name} 输入通道已关闭。`)));
    this.child.on('close', code => {
      if (this.buffer.trim()) this.readLine(this.buffer);
      this.buffer = '';
      this.closed = true;
      this.emit('close', code);
    });
  }

  readLine(line) {
    if (!line.trim()) return true;
    if (line.length > 32 * 1024 * 1024) { this.fail(new Error(`${this.name} 返回的数据超过限制。`)); return false; }
    try { this.emit('message', JSON.parse(line)); return true; }
    catch { this.fail(new Error(`${this.name} 返回的协议数据无法解析。`)); return false; }
  }

  send(message) {
    if (this.closed || this.child.stdin.destroyed) throw new Error(`${this.name} 连接已关闭。`);
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  fail(error) { this.emit('fault', error); this.stop(); }
  stop() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.destroy();
    this.child.kill();
  }
}

module.exports = { LineProcess };
