'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');

const home = path.resolve(process.env.CPO_HOME || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'prompt-optimizer-cli'));
const defaults = { model: '', reasoningEffort: 'auto', contextEnabled: true, autoApply: true, recentTurns: 8, maxContextChars: 24000, timeoutSeconds: 90, template: 'builtin-basic' };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`无法读取 ${path.basename(filename)}，请检查文件内容和访问权限。`); }
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function validateConfig(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('CLI 配置需要是 JSON 对象。');
  const config = { ...defaults };
  for (const key of Object.keys(defaults)) if (Object.hasOwn(values, key)) config[key] = values[key];
  if (typeof config.model !== 'string' || config.model.length > 200) throw new Error('模型 ID 不正确。');
  if (typeof config.reasoningEffort !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(config.reasoningEffort)) throw new Error('思考程度不正确，请使用 models 列出的档位。');
  if (typeof config.contextEnabled !== 'boolean') throw new Error('参考聊天必须是 on 或 off。');
  if (typeof config.autoApply !== 'boolean') throw new Error('直接回填设置需要是布尔值。');
  for (const [key, min, max] of [['recentTurns', 1, 30], ['maxContextChars', 1000, 100000], ['timeoutSeconds', 5, 300]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`${key} 需要在 ${min} 到 ${max} 之间。`);
  }
  if (typeof config.template !== 'string') throw new Error('优化模板 ID 不正确。');
  return config;
}

async function settings() { return validateConfig(await readJson(path.join(home, 'config.json'), {})); }

function runFile(id) {
  if (!uuid.test(id || '')) throw new Error('会话入口 ID 不正确，请运行 sessions 查看。');
  return path.join(home, 'runs', id + '.json');
}

function pipeFor(id) {
  if (!uuid.test(id || '')) throw new Error('会话入口 ID 不正确。');
  return '\\\\.\\pipe\\prompt-optimizer-' + id;
}

async function request(run, message, timeout = 10000, signal, onEvent) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeFor(run.id));
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('已取消优化，原草稿保留。'));
    const timer = timeout ? setTimeout(() => finish(new Error('优化器响应超时，原草稿保留。')), timeout) : null;
    socket.on('connect', () => socket.write(JSON.stringify({ ...message, token: run.token }) + '\n'));
    socket.on('error', () => finish(new Error('无法连接这次 Codex 入口，请确认对应终端仍在运行。')));
    socket.on('end', () => finish(new Error('优化器连接已结束，原草稿保留。')));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error('优化器返回的数据超过限制。'));
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let response;
        try { response = JSON.parse(line); }
        catch { finish(new Error('优化器返回的消息格式不正确。')); return; }
        if (response.event) {
          try { onEvent?.(response.event); } catch (error) { finish(error); }
        } else finish(response.error ? new Error(response.error) : null, response.result);
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function liveRuns() {
  let files;
  try { files = await fs.readdir(path.join(home, 'runs')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = await Promise.all(files.filter(name => uuid.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).map(async name => {
    const run = await readJson(path.join(home, 'runs', name));
    if (!run || !uuid.test(run.id) || typeof run.token !== 'string') return null;
    try { return { run, status: await request(run, { action: 'status' }, 2000) }; } catch { return null; }
  }));
  return results.filter(Boolean);
}

async function selectRun(id) {
  if (id) {
    const run = await readJson(runFile(id));
    if (!run || run.id !== id || typeof run.token !== 'string') throw new Error('未找到这个入口，请运行 sessions 查看。');
    return run;
  }
  const runs = await liveRuns();
  if (runs.length !== 1) throw new Error(runs.length ? '同时运行了多个入口，请用 --session 指定 sessions 列出的 ID。' : '没有正在运行的优化入口，请先运行 start。');
  return runs[0].run;
}

async function executableFor(override) {
  if (override !== undefined) {
    if (typeof override !== 'string' || !path.isAbsolute(override)) throw new Error('--codex 需要 codex.exe 的绝对路径。');
    try { if ((await fs.stat(override)).isFile()) return override; } catch {}
    throw new Error('--codex 指定的程序不存在或不可访问。');
  }
  const candidates = [process.env.CODEX_CLI_PATH];
  const directories = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
  for (const directory of directories) {
    candidates.push(path.join(directory, 'codex.exe'));
    const base = path.join(directory, 'node_modules', '@openai', 'codex');
    candidates.push(path.join(base, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    candidates.push(path.join(base, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
  }
  for (const candidate of candidates.filter(Boolean)) {
    if (!path.isAbsolute(candidate)) continue;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw new Error('未找到官方 Codex 程序，请用 --codex 指定 codex.exe 的绝对路径。');
}

module.exports = { home, defaults, readJson, writeJson, validateConfig, settings, runFile, pipeFor, request, liveRuns, selectRun, executableFor };
