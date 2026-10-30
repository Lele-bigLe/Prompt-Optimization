'use strict';

const { randomUUID } = require('node:crypto');
const { createJsonStore } = require('./json-store.cjs');

function createConnections(context, legacy, legacySecretId) {
  const directory = context.globalStorageUri.fsPath;
  const keyName = id => `codexPromptOptimizer.connection.${id}`;
  const { read, commit, change } = createJsonStore(directory, 'connections', async () => {
      const current = legacy();
      const state = { version: 1, revision: '', activeId: null, items: [] };
      if (current.provider !== 'choose') {
        const id = randomUUID();
        const profile = { id, revision: randomUUID(), name: '原有连接', provider: current.provider, apiBaseUrl: current.apiBaseUrl, model: current.model, reasoningEffort: current.reasoningEffort, supportsImages: current.supportsImages, tokenLimitParameter: 'max_tokens' };
        if (['deepseek', 'anthropic', 'openai-compatible'].includes(profile.provider)) {
          const key = await context.secrets.get(legacySecretId(profile));
          if (key) await context.secrets.store(keyName(id), key);
        }
        state.items.push(profile);
        state.activeId = id;
      }
      return state;
  }, state => Array.isArray(state.items) && state.items.length <= 100 && state.items.every(item => item && /^[a-f\d-]{36}$/.test(item.id) && typeof item.name === 'string') && new Set(state.items.map(item => item.id)).size === state.items.length && (state.activeId === null || state.items.some(item => item.id === state.activeId)));

  async function save(profile, key, expectedRevision, activate = true) {
    return change(expectedRevision, async state => {
      const previous = state.items.find(item => item.id === profile.id);
      if (profile.id && !previous) throw new Error('此连接已被删除，请重新选择。');
      if (!previous && state.items.length >= 100) throw new Error('最多保存 100 组连接，请先删除不再使用的连接。');
      const next = { ...profile, id: previous?.id || randomUUID(), revision: randomUUID() };
      const secret = keyName(next.id);
      const previousKey = key === undefined ? undefined : await context.secrets.get(secret);
      if (key !== undefined) { if (key) await context.secrets.store(secret, key); else await context.secrets.delete(secret); }
      if (previous) state.items = state.items.map(item => item.id === next.id ? next : item);
      else state.items.push(next);
      if (activate) state.activeId = next.id;
      try { await commit(state); }
      catch (error) {
        if (key !== undefined) { if (previousKey) await context.secrets.store(secret, previousKey); else await context.secrets.delete(secret); }
        throw error;
      }
      return next.id;
    });
  }

  return {
    read, save, storage: directory,
    key: profile => context.secrets.get(keyName(profile.id)),
    activate: (id, revision) => change(revision, async state => {
      if (!state.items.some(item => item.id === id)) throw new Error('此连接已被删除，请重新选择。');
      state.activeId = id;
      await commit(state);
    }),
    clearKey: async (id, revision) => {
      const state = await read();
      const profile = state.items.find(item => item.id === id);
      if (!profile) throw new Error('此连接已被删除，请重新选择。');
      await save(profile, '', revision, false);
    },
    remove: (id, revision) => change(revision, async state => {
      if (!state.items.some(item => item.id === id)) throw new Error('此连接已被删除，请重新选择。');
      const secret = keyName(id);
      const key = await context.secrets.get(secret);
      await context.secrets.delete(secret);
      state.items = state.items.filter(item => item.id !== id);
      if (state.activeId === id) state.activeId = null;
      try { await commit(state); }
      catch (error) { if (key) await context.secrets.store(secret, key); throw error; }
    }),
  };
}

module.exports = { createConnections };
