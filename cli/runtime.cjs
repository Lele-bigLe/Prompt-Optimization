'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { CodexAgent } = require('../core/codex.cjs');
const { builtins } = require('../core/templates.cjs');
const { home, writeJson } = require('./store.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const markers = value => value.match(/\[Image #\d+\]/g) || [];

class Runtime {
  constructor(bridge, executable, config, runId) {
    this.bridge = bridge; this.config = config; this.runId = runId;
    this.agent = new CodexAgent(executable, path.join(home, 'optimizer-workspace'));
    this.entries = new Map();
    this.bridge.on('changed', () => this.job?.abort());
  }

  status() {
    return { id: this.runId, cwd: this.bridge.binding?.cwd || null, threadId: this.bridge.binding?.id || null, busy: Boolean(this.job), model: this.config.model || this.bridge.binding?.model || '按 Codex 当前配置', pendingAction: this.next?.action || 'optimize' };
  }

  queue(action, instructions = '') {
    const binding = this.bridge.current();
    if (this.job) throw new Error('优化尚未结束，请先等待完成或取消。');
    if (!['undo', 'continue', 'cancel'].includes(action)) throw new Error('不支持的操作。');
    if (typeof instructions !== 'string' || instructions.length > 4000) throw new Error('修改要求不能超过 4000 字。');
    if (action !== 'cancel' && !this.entries.has(binding.id)) throw new Error('这个对话在本次入口中还没有可继续或恢复的优化。');
    this.next = action === 'cancel' ? null : { action, instructions, threadId: binding.id, generation: binding.generation };
    return { message: action === 'cancel' ? '已撤回待执行操作。' : `已准备${action === 'undo' ? '恢复原文' : '继续优化'}，请回到对应 Codex 按 Ctrl+G。`, ...this.status() };
  }

  async context(binding) {
    if (!this.config.contextEnabled) return { messages: [], digest: hash('context-disabled') };
    // 新建且尚未开始过一轮对话时，app-server 还没有可分页读取的历史文件。
    if (binding.empty) return { messages: [], digest: hash(JSON.stringify([])) };
    const page = await this.bridge.rpc('thread/turns/list', { threadId: binding.id, limit: this.config.recentTurns, sortDirection: 'desc', itemsView: 'full' });
    if (!Array.isArray(page.data)) throw new Error('当前 Codex 未返回可用聊天记录，请检查 CLI 版本。');
    const messages = [];
    let remaining = this.config.maxContextChars;
    // 只取用户正文和最终回复，不把推理、工具输出或图片二进制送入优化器。
    for (const turn of page.data) {
      if (!Array.isArray(turn.items)) throw new Error('聊天记录未包含完整消息，未修改草稿。');
      for (const item of [...turn.items].reverse()) {
        let text;
        let role;
        if (item.type === 'userMessage') {
          role = 'user';
          text = (item.content || []).map(part => part.type === 'text' ? part.text : ['image', 'localImage'].includes(part.type) ? '[对话中有图片，本次未读取原图]' : '').filter(Boolean).join('\n');
        } else if (item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer')) { role = 'assistant'; text = item.text; }
        if (!text || !remaining) continue;
        const bounded = text.slice(-remaining);
        messages.unshift({ role, text: bounded }); remaining -= bounded.length;
      }
      if (!remaining) break;
    }
    return { messages, digest: hash(JSON.stringify(messages)) };
  }

  async draftFile(filename) {
    const root = await fs.realpath(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'editor'));
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.md') throw new Error('只接受 Codex 原生编辑器创建的草稿文件。');
    const actual = await fs.realpath(filename);
    const relative = path.relative(root, actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('草稿不在 Codex 的临时编辑目录内。');
    const stat = await fs.stat(actual);
    if (!stat.isFile() || stat.size > 400000) throw new Error('草稿文件不正确或超过大小限制。');
    const draft = await fs.readFile(actual, 'utf8');
    if (!draft.trim() || draft.length > 100000) throw new Error('请先填写需要优化的草稿，单次最多 100000 字。');
    return { filename: actual, draft };
  }

  async edit(filename, signal) {
    if (this.job) throw new Error('这个入口已有优化任务，原草稿保留。');
    const binding = this.bridge.current();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.job = controller;
    const timer = setTimeout(abort, this.config.timeoutSeconds * 1000);
    const pending = this.next; this.next = null;
    let usedSession;
    try {
      if (signal.aborted) controller.abort();
      const { filename: actual, draft } = await this.draftFile(filename);
      if (pending && (pending.threadId !== binding.id || pending.generation !== binding.generation)) throw new Error('准备操作后对话已变化，请重新选择操作。');
      const previous = this.entries.get(binding.id);
      let text;
      let entry;
      if (pending?.action === 'undo') {
        if (!previous || draft !== previous.candidate) throw new Error('草稿已经改变，不能直接覆盖为旧原文。');
        text = previous.original;
      } else {
        const context = await this.context(binding);
        if (controller.signal.aborted) throw new Error('优化已取消或超时，原草稿保留。');
        const catalog = this.agent.models.length ? { models: this.agent.models, configuredModel: this.agent.configuredModel } : await this.agent.catalog();
        if (controller.signal.aborted) throw new Error('优化已取消或超时，原草稿保留。');
        const modelId = this.config.model || binding.model || catalog.configuredModel || catalog.models.find(model => model.isDefault)?.model;
        const model = catalog.models.find(item => item.model === modelId);
        if (!model) throw new Error('未找到可用优化模型，请运行 models 查看后设置 --model。');
        const template = builtins.find(item => item.id === this.config.template);
        if (!template) throw new Error('优化模板不存在，请运行 templates 查看。');
        const fingerprint = hash(JSON.stringify({ ...this.config, model: modelId }));
        const continuing = previous && previous.candidate === draft && previous.contextHash === context.digest && previous.configHash === fingerprint;
        if (pending?.action === 'continue' && !continuing) throw new Error('草稿、参考聊天或配置已变化，请直接按 Ctrl+G 开始新一轮优化。');
        if (previous && !continuing) this.agent.releaseSession(previous.session);
        const session = continuing ? previous.session : {};
        usedSession = session;
        const original = continuing ? previous.original : draft;
        const input = { draft: original, context: context.messages, images: [], draftImageCount: 0,
          ...(continuing ? { revision: { previousPrompt: draft, instructions: pending?.instructions || '' } } : {}),
        };
        const configuredTemplate = { ...template, systemPrompt: template.systemPrompt + '\n草稿中的 [Image #数字] 是原生附件占位，必须原样保留，不能新增、删除或改编号。本次未提供原图，不要声称理解了图片内容。' };
        const result = await this.agent.optimize(input, { ...this.config, provider: 'codex', model: modelId, supportsImages: false, template: configuredTemplate }, controller.signal, session);
        text = result.text;
        if (JSON.stringify(markers(text)) !== JSON.stringify(markers(draft))) { this.agent.releaseSession(session); throw new Error('模型改变了图片附件占位，原草稿保留，请重试。'); }
        if ((await this.context(binding)).digest !== context.digest) { this.agent.releaseSession(session); throw new Error('优化期间参考聊天发生变化，原草稿保留。'); }
        entry = { original, candidate: text, contextHash: context.digest, configHash: fingerprint, session, model: modelId, updatedAt: new Date().toISOString() };
      }
      if (controller.signal.aborted || this.bridge.current().generation !== binding.generation) throw new Error('优化已取消或当前对话发生变化，原草稿保留。');
      if (await fs.readFile(actual, 'utf8') !== draft) throw new Error('优化期间草稿文件发生变化，没有覆盖。');
      // 先保存原稿与候选；备份失败时不动交给 Codex 的文件。
      const backups = Object.fromEntries([...this.entries].map(([id, value]) => [id, { original: value.original, candidate: value.candidate, model: value.model, updatedAt: value.updatedAt }]));
      backups[binding.id] = entry ? { original: entry.original, candidate: entry.candidate, model: entry.model, updatedAt: entry.updatedAt } : { original: previous.original, candidate: draft, restoredTo: text, updatedAt: new Date().toISOString() };
      await writeJson(path.join(home, 'backups', this.runId + '.json'), backups);
      const latest = await fs.readFile(actual, 'utf8');
      if (controller.signal.aborted || this.bridge.current().generation !== binding.generation || latest !== draft) throw new Error('写回前会话或草稿发生变化，原稿保留。');
      this.writing = true;
      await fs.writeFile(actual, text, 'utf8');
      if (entry) {
        this.entries.delete(binding.id); this.entries.set(binding.id, entry);
        if (this.entries.size > 8) { const id = this.entries.keys().next().value; this.agent.releaseSession(this.entries.get(id).session); this.entries.delete(id); }
      } else { this.agent.releaseSession(previous.session); this.entries.delete(binding.id); }
      return { applied: true, restored: pending?.action === 'undo', imageCount: markers(text).length, message: '已回填草稿，尚未发送。' };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.job.abort();
      if (usedSession) this.agent.releaseSession(usedSession);
      if (cancelled) throw new Error('优化已取消、超时或对话发生变化，原草稿保留。');
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.job = null; this.writing = false; }
  }

  cancel() {
    if (this.writing) return { message: '结果已经开始写回，请等待草稿显示后使用 undo 恢复。' };
    if (this.job) this.job.abort(); else this.next = null;
    return { message: '已请求取消；尚未写回的原草稿保留。' };
  }

  dispose() { this.job?.abort(); this.agent.dispose(); }
}

module.exports = { Runtime };
