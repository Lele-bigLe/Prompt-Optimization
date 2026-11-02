'use strict';

const http = require('node:http');
const { EventEmitter } = require('node:events');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { LineProcess } = require('../core/line-process.cjs');

class Bridge extends EventEmitter {
  constructor(executable, cwd, configArgs, token) {
    super();
    this.sequence = 0;
    this.generation = 0;
    this.pending = new Map();
    this.frontRequests = new Map();
    this.token = token;
    this.closed = false;
    const environment = { ...process.env };
    delete environment.CODEX_THREAD_ID; delete environment.CODEX_SESSION_ID;
    this.backend = new LineProcess(executable, [...configArgs, 'app-server', '--listen', 'stdio://'], cwd, 'Codex 主会话', environment);
    this.backend.on('message', message => this.receive(message));
    this.backend.on('fault', error => this.fail(error));
    this.backend.on('close', () => this.fail(new Error('Codex 主服务已结束。')));
  }

  invalidate() {
    this.generation++;
    this.binding = null;
    this.emit('changed');
  }

  async listen() {
    let WebSocketServer;
    try { ({ WebSocketServer } = require('ws')); }
    catch { throw new Error('CLI 缺少 ws 依赖，请先在 cli 目录运行 npm install。'); }
    this.http = http.createServer((_request, response) => response.writeHead(404).end());
    this.server = new WebSocketServer({ server: this.http, maxPayload: 32 * 1024 * 1024,
      verifyClient: ({ req }) => {
        const authorization = Buffer.from(req.headers.authorization || '');
        const expected = Buffer.from('Bearer ' + this.token);
        return !req.headers.origin && !this.front && authorization.length === expected.length && timingSafeEqual(authorization, expected);
      },
    });
    this.server.on('error', () => this.fail(new Error('本地 Codex 连接失败。')));
    this.server.on('connection', socket => {
      this.front = socket;
      let cachedInitialize = false;
      socket.on('error', () => socket.close());
      socket.on('close', () => {
        if (this.front === socket) { this.front = null; this.invalidate(); }
      });
      socket.on('message', (bytes, binary) => {
        try {
          if (binary) throw new Error('Only JSON text frames are accepted');
          const message = JSON.parse(bytes.toString('utf8'));
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
          if (message.method === 'initialize' && this.initialized) {
            cachedInitialize = true;
            socket.send(JSON.stringify({ id: message.id, result: this.initialized })); return;
          }
          if (message.method === 'initialized' && cachedInitialize) return;
          if (message.id !== undefined && message.method) {
            if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) this.invalidate();
            this.frontRequests.set(JSON.stringify(message.id), { request: message, generation: this.generation });
            if (message.method === 'thread/unsubscribe' && message.params?.threadId === this.binding?.id) this.invalidate();
            if (message.method === 'turn/start' && message.params?.threadId === this.binding?.id) {
              if (typeof message.params.model === 'string') this.binding.model = message.params.model;
              this.binding.empty = false;
              this.binding.busy = true; this.generation++; this.emit('changed');
            }
          }
          this.backend.send(message);
        } catch { socket.close(1008, 'Invalid protocol message'); }
      });
    });
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', resolve);
    });
    return 'ws://127.0.0.1:' + this.http.address().port;
  }

  receive(message) {
    const internal = this.pending.get(message.id);
    if (internal && !message.method) {
      this.pending.delete(message.id); clearTimeout(internal.timer);
      if (message.error) internal.reject(new Error(`读取当前会话失败（${message.error.code}），未修改草稿。`));
      else internal.resolve(message.result);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const tracked = this.frontRequests.get(JSON.stringify(message.id));
      const request = tracked?.request;
      this.frontRequests.delete(JSON.stringify(message.id));
      if (request?.method === 'initialize' && message.result) this.initialized = message.result;
      if (request && tracked.generation === this.generation && ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method) && message.result?.thread?.id) {
        const result = message.result;
        this.binding = { id: result.thread.id, cwd: result.cwd || result.thread.cwd, model: result.model, busy: result.thread.status?.type === 'active', empty: request.method === 'thread/start' && Array.isArray(result.thread.turns) && result.thread.turns.length === 0 };
        this.generation++; this.emit('changed');
      }
    }
    const params = message.params;
    if (this.binding && params?.threadId === this.binding.id) {
      if (['turn/started', 'turn/completed', 'thread/closed', 'thread/archived', 'thread/compacted'].includes(message.method)) {
        if (['thread/closed', 'thread/archived'].includes(message.method)) this.binding = null;
        else {
          this.binding.busy = message.method === 'turn/started';
          if (['turn/started', 'turn/completed'].includes(message.method)) this.binding.empty = false;
        }
        this.generation++; this.emit('changed');
      }
      if (message.method === 'thread/status/changed') {
        const busy = params.status?.type === 'active';
        if (this.binding.busy !== busy) { this.binding.busy = busy; this.generation++; this.emit('changed'); }
      }
    }
    if (this.front?.readyState === 1) {
      if (this.front.bufferedAmount > 64 * 1024 * 1024) this.front.close(1009, 'Client is not reading');
      else this.front.send(JSON.stringify(message));
    }
  }

  rpc(method, params) {
    if (!this.initialized || !this.front) throw new Error('Codex 尚未完成当前会话连接。');
    const id = 'cpo:' + randomUUID() + ':' + ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('读取当前会话超时，未修改草稿。')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.backend.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  current() {
    if (!this.binding?.id) throw new Error('尚未准确绑定当前对话，请先在 Codex 中新建或恢复一个会话。');
    if (this.binding.busy) throw new Error('当前对话仍在生成，请结束后再优化草稿。');
    return { ...this.binding, generation: this.generation };
  }

  fail(error) {
    if (this.closed) return;
    this.invalidate();
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear(); this.front?.close(1011, 'Backend closed');
    this.emit('fault', error);
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.front?.terminate(); this.server?.close(); if (this.http?.listening) this.http.close(); this.backend.stop();
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('入口已关闭。')); }
    this.pending.clear();
  }
}

module.exports = { Bridge };
