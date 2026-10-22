import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildSystemPrompt, TOOLS, ALLOWED_LABELS } from './prompt.js';
import { searchProducts, getProduct, taxonomyText } from './catalog.js';
import { chatwoot } from './chatwoot.js';
import * as store from './store.js';
import { log } from './log.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

let systemPromptCache = { text: null, at: 0 };
async function systemPrompt() {
  if (!systemPromptCache.text || Date.now() - systemPromptCache.at > 6 * 3600 * 1000) {
    systemPromptCache = { text: buildSystemPrompt({ taxonomy: await taxonomyText() }), at: Date.now() };
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

function toAnthropicMessages(history, images) {
  const msgs = [];
  for (const h of history) {
    if (!msgs.length && h.role !== 'user') continue; // must start with the customer
    msgs.push({ role: h.role, content: h.text });
  }
  if (images?.length && msgs.length && msgs[msgs.length - 1].role === 'user') {
    const last = msgs[msgs.length - 1];
    last.content = [
      ...images.slice(0, 3).map((url) => ({ type: 'image', source: { type: 'url', url } })),
      { type: 'text', text: last.content || '(photo)' },
    ];
  }
  return msgs;
}

// Runs one assistant turn for a conversation. Returns a summary of what happened.
export async function respond({ conversationId, channel, customerName, images }) {
  const state = store.load(conversationId);
  const messages = toAnthropicMessages(state.history, images);
  if (!messages.length) return { skipped: 'no customer message' };

  const seenProducts = new Map(); // url -> product, for show_products
  const outcome = { text: '', cards: [], labels: [], handoff: null };

  const system = [
    { type: 'text', text: await systemPrompt(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contextBlock({ channel, customerName, introduced: state.introduced }) },
  ];

  const isWebsite = channelName(channel) === 'WEBSITE';

  for (let round = 0; round <= config.maxToolRounds; round++) {
    const res = await anthropic.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system,
      tools: TOOLS,
      messages,
    });

    const texts = res.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
    if (texts.length) outcome.text = [outcome.text, ...texts].filter(Boolean).join('\n\n');

    const toolUses = res.content.filter((b) => b.type === 'tool_use');
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
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }

  return outcome;
}

async function runTool(tu, { seenProducts, outcome, isWebsite }) {
  const input = tu.input || {};
  switch (tu.name) {
    case 'search_products': {
      const r = await searchProducts(input);
      r.products.forEach((p) => seenProducts.set(p.url, p));
      return r;
    }
    case 'get_product': {
      const r = await getProduct(input);
      if (r.found) seenProducts.set(r.url, r);
      return r;
    }
    case 'show_products': {
      if (!isWebsite) return { ok: false, note: 'Not the website chat — put links in your text instead.' };
      const items = (input.urls || []).map((u) => seenProducts.get(u)).filter(Boolean).slice(0, 4);
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
