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

const SHARED_MEDIA = new Set(['ig_post', 'ig_reel', 'ig_story', 'share']);

// Caption of one of our Instagram posts/reels shared in DM: looked up by media id (asset_id in
// the CDN image link) or by the post/reel link (instagram.com/reel/<code>/).
async function instagramCaption(dataUrl) {
  if (!config.igCaptionUrl) return {};
  try {
    const u = new URL(dataUrl);
    const id = u.searchParams.get('asset_id');
    let query = '';
    if (/^\d+$/.test(id || '')) query = `id=${id}`;
    else if (/(^|\.)instagram\.com$/.test(u.hostname)) query = `url=${encodeURIComponent(u.origin + u.pathname)}`;
    if (!query) return {};
    const res = await fetch(`${config.igCaptionUrl}${config.igCaptionUrl.includes('?') ? '&' : '?'}${query}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const d = (Array.isArray(data) ? data[0] : data) || {};
    return { caption: String(d.caption || '').trim(), image: /^https:\/\//.test(d.image || '') ? d.image : '' };
  } catch (err) {
    log.warn('caption lookup failed', { err: String(err) });
    return {};
  }
}

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
    // Already answered (e.g. photo + text arrived while the previous reply was being written).
    const st = store.load(conversationId);
    if (st.lastReplyAt && (st.lastUserAt || 0) <= st.lastReplyAt) return log.info('skip: already answered', { conversationId });

    await chatwoot.typing(conversationId, true);
    const outcome = await respond({ conversationId, ...entry.meta, images: entry.images });
    await chatwoot.typing(conversationId, false);

    // Don't post if a consultant replied while we were thinking
    if (store.load(conversationId).mutedUntil > Date.now()) return log.info('skip: human replied meanwhile', { conversationId });

    await deliver(conversationId, outcome);
    // Messages that arrived after we started thinking still get their own answer.
    store.update(conversationId, { lastReplyAt: started });
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

async function handleEvent(ev) {
  log.info('event', {
    event: ev.event,
    messageId: ev.id,
    type: ev.message_type,
    sender: ev.sender?.type,
    conversationId: ev.conversation?.id,
    status: ev.conversation?.status,
    inbox: ev.conversation?.inbox_id || ev.inbox?.id,
  });
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
  // Replies sent outside Chatwoot (Instagram app, Meta Business Suite) arrive as "echo" messages.
  // Automated ones (n8n comment→DM, Meta FAQ answers) are kept as context; anything else
  // means a person answered from the phone → the bot steps back.
  if (ev.message_type === 'outgoing' && ev.content_attributes?.external_echo && senderType !== 'agent_bot') {
    store.append(conversationId, 'assistant', ev.content || '[shop sent an attachment]');
    if (isAutomatedEcho(ev.content)) return log.info('echo: automated', { conversationId });
    store.update(conversationId, { mutedUntil: Date.now() + HUMAN_MUTE_MS });
    return log.info('echo: human replied from phone → muted', { conversationId });
  }
  // Other outgoing/template messages (greeting, away message): keep for context.
  // Chatwoot's email-collect box is UI only, not worth remembering.
  if (ev.message_type === 'outgoing' || ev.message_type === 'template') {
    if (ev.content_type === 'input_email') return;
    if (senderType !== 'agent_bot' && ev.content) store.append(conversationId, 'assistant', ev.content);
    return;
  }
  if (ev.message_type !== 'incoming') return;

  // Test mode: only answer the listed contacts; everyone else goes straight to humans.
  const contactId = Number(ev.sender?.id || conv.meta?.sender?.id || conv.contact_inbox?.contact_id);
  const isMeta = conv.channel === 'Channel::FacebookPage' || conv.channel === 'Channel::Instagram';
  if (isMeta && config.testContactIds.length && !config.testContactIds.includes(contactId)) {
    if (conv.status === 'pending') {
      chatwoot.openForHumans(conversationId).catch((err) => log.warn('open failed', { err: String(err) }));
    }
    return log.info('skip: not a test contact', { conversationId, contactId });
  }

  const attachments = ev.attachments || [];
  // Someone (a partner mall, a customer…) tagged @siamoods in their Instagram story: the team
  // reviews these and may repost them — no reply from the assistant.
  if (attachments.some((a) => a.file_type === 'story_mention') || ev.content_attributes?.image_type === 'story_mention') {
    store.append(conversationId, 'user', '[tagged @siamoods in their Instagram story]');
    return log.info('skip: story mention', { conversationId });
  }
  // Photos, and Instagram posts/reels/stories shared in DM (posts arrive with the post's image,
  // reels only with their link).
  const isPicture = (a) =>
    a.data_url && (a.file_type === 'image' || (SHARED_MEDIA.has(a.file_type) && /^image\//.test(a.content_type || 'image/')));
  const pictures = attachments.filter(isPicture);
  const images = pictures.map((a) => a.data_url);
  const photos = pictures.filter((a) => a.file_type === 'image').length;
  const shared = attachments.filter((a) => a.data_url && SHARED_MEDIA.has(a.file_type));
  const other = attachments.filter((a) => !isPicture(a) && !shared.includes(a)).map((a) => a.file_type);
  let text = (ev.content || '').trim();
  if (photos) text += `${text ? '\n' : ''}[customer sent ${photos} photo(s)]`;
  for (const a of shared) {
    const kind = a.file_type.replace(/^ig_/, '');
    const { caption, image } = await instagramCaption(a.data_url);
    const hasImage = isPicture(a) || Boolean(image);
    if (!isPicture(a) && image) images.push(image);
    text +=
      `${text ? '\n' : ''}[customer shared an Instagram ${kind}${hasImage ? ' (its image is attached)' : ''}` +
      (caption
        ? `; caption of that ${kind}: "${caption.slice(0, 600)}"`
        : `; its caption could not be read${hasImage ? '' : ' and you cannot watch it'}`) +
      ']';
  }
  if (other.length) text += `${text ? '\n' : ''}[customer sent: ${other.join(', ')} — you cannot open these]`;
  if (!text) return;

  store.append(conversationId, 'user', text);
  if (images.length) store.update(conversationId, { recentImages: { urls: images.slice(-3), at: Date.now() } });

  if (conv.status && conv.status !== 'pending') return log.info('skip: humans own it', { conversationId, status: conv.status });
  if (store.load(conversationId).mutedUntil > Date.now()) return log.info('skip: muted', { conversationId });
  // A lone «։», "." or emoji/reaction needs no answer (it stays in history as context).
  if (!attachments.length && !/[\p{L}\p{N}]/u.test(text)) return log.info('skip: no words', { conversationId });

  schedule(
    conversationId,
    { channel: conv.channel, customerName: ev.sender?.name || conv.meta?.sender?.name },
    images,
  );
}

export function isAutomatedEcho(content) {
  const text = String(content || '').trim();
  return config.automatedEchoPatterns.some((re) => re.test(text));
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
      let ev;
      try {
        ev = JSON.parse(body);
      } catch (err) {
        return log.warn('bad webhook', { err: String(err) });
      }
      handleEvent(ev).catch((err) => log.warn('event failed', { err: String(err) }));
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(config.port, () => log.info('assistant listening', { port: config.port, model: config.model }));
setInterval(store.cleanup, 24 * 3600 * 1000).unref();
