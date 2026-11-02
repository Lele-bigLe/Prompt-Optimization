#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const store = require('./store.cjs');
const { CodexAgent } = require('../core/codex.cjs');
const { builtins } = require('../core/templates.cjs');

const usage = `Codex 提示词优化 CLI（Windows）

  node cli/index.cjs start [优化选项] -- [Codex 原生参数]
  node cli/index.cjs models [--codex 程序绝对路径]
  node cli/index.cjs templates
  node cli/index.cjs config [优化选项]
  node cli/index.cjs sessions
  node cli/index.cjs continue --instructions "再简洁一些" [--session 入口ID]
  node cli/index.cjs undo [--session 入口ID]
  node cli/index.cjs cancel [--session 入口ID]
  node cli/index.cjs last-error [--session 入口ID]

优化选项：--model 模型ID --effort auto|low|medium|high|xhigh 等
          --context on|off --timeout 秒数 --template 模板ID
启动选项：--codex codex.exe绝对路径 --cwd 工作目录

在启动后的 Codex 中写草稿，按 Ctrl+G 后台优化，结果仅回填，不发送。
再次按 Ctrl+G：草稿与聊天未变时沿用独立优化会话继续改善。
continue / undo 在另一个终端执行，再回到对应 Codex 按 Ctrl+G 生效。
cancel 可直接取消正在进行的优化，不需要再次按快捷键。
首次使用请先在 cli 目录安装依赖；本版本不打开浏览器。
`;

function overrides(values) {
  const result = {};
  for (const [option, key] of [['model', 'model'], ['effort', 'reasoningEffort'], ['template', 'template']]) if (values[option] !== undefined) result[key] = values[option];
  if (values.context !== undefined) {
    if (!['on', 'off'].includes(values.context)) throw new Error('--context 只能是 on 或 off。');
    result.contextEnabled = values.context === 'on';
  }
  if (values.timeout !== undefined) result.timeoutSeconds = Number(values.timeout);
  return result;
}

function backendOptions(args, initialCwd) {
  const config = [];
  let cwd = initialCwd;
  const withValue = new Set(['-c', '--config', '--enable', '--disable']);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (/^--(?:remote|remote-auth-token-env|no-daemon|worktree|profile)(?:=|$)/.test(argument) || /^-p(?:[^-]|$)/.test(argument)) throw new Error('增强入口不支持再指定 remote、no-daemon、worktree 或 profile；请使用普通 Codex 执行这些操作。');
    if (withValue.has(argument)) {
      if (!args[index + 1]) throw new Error(`${argument} 缺少值。`);
      config.push(argument, args[++index]);
    } else if (/^--(?:config|enable|disable)=/.test(argument)) config.push(argument);
    else if (argument.startsWith('-c') && !argument.startsWith('--') && argument.length > 2) config.push('-c', argument.slice(2));
    else if (argument === '-C' || argument === '--cd') {
      if (!args[index + 1]) throw new Error(`${argument} 缺少目录。`);
      cwd = path.resolve(initialCwd, args[++index]);
    } else if (argument.startsWith('--cd=')) cwd = path.resolve(initialCwd, argument.slice(5));
    else if (argument.startsWith('-C') && argument.length > 2) cwd = path.resolve(initialCwd, argument.slice(2));
  }
  return { config, cwd };
}

function controlServer(runtime, run) {
  const server = net.createServer(socket => {
    socket.setEncoding('utf8'); socket.setTimeout(360000, () => socket.destroy());
    let raw = '';
    let accepted = false;
    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    socket.on('error', () => controller.abort());
    const respond = (result, error) => { if (!socket.destroyed) socket.end(JSON.stringify(error ? { error: error.message } : { result }) + '\n'); };
    socket.on('data', async chunk => {
      if (accepted) return;
      raw += chunk;
      if (raw.length > 32000) { socket.destroy(); return; }
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      accepted = true;
      try {
        const message = JSON.parse(raw.slice(0, newline));
        const token = Buffer.from(typeof message.token === 'string' ? message.token : '');
        const expected = Buffer.from(run.token);
        if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Error('连接认证失败。');
        if (message.action === 'status') respond(runtime.status());
        else if (message.action === 'edit') respond(await runtime.edit(message.filename, controller.signal));
        else if (message.action === 'cancel') respond(runtime.cancel());
        else if (['undo', 'continue'].includes(message.action)) respond(runtime.queue(message.action, message.instructions));
        else throw new Error('不支持的操作。');
      } catch (error) { respond(null, error); }
    });
  });
  return server;
}

