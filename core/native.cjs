'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

function sharedHome() {
  return path.resolve(process.env.CPO_SHARED_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexPromptOptimizer'));
}

let cached;
async function nativeExecutable() {
  if (process.platform !== 'win32') throw new Error('共享连接目前仅支持本机 Windows。');
  const root = path.join(__dirname, '..');
  let source;
  let stat;
  for (const candidate of [path.join(root, 'cli', 'target', 'release', 'prompt-optimizer.exe'), path.join(root, 'native', 'prompt-optimizer.exe'), path.join(root, 'cli', 'prompt-optimizer.exe')]) {
    try { const found = await fs.stat(candidate); if (found.isFile()) { source = candidate; stat = found; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!source) throw new Error('未找到 Rust 运行程序，请先构建 CLI，或安装包含原生程序的扩展包。');
  const home = sharedHome();
  const signature = `${source}|${stat.size}|${stat.mtimeMs}|${home}`;
  if (cached?.signature === signature) return cached.promise;
  const promise = (async () => {
    const bytes = await fs.readFile(source);
    const after = await fs.stat(source);
    if (bytes.length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('运行程序正在更新，请稍后重新启动。');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const directory = path.join(home, 'runtimes', digest);
    const executable = path.join(directory, 'prompt-optimizer.exe');
    const matches = async () => createHash('sha256').update(await fs.readFile(executable)).digest('hex') === digest;
    try { if (!await matches()) throw new Error('运行版本校验失败，请重新安装原生程序。'); return executable; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      try { await fs.rename(temporary, executable); }
      catch (error) { if (!await matches()) throw error; }
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return executable;
  })();
  cached = { signature, promise };
  try { return await promise; } catch (error) { if (cached?.promise === promise) cached = undefined; throw error; }
}

async function storage(request) {
  const executable = await nativeExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['store'], { env: { ...process.env, CPO_SHARED_HOME: sharedHome() }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill(); reject(error); } else resolve(value); };
    const timer = setTimeout(() => finish(new Error('共享连接服务响应超时。')), 15000);
    child.once('error', () => finish(new Error('无法启动共享连接服务。')));
    child.stdin.on('error', () => finish(new Error('共享连接服务输入已关闭。')));
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 2 * 1024 * 1024) finish(new Error('共享连接服务返回内容过大。')); else chunks.push(chunk); });
    // 原生服务只返回受控错误；不把 stderr、请求体或凭据拼接到日志。
    child.stderr.resume();
    child.once('close', code => {
      if (settled) return;
      let response;
      try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { finish(new Error('共享连接服务返回格式不正确。')); return; }
      if (code !== 0 || response.error) finish(new Error(typeof response.error === 'string' ? response.error : '共享连接操作失败。'));
      else finish(null, response.result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

module.exports = { sharedHome, nativeExecutable, storage };
