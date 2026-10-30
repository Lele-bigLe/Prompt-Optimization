'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// 连接和模板使用同一种本机存储协议：独占写入、版本检查、原子替换。
function createJsonStore(directory, name, initialize, validate) {
  const filename = path.join(directory, `${name}.json`);
  let initializing;
  async function locked(action) {
    await fs.mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, `${name}.lock`);
    let lock;
    try {
      try { lock = await fs.open(lockPath, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') throw new Error(`其他窗口正在保存，或上次保存意外中断。持续出现时请检查扩展存储中的 ${name}.lock。`); throw error; }
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return await action();
    } finally { if (lock) { await lock.close(); await fs.unlink(lockPath); } }
  }
  async function commit(state) {
    state.revision = randomUUID();
    const temporary = `${filename}.${state.revision}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return state;
  }
  async function readFile() {
    const contents = await fs.readFile(filename, 'utf8');
    let state;
    try { state = JSON.parse(contents); } catch { throw new Error(`无法解析 ${name}.json，请检查扩展存储中的此文件。`); }
    if (!state || state.version !== 1 || typeof state.revision !== 'string' || !validate(state)) throw new Error(`${name}.json 格式不正确，请检查扩展存储中的此文件。`);
    return state;
  }
  async function read() {
    try { return await readFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!initializing) initializing = locked(async () => {
      try { return await readFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return commit(await initialize());
    }).finally(() => { initializing = null; });
    return initializing;
  }
  return { read, commit, change: (revision, action) => locked(async () => {
    const state = await readFile();
    if (state.revision !== revision) throw new Error('设置刚刚在其他操作中发生变化，请重新读取后再保存。');
    return action(state);
  }) };
}

module.exports = { createJsonStore };