async function start(values, codexArgs, config) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前 CLI 入口仅适配 Windows x64。');
  if (process.env.CPO_RUN_ID) throw new Error('已在增强入口环境中，不能嵌套启动。');
  try { require.resolve('ws'); } catch { throw new Error('缺少 CLI 依赖，请先进入 cli 目录执行 npm install。'); }
  const executable = await store.executableFor(values.codex);
  const initialCwd = path.resolve(values.cwd || process.cwd());
  const backend = backendOptions(codexArgs, initialCwd);
  const { Bridge } = require('./bridge.cjs');
  const { Runtime } = require('./runtime.cjs');
  const id = randomUUID();
  const run = { id, token: randomBytes(32).toString('hex'), pid: process.pid, cwd: backend.cwd, startedAt: new Date().toISOString() };
  const bridge = new Bridge(executable, backend.cwd, backend.config, run.token);
  const runtime = new Runtime(bridge, executable, config, id);
  const server = controlServer(runtime, run);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  bridge.on('fault', () => { process.stderr.write('\nCodex 主服务已中断，优化入口暂停。请退出后重新启动；未写回的草稿不变。\n'); });
  const ignoreInterrupt = () => {};
  let child;
  let stop;
  try {
    const endpoint = await bridge.listen();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(store.pipeFor(id), resolve); });
    await store.writeJson(store.runFile(id), run);
    const environment = { ...process.env, CPO_HOME: store.home, CPO_RUN_ID: id, CPO_TUI_TOKEN: run.token };
    delete environment.CODEX_THREAD_ID; delete environment.CODEX_SESSION_ID;
    const editor = `"${process.execPath}" "${path.join(__dirname, 'editor.cjs')}"`;
    environment.VISUAL = editor; environment.EDITOR = editor;
    process.stdout.write(`提示词优化入口：${id}\nCtrl+G 后台优化；再次按继续改善；结果不会自动发送。\n恢复和补充要求：在另一个终端执行 undo / continue，再按 Ctrl+G。\n`);
    process.on('SIGINT', ignoreInterrupt);
    child = spawn(executable, ['--remote', endpoint, '--remote-auth-token-env', 'CPO_TUI_TOKEN', ...codexArgs], { cwd: initialCwd, env: environment, stdio: 'inherit', shell: false, windowsHide: false });
    stop = () => { runtime.dispose(); bridge.dispose(); child.kill(); };
    process.once('SIGTERM', stop);
    const code = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('无法启动 Codex，请核对 --codex 路径及 CLI 版本。')));
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  } finally {
    process.removeListener('SIGINT', ignoreInterrupt);
    if (stop) process.removeListener('SIGTERM', stop);
    runtime.dispose(); bridge.dispose();
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
    await fs.unlink(store.runFile(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

(async () => {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const prefix = separator < 0 ? argv : argv.slice(0, separator);
  const codexArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const parsed = parseArgs({ args: prefix, allowPositionals: true, options: Object.fromEntries(['codex', 'cwd', 'model', 'effort', 'context', 'timeout', 'template', 'session', 'instructions'].map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean', short: 'h' }]])) });
  const command = parsed.positionals[0] || 'start';
  if (parsed.values.help || command === 'help') { console.log(usage); return; }
  if (parsed.positionals.length > 1) throw new Error('Codex 原生参数请放在 -- 后面；修改要求请使用 --instructions。');
  const config = store.validateConfig({ ...await store.settings(), ...overrides(parsed.values) });
  if (command === 'start') return start(parsed.values, codexArgs, config);
  if (codexArgs.length) throw new Error('只有 start 支持 -- 后的 Codex 原生参数。');
  if (command === 'config') {
    if (Object.keys(overrides(parsed.values)).length) {
      if (!builtins.some(item => item.id === config.template)) throw new Error('模板不存在，请运行 templates 查看。');
      await store.writeJson(path.join(store.home, 'config.json'), config);
      console.log('已保存，下次 start 生效。');
    }
    console.log(JSON.stringify(config, null, 2)); return;
  }
  if (command === 'templates') { console.log(builtins.map(item => `${item.id}\t${item.name}\t${item.description}`).join('\n')); return; }
  if (command === 'models') {
    const agent = new CodexAgent(await store.executableFor(parsed.values.codex), path.join(store.home, 'optimizer-workspace'));
    try {
      const catalog = await agent.catalog();
      console.log(catalog.account);
      for (const model of catalog.models) console.log(`${model.model}\t${model.supportedReasoningEfforts.map(item => item.reasoningEffort).join(', ')}`);
    } finally { agent.dispose(); }
    return;
  }
  if (command === 'sessions') {
    const runs = await store.liveRuns();
    console.log(runs.length ? JSON.stringify(runs.map(item => item.status), null, 2) : '没有正在运行的优化入口。'); return;
  }
  if (command === 'last-error') {
    const id = parsed.values.session || (await store.selectRun()).id;
    store.runFile(id);
    console.log(JSON.stringify(await store.readJson(path.join(store.home, 'errors', id + '.json'), { message: '没有记录到错误。' }), null, 2)); return;
  }
  if (['continue', 'undo', 'cancel'].includes(command)) {
    const run = await store.selectRun(parsed.values.session);
    const result = await store.request(run, { action: command, instructions: parsed.values.instructions || '' });
    console.log(result.message); return;
  }
  throw new Error('不支持的命令，请运行 --help 查看。');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
