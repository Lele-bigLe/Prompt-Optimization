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
const { display, configSummary } = require('./panel.cjs');
const unsupportedOptions = /^(?:--(?:remote|remote-auth-token-env|no-daemon|worktree|profile)(?:=|$)|-p(?:[^-]|$))/;

const usage = `Codex 提示词优化 CLI（Windows）

  node cli/index.cjs start [优化选项] -- [Codex 原生参数]
  node cli/index.cjs models [--codex 程序绝对路径]
  node cli/index.cjs templates
  node cli/index.cjs config [优化选项]
  node cli/index.cjs launch [--codex 程序绝对路径] -- [Codex 原生参数]
  node cli/index.cjs sessions
  node cli/index.cjs settings [--session 入口ID]
  node cli/index.cjs continue --instructions "再简洁一些" [--session 入口ID]
  node cli/index.cjs undo [--session 入口ID]
  node cli/index.cjs cancel [--session 入口ID]
  node cli/index.cjs last-error [--session 入口ID]

优化选项：--model 模型ID --effort auto|low|medium|high|xhigh 等
          --context on|off --timeout 秒数 --template 模板ID
          --mode direct|preview
启动选项：--codex codex.exe绝对路径 --cwd 工作目录
查询选项：config / templates / sessions / last-error 可加 --json

默认写好草稿后按 Ctrl+G，优化结果直接回填，不发送；再次按继续优化。
空输入框按 Ctrl+G 直接进入设置；生成中按 S 可停止生成并调整设置。
settings 可为已有草稿准备设置入口；--mode preview 改为先预览再应用。
接入 PowerShell 后仍使用 codex / codex resume 启动。
continue / undo / cancel 保留为其他终端中的控制命令。
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
  if (values.mode !== undefined) {
    if (!['direct', 'preview'].includes(values.mode)) throw new Error('--mode 只能是 direct 或 preview。');
    result.autoApply = values.mode === 'direct';
  }
  return result;
}

function interactiveInvocation(args) {
  const commands = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'cloud', 'exec-server', 'features', 'help']);
  const values = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') return true;
    if (values.has(argument)) { index++; continue; }
    if (!argument.startsWith('-')) return !commands.has(argument);
  }
  return true;
}

async function forwardNative(executable, args) {
  const child = spawn(executable, args, { stdio: 'inherit', shell: false, windowsHide: false });
  const ignoreInterrupt = () => {};
  const stop = () => child.kill();
  process.on('SIGINT', ignoreInterrupt); process.once('SIGTERM', stop);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('无法启动官方 Codex，请检查程序路径。')));
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally { process.removeListener('SIGINT', ignoreInterrupt); process.removeListener('SIGTERM', stop); }
}

async function launch(values, args) {
  const executable = await store.executableFor(values.codex);
  if (args[0] === '--optimizer-off') return forwardNative(executable, args.slice(1));
  const preview = args[0] === '--optimizer-preview';
  if (preview) args = args.slice(1);
  if (args.some(item => ['--help', '-h', '--version', '-V'].includes(item)) || !interactiveInvocation(args)) return forwardNative(executable, args);
  if (args.some(item => unsupportedOptions.test(item))) {
    process.stderr.write('本次参数暂未适配优化入口，使用官方 Codex 启动；本次会话不接入优化快捷键。\n');
    return forwardNative(executable, args);
  }
  return start({ ...values, quiet: true }, args, store.validateConfig({ ...await store.settings(), ...(preview ? { autoApply: false } : {}) }));
}

function backendOptions(args, initialCwd) {
  const config = [];
  let cwd = initialCwd;
  const withValue = new Set(['-c', '--config', '--enable', '--disable']);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (unsupportedOptions.test(argument)) throw new Error('增强入口不支持再指定 remote、no-daemon、worktree 或 profile；请使用普通 Codex 执行这些操作。');
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
        else if (message.action === 'review') {
          socket.setTimeout(0);
          const notify = event => {
            if (socket.destroyed || socket.writableEnded) return;
            if (socket.writableLength > 2 * 1024 * 1024) { controller.abort(); socket.destroy(); return; }
            socket.write(JSON.stringify({ event }) + '\n');
          };
          respond(await runtime.openReview(message.filename, controller.signal, notify, message.direct === true));
        }
        else if (message.action === 'review-action') respond(runtime.action(message));
        else if (message.action === 'review-models') respond(await runtime.modelOptions(message.reviewId));
        else if (message.action === 'cancel') respond(runtime.cancel());
        else if (['undo', 'continue', 'settings'].includes(message.action)) respond(runtime.queue(message.action, message.instructions));
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
    if (!values.quiet) process.stdout.write(`提示词优化入口：${id}\n${config.autoApply ? 'Ctrl+G 优化并直接回填；再次按继续优化。空输入框按 Ctrl+G 可进入设置。' : 'Ctrl+G 打开预览；A 应用，R 继续优化，U 恢复，S 设置。'}结果不会自动发送。\n`);
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
  const parsed = parseArgs({ args: prefix, allowPositionals: true, options: Object.fromEntries(['codex', 'cwd', 'model', 'effort', 'context', 'timeout', 'template', 'mode', 'session', 'instructions'].map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean', short: 'h' }], ['json', { type: 'boolean' }]])) });
  const command = parsed.positionals[0] || 'start';
  if (parsed.values.help || command === 'help') { console.log(usage); return; }
  if (parsed.positionals.length > 1) throw new Error('Codex 原生参数请放在 -- 后面；修改要求请使用 --instructions。');
  if (command === 'launch') return launch(parsed.values, codexArgs);
  const config = store.validateConfig({ ...await store.settings(), ...overrides(parsed.values) });
  if (command === 'start') return start(parsed.values, codexArgs, config);
  if (codexArgs.length) throw new Error('只有 start 支持 -- 后的 Codex 原生参数。');
  if (command === 'config') {
    if (Object.keys(overrides(parsed.values)).length) {
      if (!builtins.some(item => item.id === config.template)) throw new Error('模板不存在，请运行 templates 查看。');
      await store.writeJson(path.join(store.home, 'config.json'), config);
      if (!parsed.values.json) console.log('已保存，下次启动生效；正在运行的入口请在面板设置中修改。');
    }
    console.log(parsed.values.json ? JSON.stringify(config, null, 2) : display(configSummary(config) + `\n超时：${config.timeoutSeconds} 秒`)); return;
  }
  if (command === 'templates') {
    const templates = builtins.map(({ id, name, description }) => ({ id, name, description, active: id === config.template }));
    console.log(parsed.values.json ? JSON.stringify(templates, null, 2) : templates.map(item => `${item.active ? '●' : '○'} ${item.name}（${item.id}）\n  ${item.description}`).join('\n'));
    return;
  }
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
    const statuses = runs.map(item => item.status);
    if (parsed.values.json) { console.log(JSON.stringify(statuses, null, 2)); return; }
    if (!statuses.length) { console.log('没有正在运行的优化入口。'); return; }
    console.log(display(statuses.map(item => {
      const state = item.busy ? '正在处理' : item.reviewing ? '面板已打开' : '等待 Ctrl+G';
      const template = builtins.find(template => template.id === item.template)?.name || item.template || '未知';
      const action = ({ optimize: '优化', continue: '继续优化', undo: '恢复原文', settings: '打开设置' })[item.pendingAction] || item.pendingAction;
      return `入口：${item.id}\n目录：${item.cwd || '等待建立对话'}\n状态：${state} · ${item.autoApply ? '直接回填' : '先预览'}\n模型：${item.model}\n模板：${template}\n待执行：${action}`;
    }).join('\n\n')));
    return;
  }
  if (command === 'last-error') {
    const id = parsed.values.session || (await store.selectRun()).id;
    store.runFile(id);
    const error = await store.readJson(path.join(store.home, 'errors', id + '.json'), { message: '没有记录到错误。' });
    console.log(parsed.values.json ? JSON.stringify(error, null, 2) : display((error.at ? new Date(error.at).toLocaleString('zh-CN') + '\n' : '') + error.message)); return;
  }
  if (['continue', 'undo', 'cancel', 'settings'].includes(command)) {
    const run = await store.selectRun(parsed.values.session);
    const result = await store.request(run, { action: command, instructions: parsed.values.instructions || '' });
    console.log(result.message); return;
  }
  throw new Error('不支持的命令，请运行 --help 查看。');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
