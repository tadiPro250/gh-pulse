// Resolves catalog entries + the user's config + secrets into usable providers.
import { getSecret } from '../secrets.js';
import { which } from '../which.js';
import { CATALOG, byId } from './catalog.js';
import { anthropicProvider } from './providers/anthropic.js';
import { cliChatProvider } from './providers/cli.js';
import { openaiProvider } from './providers/openai.js';

// Catalog defaults with the user's overrides (model, baseUrl, bin, args…) on top.
export function resolve(config, id) {
  const base = byId(id);
  if (!base) return null;
  const o = config.ai?.providers?.[id] ?? {};
  return {
    ...base,
    ...o,
    bin: o.command ?? o.bin ?? base.bin,
    model: o.model ?? base.defaultModel ?? '',
    chat: base.chat && { ...base.chat, ...(o.chatArgs ? { args: o.chatArgs } : {}), ...(o.chatInput ? { input: o.chatInput } : {}) },
    agent: base.agent && { ...base.agent, ...(o.agentArgs ? { args: o.agentArgs } : {}) },
  };
}

export const canChat = (p) => p.kind === 'api' || (p.kind === 'cli' && Boolean(p.chat));
export const canAgent = (p) => p.kind === 'ide' || (p.kind === 'cli' && Boolean(p.agent));

export function apiKeyFor(p) {
  return getSecret(p.id) || (p.env ? process.env[p.env] : null) || null;
}

// { ready, label, hint, path?, keySource? }
export function status(config, id) {
  const p = resolve(config, id);
  if (p.kind === 'cli' || p.kind === 'ide') {
    if (!p.bin) return { ready: false, label: 'not set up', hint: 'set ai.providers.custom-cli.command in the config file' };
    const path = which(p.bin);
    return path
      ? { ready: true, label: 'installed', hint: path, path }
      : { ready: false, label: 'not installed', hint: p.install ? `install: ${p.install}` : `${p.bin} not found on PATH` };
  }
  if (p.custom && !p.baseUrl) return { ready: false, label: 'not set up', hint: 'set a base URL' };
  const key = apiKeyFor(p);
  if (!p.local && !p.custom && !key) return { ready: false, label: 'not linked', hint: `add an API key${p.env ? ` or set $${p.env}` : ''}` };
  if (!p.model) return p.local ? { ready: false, label: 'not set up', hint: `start ${p.name}, then choose a model` } : { ready: false, label: 'pick a model', hint: 'choose which model to use', linked: true };
  const keySource = key ? (getSecret(p.id) ? 'saved key' : `$${p.env}`) : null;
  return { ready: true, label: p.local ? 'local' : 'linked', hint: `${p.model}${keySource ? ` · ${keySource}` : ''}`, keySource };
}

export function allStatuses(config) {
  return CATALOG.map((p) => ({ provider: resolve(config, p.id), status: status(config, p.id) }));
}

function firstReady(config, test, preferred) {
  if (preferred) {
    const p = resolve(config, preferred);
    if (p && test(p) && status(config, preferred).ready) return preferred;
  }
  return CATALOG.find((p) => test(resolve(config, p.id)) && status(config, p.id).ready)?.id ?? null;
}

// The configured provider if it's usable, otherwise the first one that is.
export const chatProviderId = (config) => firstReady(config, canChat, config.ai?.chat);
export const agentProviderId = (config) => firstReady(config, canAgent, config.ai?.agent);

export function createChat(config, id) {
  const p = resolve(config, id);
  const st = status(config, id);
  if (!st.ready) throw new Error(`${p.name}: ${st.label}`);
  const label = p.model ? `${p.name} · ${p.model}` : p.name;
  if (p.kind === 'cli') return { id, name: label, ...cliChatProvider({ file: st.path, chat: p.chat, model: p.model, name: p.name }) };
  if (p.protocol === 'anthropic') return { id, name: label, ...anthropicProvider({ apiKey: apiKeyFor(p), model: p.model }) };
  return { id, name: label, ...openaiProvider({ baseUrl: p.baseUrl, apiKey: apiKeyFor(p), model: p.model, label: p.name }) };
}

// Model choices: live from the API when possible, else the catalog's aliases.
export async function listModels(config, id) {
  const p = resolve(config, id);
  if (p.kind !== 'api') return p.models ?? [];
  if (p.protocol === 'anthropic') return anthropicProvider({ apiKey: apiKeyFor(p), model: p.model }).listModels();
  return openaiProvider({ baseUrl: p.baseUrl, apiKey: apiKeyFor(p), model: p.model, label: p.name }).listModels();
}
