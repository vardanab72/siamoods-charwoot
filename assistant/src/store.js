// Small per-conversation state on disk (bots can't read message history from Chatwoot).
// /data/conversations/<id>.json  { history: [{role, text, at}], mutedUntil, introduced, handedOffAt }

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dir = path.join(config.dataDir, 'conversations');
fs.mkdirSync(dir, { recursive: true });

const MAX_HISTORY = 30;
const file = (id) => path.join(dir, `${Number(id)}.json`);

export function load(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return { history: [], mutedUntil: 0, introduced: false, handedOffAt: 0 };
  }
}

export function save(id, state) {
  state.history = state.history.slice(-MAX_HISTORY);
  fs.writeFileSync(file(id), JSON.stringify(state));
}

export function append(id, role, text) {
  const s = load(id);
  const last = s.history[s.history.length - 1];
  // Merge consecutive messages from the same side
  if (last && last.role === role) last.text += `\n${text}`;
  else s.history.push({ role, text, at: Date.now() });
  save(id, s);
  return s;
}

export function update(id, patch) {
  const s = { ...load(id), ...patch };
  save(id, s);
  return s;
}

// Remove conversation files untouched for 60 days
export function cleanup() {
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}
