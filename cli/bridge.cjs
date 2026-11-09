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
    this.bindingReason = '尚未收到创建或恢复对话的响应';
    const environment = { ...process.env };
    delete environment.CODEX_THREAD_ID; delete environment.CODEX_SESSION_ID;
    this.backend = new LineProcess(executable, [...configArgs, 'app-server', '--listen', 'stdio://'], cwd, 'Codex 主会话', environment);
    this.backend.on('message', message => this.receive(message));
    this.backend.on('fault', error => this.fail(error));
    this.backend.on('close', () => this.fail(new Error('Codex 主服务已结束。')));
  }

  invalidate(reason) {
    this.generation++;
    this.binding = null;
    this.bindingReason = reason || '当前对话绑定已失效';
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
        if (this.front === socket) { this.front = null; this.invalidate('原生终端连接已断开'); }
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
            if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) this.invalidate('正在创建或切换对话');
            let previousTurnState;
            if (message.method === 'thread/unsubscribe' && message.params?.threadId === this.binding?.id) {
              // 取消的是事件订阅，不是界面当前选择的对话。
              this.binding.detached = true;
              this.generation++; this.emit('changed');
            }
            if (message.method === 'turn/start' && message.params?.threadId === this.binding?.id) {
              previousTurnState = { busy: this.binding.busy, empty: this.binding.empty, model: this.binding.model };
              if (typeof message.params.model === 'string') this.binding.model = message.params.model;
              this.binding.empty = false;
              this.binding.busy = true; this.generation++; this.emit('changed');
            }
            this.frontRequests.set(JSON.stringify(message.id), { request: message, generation: this.generation, previousTurnState });
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
    // 已取消或超时的内部读取响应不能流入原生 TUI 的请求通道。
    if (!message.method && typeof message.id === 'string' && message.id.startsWith('cpo:')) return;
    if (message.id !== undefined && !message.method) {
      const tracked = this.frontRequests.get(JSON.stringify(message.id));
      const request = tracked?.request;
      this.frontRequests.delete(JSON.stringify(message.id));
      if (request?.method === 'initialize' && message.result) this.initialized = message.result;
      if (request?.method === 'turn/start' && message.error && tracked.previousTurnState && tracked.generation === this.generation && request.params?.threadId === this.binding?.id) {
        // 请求被拒绝不会产生 turn/completed；只恢复本请求的预置状态，不覆盖后续通知。
        Object.assign(this.binding, tracked.previousTurnState);
        this.generation++; this.emit('changed');
      }
      if (request && tracked.generation === this.generation && ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method) && message.result?.thread?.id) {
        const result = message.result;
        this.binding = { id: result.thread.id, cwd: result.cwd || result.thread.cwd, model: result.model, busy: result.thread.status?.type === 'active', detached: result.thread.status?.type === 'notLoaded', empty: request.method === 'thread/start' && Array.isArray(result.thread.turns) && result.thread.turns.length === 0 };
        this.bindingReason = '';
        this.generation++; this.emit('changed');
      }
    }
    const params = message.params;
    if (this.binding && params?.threadId === this.binding.id) {
      if (message.method === 'thread/closed') {
        this.binding.detached = true;
        this.generation++; this.emit('changed');
      }
      if (['turn/started', 'turn/completed', 'thread/archived', 'thread/deleted', 'thread/compacted'].includes(message.method)) {
        if (['thread/archived', 'thread/deleted'].includes(message.method)) {
          this.binding = null;
          this.bindingReason = '当前对话已归档或删除';
        }
        else {
          this.binding.busy = message.method === 'turn/started';
          if (['turn/started', 'turn/completed'].includes(message.method)) this.binding.empty = false;
        }
        this.generation++; this.emit('changed');
      }
      if (message.method === 'thread/status/changed') {
        const busy = params.status?.type === 'active';
        const detached = this.binding.detached || params.status?.type === 'notLoaded';
        if (this.binding.busy !== busy || this.binding.detached !== detached) {
          this.binding.busy = busy; this.binding.detached = detached;
          this.generation++; this.emit('changed');
        }
      }
    }
    if (this.front?.readyState === 1) {
      if (this.front.bufferedAmount > 64 * 1024 * 1024) this.front.close(1009, 'Client is not reading');
      else this.front.send(JSON.stringify(message));
    }
  }

  rpc(method, params, signal) {
    if (!this.initialized || !this.front) throw new Error('Codex 尚未完成当前会话连接。');
    const id = 'cpo:' + randomUUID() + ':' + ++this.sequence;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.pending.delete(id); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error('已取消读取当前会话。'));
      const timer = setTimeout(() => finish(new Error('读取当前会话超时，未修改草稿。')), 15000);
      this.pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error), timer });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.backend.send({ id, method, params }); }
      catch (error) { finish(error); }
    });
  }

  current() {
    if (this.bindingCheck) throw new Error('正在核对当前对话状态，请稍后再按 Ctrl+G。');
    if (!this.binding?.id) throw new Error(`尚未准确绑定当前对话（${this.bindingReason}），请先在 Codex 中新建或恢复一个会话。`);
    if (this.binding.busy) throw new Error('当前对话仍在生成，请结束后再优化草稿。');
    return { ...this.binding, generation: this.generation };
  }

  checkCurrentThread() {
    if (this.bindingCheck) return;
    const binding = this.binding;
    const generation = this.generation;
    // 未订阅或已卸载仍可按原 ID 读取持久化聊天；不 resume，也不选择其他聊天。
    const check = Promise.resolve().then(() => this.rpc('thread/read', { threadId: binding.id, includeTurns: false })).then(result => {
      if (this.binding !== binding) return;
      const status = result?.thread?.status?.type;
      if (result?.thread?.id !== binding.id || !['notLoaded', 'idle', 'active', 'systemError'].includes(status)) throw new Error('无法确认原对话状态，未修改草稿。');
      // 同一对话可能在读取期间收到状态通知，较早的读取结果不能覆盖更新的 busy。
      if (this.generation === generation) binding.busy = status === 'active';
    }).finally(() => { if (this.bindingCheck === check) this.bindingCheck = null; });
    this.bindingCheck = check;
  }

  async currentReady() {
    if (this.binding?.detached) this.checkCurrentThread();
    if (this.bindingCheck) {
      const binding = this.binding;
      // 读取失败直接保留其原因；订阅/加载状态变化不等于切换了对话。
      await this.bindingCheck;
      if (this.binding !== binding) throw new Error('核对期间当前对话已切换或失效，未修改草稿。');
    }
    return this.current();
  }

  fail(error) {
    if (this.closed) return;
    this.invalidate('Codex 主服务已中断');
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
