'use strict';

const builtins = require('./templates.json').map(item => ({ ...item, userTemplate: '原始草稿（JSON 字符串）：\n{{originalPrompt}}', version: 1, isBuiltin: true }));
const placeholder = /\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5]{1,32})\s*\}\}/g;

function variableNames(template) {
  return [...new Set([...(`${template.systemPrompt}\n${template.userTemplate}`).matchAll(placeholder)].map(match => match[1]).filter(name => name !== 'originalPrompt'))];
}

function validateTemplate(template) {
  for (const [key, maximum] of [['name',80],['description',300],['category',40],['systemPrompt',20000],['userTemplate',20000]]) {
    if (typeof template[key] !== 'string' || template[key].length > maximum) throw new Error('模板字段格式不正确，或内容超过长度限制。');
  }
  if (!template.name.trim() || !template.systemPrompt.trim()) throw new Error('请填写模板名称和优化规则。');
  if ([...template.systemPrompt.matchAll(placeholder)].some(match => match[1] === 'originalPrompt')) throw new Error('原文占位符 {{originalPrompt}} 请放在“用户模板”中。');
  if (variableNames(template).length > 20) throw new Error('单个模板最多使用 20 个自定义变量。');
}

function templateVariables(template, input = {}, required = true) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模板变量格式不正确。');
  const values = {};
  for (const name of variableNames(template)) {
    const value = Object.hasOwn(input, name) ? input[name] : '';
    if (typeof value !== 'string' || value.length > 4000) throw new Error(`模板变量“${name}”内容过长或格式不正确。`);
    if (required && !value.trim()) throw new Error(`请先在优化设置中填写模板变量“${name}”。`);
    Object.defineProperty(values, name, { value, enumerable: true, configurable: true, writable: true });
  }
  return values;
}

function renderTemplate(template, original) {
  validateTemplate(template);
  const values = templateVariables(template, template.variables);
  const render = source => source.replace(placeholder, (_, name) => name === 'originalPrompt' ? JSON.stringify(original) : values[name]);
  const user = render(template.userTemplate);
  const hasOriginal = [...template.userTemplate.matchAll(placeholder)].some(match => match[1] === 'originalPrompt');
  return { system: render(template.systemPrompt), user: hasOriginal ? user : user + '\n原始草稿（JSON 字符串）：\n' + JSON.stringify(original) };
}

module.exports = { builtins, variableNames, variablePattern:placeholder.source, validateTemplate, templateVariables, renderTemplate };
