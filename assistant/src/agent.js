import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildSystemPrompt, TOOLS, ALLOWED_LABELS } from './prompt.js';
import { searchProducts, getProduct, getMatchingSets, taxonomyText } from './catalog.js';
import { chatwoot } from './chatwoot.js';
import * as store from './store.js';
import { log } from './log.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const ACTION_TOOLS = new Set(['add_labels', 'show_products', 'handoff_to_human']);

let systemPromptCache = { text: null, at: 0 };
async function systemPrompt() {
  if (!systemPromptCache.text || Date.now() - systemPromptCache.at > 6 * 3600 * 1000) {
    let taxonomy;
    try {
      taxonomy = await taxonomyText();
    } catch (err) {
      // Catalog down: keep answering (delivery, stores...) with the last good prompt, or none.
      log.warn('taxonomy unavailable', { err: String(err) });
      if (systemPromptCache.text) return systemPromptCache.text;
      return buildSystemPrompt({ taxonomy: '(catalog temporarily unavailable — product search may fail; answer other questions normally)' });
    }
    systemPromptCache = { text: buildSystemPrompt({ taxonomy }), at: Date.now() };
  }
  return systemPromptCache.text;
}

export function humansOnline(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  return parts.weekday !== 'Sun' && hour >= 10 && hour < 22;
}

function channelName(channel) {
  if (channel === 'Channel::WebWidget') return 'WEBSITE';
  if (channel === 'Channel::FacebookPage') return 'MESSENGER';
  if (channel === 'Channel::Instagram') return 'INSTAGRAM';
  return 'WEBSITE';
}

function contextBlock({ channel, customerName, introduced }) {
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  return [
    `CURRENT TIME (Yerevan): ${time}. Human consultants are ${humansOnline(now) ? 'ONLINE now' : 'OFFLINE now (back Monday–Saturday from 10:00)'}.`,
    `CHANNEL: ${channelName(channel)}.`,
    customerName ? `CUSTOMER NAME (may be a username, use only if it looks like a real first name): ${customerName}` : '',
    introduced ? 'You have ALREADY introduced yourself in this conversation.' : 'This is your FIRST reply in this conversation — introduce yourself briefly.',
  ]
    .filter(Boolean)
    .join('\n');
}

const SESSION_GAP_MS = 6 * 3600 * 1000;

export function toAnthropicMessages(history, images) {
  // Messages from an earlier visit (6h+ before the customer's latest message) were already
  // handled by the shop: give them as background only, so they aren't answered again.
  const lastUserAt = Math.max(0, ...history.filter((h) => h.role === 'user').map((h) => h.lastAt || h.at || 0));
  const cut = history.findIndex((h) => (h.lastAt || h.at || 0) >= lastUserAt - SESSION_GAP_MS);
  let earlier = '';
  if (cut > 0) {
    earlier = history
      .slice(0, cut)
      .map((h) => `${h.role === 'user' ? 'Customer' : 'Shop'}: ${h.text}`)
      .join('\n')
      .slice(-3000);
    history = history.slice(cut);
  }
  const msgs = [];
  for (const h of history) {
    if (!msgs.length && h.role !== 'user') continue; // must start with the customer
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === h.role) prev.content += `\n${h.text}`;
    else msgs.push({ role: h.role, content: h.text });
  }
  // The request must end with the customer's turn. Automatic shop messages that arrived
  // after it (away message, email box...) are folded into the customer's turn as context.
  while (msgs.length > 1 && msgs[msgs.length - 1].role === 'assistant') {
    const tail = msgs.pop();
    msgs[msgs.length - 1].content += `\n[automatic shop message shown after this: ${tail.content}]`;
  }
  if (msgs.length && msgs[msgs.length - 1].role !== 'user') return [];
  if (earlier && msgs.length) {
    msgs[0].content =
      `[Earlier conversation from a previous day — already handled by the shop; do NOT answer those questions again, use only as background:\n${earlier}]\n\n${msgs[0].content}`;
  }
  if (images?.length && msgs.length && msgs[msgs.length - 1].role === 'user') {
    const last = msgs[msgs.length - 1];
    last.content = [
      ...images.slice(0, 3).map((img) =>
        typeof img === 'string' ? { type: 'image', source: { type: 'url', url: img } } : img,
      ),
      { type: 'text', text: last.content || '(photo)' },
    ];
  }
  return msgs;
}

