// End-to-end flow with a mocked network: webhook -> Claude (tool use) -> catalog -> Chatwoot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sma-'));
Object.assign(process.env, {
  CHATWOOT_WEBHOOK_SECRET: 'testsecret',
  ANTHROPIC_API_KEY: 'test-key',
  CHATWOOT_BOT_TOKEN: 'bot-token',
  DATA_DIR: tmp,
  DEBOUNCE_MS: '50',
  PORT: '0',
});

const calls = [];
let claudeRound = 0;
let convStatus = 'pending';

const product = {
  available: 12, discount: false, discount_price: null, haysell_id: 797630,
  images: [{ image: 'https://siamoods.com/storage/p.webp', ogg_image: 'https://siamoods.com/storage/p.jpg' }],
  price: 10600, slug: 'artsathya-matani-sr181', title: 'Արծաթյա մատանի SR181',
  variations: [{ available: 4, title: '16' }, { available: 0, title: '18' }],
};

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : null) : null;
  calls.push({ url: u, method: opts.method || 'GET', body });
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  if (u.includes('/store-data')) {
    return json({ types: [{ id: 27456, name: 'Մատանիներ' }], stones: [{ id: 27471, name: 'Ցիրկոն' }], collections: [] });
  }
  if (u.includes('/api/products')) return json({ data: [product], meta: { total: 1 } });
  if (u.includes('api.anthropic.com')) {
    claudeRound++;
    if (claudeRound === 1) {
      return json({
        id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'search_products',
          input: { type_ids: [27456], stone_ids: [27471], max_price: 15000, lang: 'hy' } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
    if (claudeRound === 2) {
      return json({
        id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't2', name: 'show_products', input: { urls: ['https://siamoods.com/product/artsathya-matani-sr181'] } },
          { type: 'tool_use', id: 't3', name: 'add_labels', input: { labels: ['gift', 'not-a-label'] } },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }
    return json({
      id: 'm3', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Ողջույն 😊 Ահա մի գեղեցիկ տարբերակ՝ SR181, 10.600 ֏։' }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  }
  if (u.includes('chat.siamoods.com')) {
    if (u.endsWith('/conversations/55') && (opts.method || 'GET') === 'GET') return json({ id: 55, status: convStatus });
    if (u.endsWith('/labels') && (opts.method || 'GET') === 'GET') return json({ payload: [] });
    return json({ id: 1 });
  }
  return json({ error: 'unexpected ' + u }, 500);
};

const { humansOnline } = await import('../src/agent.js');
await import('../src/server.js');
const store = await import('../src/store.js');

const http = await import('node:http');
// find the listening port
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(50);

async function post(server, payload, unsigned = false) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'sha256=' + crypto.createHmac('sha256', 'testsecret').update(`${ts}.${body}`).digest('hex');
    const req = http.request({ host: '127.0.0.1', port, path: '/webhook', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': unsigned ? 'sha256=bad' : sig } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

test('business hours', () => {
  // Monday 2026-10-19 12:00 Yerevan = 08:00 UTC
  assert.equal(humansOnline(new Date('2026-10-19T08:00:00Z')), true);
  // Monday 23:00 Yerevan
  assert.equal(humansOnline(new Date('2026-10-19T19:00:00Z')), false);
  // Sunday noon
  assert.equal(humansOnline(new Date('2026-10-18T08:00:00Z')), false);
});

test('customer message -> search -> text + cards + labels', async () => {
  const servers = process._getActiveHandles().filter((h) => h.constructor?.name === 'Server');
  const server = servers.find((s) => s.address && s.address());
  const msg = {
    event: 'message_created', id: 1001, message_type: 'incoming', private: false,
    content: 'Ուզում եմ մատանի ցիրկոնով մինչև 15000', sender: { type: 'contact', name: 'Anna Petrosyan' },
    conversation: { id: 55, status: 'pending', channel: 'Channel::WebWidget', inbox_id: 3 }, account: { id: 2 },
  };
  await post(server, msg);
  await post(server, msg); // duplicate delivery is ignored
  await wait(600);

  const sent = calls.filter((c) => c.url.endsWith('/conversations/55/messages') && c.method === 'POST');
  assert.equal(sent.length, 2, 'one text + one cards message');
  assert.match(sent[0].body.content, /SR181/);
  assert.equal(sent[1].body.content_type, 'cards');
  assert.equal(sent[1].body.content_attributes.items[0].actions[0].uri, 'https://siamoods.com/product/artsathya-matani-sr181');
  assert.equal(sent[1].body.content_attributes.items[0].description, '10.600 ֏');

  const labels = calls.find((c) => c.url.endsWith('/conversations/55/labels') && c.method === 'POST');
  assert.deepEqual(labels.body.labels, ['gift']);

  const search = calls.find((c) => c.url.includes('/api/products'));
  assert.match(search.url, /max_price=15000/);
  assert.match(search.url, /balance=1/);

  const st = store.load(55);
  assert.equal(st.introduced, true);
  assert.equal(st.history.at(-1).role, 'assistant');
  assert.equal(claudeRound, 3);
});

test('unsigned webhook is rejected', async () => {
  const servers = process._getActiveHandles().filter((h) => h.constructor?.name === 'Server');
  const server = servers.find((s) => s.address && s.address());
  const status = await post(server, { event: 'message_created', id: 9999 }, true);
  assert.equal(status, 401);
});

test('consultant reply mutes the bot', async () => {
  const servers = process._getActiveHandles().filter((h) => h.constructor?.name === 'Server');
  const server = servers.find((s) => s.address && s.address());
  await post(server, {
    event: 'message_created', id: 2001, message_type: 'outgoing', private: false, content: 'Բարև, ես Վարդանն եմ',
    sender: { type: 'user', name: 'Vardan' }, conversation: { id: 55, status: 'pending', channel: 'Channel::WebWidget', inbox_id: 3 },
    account: { id: 2 },
  });
  const before = claudeRound;
  await post(server, {
    event: 'message_created', id: 2002, message_type: 'incoming', private: false, content: 'Շնորհակալություն',
    sender: { type: 'contact' }, conversation: { id: 55, status: 'pending', channel: 'Channel::WebWidget', inbox_id: 3 },
    account: { id: 2 },
  });
  await wait(300);
  assert.equal(claudeRound, before, 'no AI call while muted');
  setTimeout(() => process.exit(0), 50);
});
