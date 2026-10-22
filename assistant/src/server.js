// HTTP entry point: receives Chatwoot Agent Bot webhooks.
//   POST /webhook   (the bot's outgoing URL; requests are verified with X-Chatwoot-Signature)
//   GET  /health

import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import * as store from './store.js';
import { respond, deliver, handOff } from './agent.js';
import { chatwoot } from './chatwoot.js';

const HUMAN_MUTE_MS = 12 * 3600 * 1000; // after a consultant writes, stay quiet for 12h

const seen = new Set();
function firstTime(id) {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return true;
}

const timers = new Map(); // conversationId -> { timer, images, meta }
const running = new Set();

function schedule(conversationId, meta, images) {
  const prev = timers.get(conversationId);
  if (prev) clearTimeout(prev.timer);
  const entry = { meta, images: [...(prev?.images || []), ...images] };
  entry.timer = setTimeout(() => run(conversationId, entry), config.debounceMs);
  timers.set(conversationId, entry);
}

async function run(conversationId, entry) {
  timers.delete(conversationId);
  if (running.has(conversationId)) {
    // A reply is being written; try again shortly so nothing is lost.
    return schedule(conversationId, entry.meta, entry.images);
  }
  running.add(conversationId);
  const started = Date.now();
  try {
    // Re-check: a human may have taken over meanwhile.
    const conv = await chatwoot.getConversation(conversationId).catch(() => null);
    if (conv && conv.status !== 'pending') return log.info('skip: not pending', { conversationId, status: conv.status });
    if (store.load(conversationId).mutedUntil > Date.now()) return log.info('skip: muted', { conversationId });

    await chatwoot.typing(conversationId, true);
    const outcome = await respond({ conversationId, ...entry.meta, images: entry.images });
    await chatwoot.typing(conversationId, false);

    // Don't post if a consultant replied while we were thinking
    if (store.load(conversationId).mutedUntil > Date.now()) return log.info('skip: human replied meanwhile', { conversationId });

    await deliver(conversationId, outcome);
    log.info('replied', {
      conversationId,
      ms: Date.now() - started,
      cards: outcome.cards?.length || 0,
      labels: outcome.labels,
      handoff: outcome.handoff?.reason || null,
    });
  } catch (err) {
    log.error('turn failed', { conversationId, err: String(err?.message || err) });
    await chatwoot.typing(conversationId, false);
    // Fail safe: give the conversation to humans silently.
    await handOff(conversationId, 'AI օգնականը չկարողացավ պատասխանել (տեխնիկական սխալ)։ Խնդրում ենք պատասխանել։', 'error').catch(() => {});
  } finally {
    running.delete(conversationId);
  }
}

function handleEvent(ev) {
  if (ev.event !== 'message_created') return;
  if (ev.account?.id && Number(ev.account.id) !== config.chatwootAccountId) return;
  if (!firstTime(ev.id)) return;

  const conv = ev.conversation || {};
  const conversationId = conv.id;
  if (!conversationId) return;

  const inboxId = Number(conv.inbox_id || ev.inbox?.id);
  if (config.allowedInboxIds.length && !config.allowedInboxIds.includes(inboxId)) return;
  if (ev.private) return;

  const senderType = ev.sender?.type;

  // A consultant wrote in this conversation → the bot steps back.
  if (ev.message_type === 'outgoing' && senderType === 'user') {
    store.update(conversationId, { mutedUntil: Date.now() + HUMAN_MUTE_MS });
    store.append(conversationId, 'assistant', ev.content || '');
    return;
  }
  // Other outgoing/template messages (greeting, away message, n8n DMs): keep for context.
  if (ev.message_type === 'outgoing' || ev.message_type === 'template') {
    if (senderType !== 'agent_bot' && ev.content) store.append(conversationId, 'assistant', ev.content);
    return;
  }
  if (ev.message_type !== 'incoming') return;

  const attachments = ev.attachments || [];
  const images = attachments.filter((a) => a.file_type === 'image' && a.data_url).map((a) => a.data_url);
  const other = attachments.filter((a) => a.file_type !== 'image').map((a) => a.file_type);
  let text = (ev.content || '').trim();
  if (images.length) text += `${text ? '\n' : ''}[customer sent ${images.length} photo(s)]`;
  if (other.length) text += `${text ? '\n' : ''}[customer sent: ${other.join(', ')} — you cannot open these]`;
  if (!text) return;

  store.append(conversationId, 'user', text);

  if (conv.status && conv.status !== 'pending') return; // humans own this conversation
  if (store.load(conversationId).mutedUntil > Date.now()) return;

  schedule(
    conversationId,
    { channel: conv.channel, customerName: ev.sender?.name || conv.meta?.sender?.name },
    images,
  );
}

// Chatwoot: X-Chatwoot-Signature = "sha256=" + HMAC_SHA256(secret, `${timestamp}.${body}`)
export function validSignature(headers, body, now = Date.now()) {
  const ts = headers['x-chatwoot-timestamp'];
  const sig = headers['x-chatwoot-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.webhookSecret).update(`${ts}.${body}`).digest('hex')}`;
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model: config.model }));
  }
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!validSignature(req.headers, body)) {
        log.warn('rejected webhook: bad signature');
        return res.writeHead(401).end();
      }
      res.writeHead(200).end('ok'); // answer Chatwoot immediately
      try {
        handleEvent(JSON.parse(body));
      } catch (err) {
        log.warn('bad webhook', { err: String(err) });
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(config.port, () => log.info('assistant listening', { port: config.port, model: config.model }));
setInterval(store.cleanup, 24 * 3600 * 1000).unref();