// Runs one assistant turn for a conversation. Returns a summary of what happened.
// Download customer images ourselves (Instagram CDN links may not be reachable by URL).
async function imageBlock(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) throw new Error(`HTTP ${res.status} ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4.5 * 1024 * 1024) throw new Error('too large');
    return { type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } };
  } catch (err) {
    log.warn('image download failed, passing url', { err: String(err) });
    return { type: 'image', source: { type: 'url', url } };
  }
}

export async function respond({ conversationId, channel, customerName, images }) {
  const state = store.load(conversationId);
  // A follow-up like "price?" right after a photo/shared post still needs that picture.
  let urls = images || [];
  if (!urls.length && state.recentImages && Date.now() - state.recentImages.at < 2 * 3600 * 1000) urls = state.recentImages.urls;
  const messages = toAnthropicMessages(state.history, await Promise.all(urls.slice(0, 3).map(imageBlock)));
  if (!messages.length) return { skipped: 'no customer message' };

  const seenProducts = new Map(); // url -> product, for show_products
  const outcome = { text: '', cards: [], labels: [], handoff: null };

  const system = [
    { type: 'text', text: await systemPrompt(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contextBlock({ channel, customerName, introduced: state.introduced }) },
  ];

  const isWebsite = channelName(channel) === 'WEBSITE';

  const keptTexts = [];
  for (let round = 0; round <= config.maxToolRounds; round++) {
    const res = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system,
      tools: TOOLS,
      messages,
    });

    const texts = res.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    // Text written before an information tool (search, look at photos...) is the model's
    // working notes and is dropped. Text in a final round, or next to action tools only
    // (labels, cards, handoff), is the customer reply — keep all of it, across rounds.
    const infoRound = toolUses.some((t) => !ACTION_TOOLS.has(t.name));
    if (texts.length && !infoRound) {
      for (const t of texts) if (!keptTexts.includes(t)) keptTexts.push(t);
      outcome.text = keptTexts.join('\n\n');
    }

    log.info('ai round', {
      round,
      stop: res.stop_reason,
      textChars: texts.join('').length,
      tools: toolUses.map((t) => `${t.name}(${JSON.stringify(t.input).slice(0, 160)})`),
      usage: res.usage && { in: res.usage.input_tokens, out: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens },
    });
    if (res.stop_reason !== 'tool_use' || !toolUses.length) break;

    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const tu of toolUses) {
      let result;
      try {
        result = await runTool(tu, { seenProducts, outcome, isWebsite });
      } catch (err) {
        log.warn('tool failed', { tool: tu.name, err: String(err) });
        result = { error: 'Temporary error, the catalog is unavailable right now.' };
      }
      // A tool may return ready content blocks (e.g. product photos for the model to look at).
      const content = result && Array.isArray(result.__content) ? result.__content : JSON.stringify(result);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content });
    }
    messages.push({ role: 'user', content: results });
  }

  // Safety net: never send cards without a message. Ask once more for the customer text only.
  if (!outcome.text) {
    messages.push({ role: 'user', content: '[system] Write your reply to the customer now (text only, no tools).' });
    const res = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system,
      tools: TOOLS,
      tool_choice: { type: 'none' },
      messages: fixAlternation(messages),
    });
    outcome.text = res.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean).join('\n\n');
    log.info('ai fallback text', { textChars: outcome.text.length });
  }

  return outcome;
}

// Merge consecutive user turns (tool results + the reminder) so roles alternate.
function fixAlternation(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && m.role === 'user') {
      const a = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content }];
      const b = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      prev.content = [...a, ...b];
    } else out.push({ ...m });
  }
  return out;
}

async function runTool(tu, { seenProducts, outcome, isWebsite }) {
  const input = tu.input || {};
  switch (tu.name) {
    case 'search_products': {
      const r = await searchProducts(input);
      for (const p of r.products) {
        seenProducts.set(p.url, p);
        [...(p.matching_set_items || []), ...(p.suggested_chains || [])].forEach((x) => seenProducts.set(x.url, x));
      }
      return r;
    }
    case 'get_product': {
      const r = await getProduct(input);
      if (r.found) {
        seenProducts.set(r.url, r);
        [...(r.matching_set_items || []), ...(r.suggested_chains || [])].forEach((p) => seenProducts.set(p.url, p));
      }
      return r;
    }
    case 'get_matching_sets': {
      const r = await getMatchingSets(input);
      for (const p of r.products) {
        seenProducts.set(p.url, p);
        [...(p.matching_set_items || []), ...(p.suggested_chains || [])].forEach((x) => seenProducts.set(x.url, x));
      }
      return r;
    }
    case 'look_at_products': {
      const items = (input.urls || []).map((u) => seenProducts.get(u)).filter((p) => p && p.image).slice(0, 8);
      if (!items.length) return { error: 'No photos: pass urls of products returned by the catalog tools.' };
      const content = [];
      items.forEach((p, i) => {
        content.push({ type: 'text', text: `Photo ${i + 1}: ${p.title} — ${p.url}` });
        content.push({ type: 'image', source: { type: 'url', url: p.image } });
      });
      content.push({ type: 'text', text: 'Judge each photo honestly. Offer only products whose photo clearly shows what the customer asked for.' });
      return { __content: content };
    }
    case 'show_products': {
      if (!isWebsite) return { ok: false, note: 'Not the website chat — put links in your text instead.' };
      const items = (input.urls || []).map((u) => seenProducts.get(u)).filter(Boolean).slice(0, 6);
      outcome.cards = items;
      return { ok: true, shown: items.length };
    }
    case 'add_labels': {
      outcome.labels = (input.labels || []).filter((l) => ALLOWED_LABELS.includes(l));
      return { ok: true };
    }
    case 'handoff_to_human': {
      outcome.handoff = { reason: input.reason, summary: input.summary_hy };
      return { ok: true, note: 'A consultant will take over. Do not call more tools; finish your message.' };
    }
    default:
      return { error: 'unknown tool' };
  }
}

const urlLang = (url) => (/\/en\/product\//.test(url) ? 'en' : /\/ru\/product\//.test(url) ? 'ru' : 'hy');
const CARD_TEXT = {
  hy: { view: 'Դիտել', was: (x) => `${x} ֏-ի փոխարեն` },
  en: { view: 'View', was: (x) => `was ${x} ֏` },
  ru: { view: 'Смотреть', was: (x) => `вместо ${x} ֏` },
};

function formatPrice(p) {
  const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const t = CARD_TEXT[urlLang(p.url)];
  if (p.discount_price_amd) return `${n(p.discount_price_amd)} ֏ (${t.was(n(p.price_amd))})`;
  return p.price_amd ? `${n(p.price_amd)} ֏` : '';
}

// Sends the outcome to Chatwoot.
export async function deliver(conversationId, outcome) {
  // The model may decide a closing "ok/thanks" needs no further answer.
  if (/^\[no reply\]$/i.test((outcome.text || '').trim())) {
    outcome.text = '';
    if (!outcome.cards?.length) store.append(conversationId, 'assistant', '[no reply needed]');
  }
  if (outcome.text) {
    await chatwoot.sendText(conversationId, outcome.text);
    store.append(conversationId, 'assistant', outcome.text);
    store.update(conversationId, { introduced: true });
  }
  if (outcome.cards?.length) {
    const items = outcome.cards.map((p) => ({
      media_url: p.image || undefined,
      title: p.title,
      description: formatPrice(p),
      actions: [{ type: 'link', text: CARD_TEXT[urlLang(p.url)].view, uri: p.url }],
    }));
    await chatwoot.sendCards(conversationId, items).catch((err) => log.warn('cards failed', { err: String(err) }));
  }
  if (outcome.labels?.length) {
    await chatwoot.addLabels(conversationId, outcome.labels).catch((err) => log.warn('labels failed', { err: String(err) }));
  }
  if (outcome.handoff) {
    await handOff(conversationId, outcome.handoff.summary, outcome.handoff.reason);
  }
}

export async function handOff(conversationId, summary, reason) {
  await chatwoot
    .sendPrivateNote(conversationId, `🤖 AI օգնականը փոխանցեց զրույցը (${reason || 'handoff'})\n\n${summary || ''}`)
    .catch((err) => log.warn('note failed', { err: String(err) }));
  await chatwoot.openForHumans(conversationId);
  store.update(conversationId, { handedOffAt: Date.now() });
}
