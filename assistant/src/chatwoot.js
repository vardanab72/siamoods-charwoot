// Minimal Chatwoot API client for an Agent Bot token.
// Bots may only call: conversations show/toggle_status/toggle_typing_status,
// messages create, assignments create, labels index/create.

import { config } from './config.js';

const base = () => `${config.chatwootBaseUrl}/api/v1/accounts/${config.chatwootAccountId}`;

async function call(method, path, body) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      api_access_token: config.chatwootBotToken,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Chatwoot ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

export const chatwoot = {
  sendText(conversationId, content) {
    return call('POST', `/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: false,
    });
  },

  // Product cards (rendered as cards in the website widget)
  sendCards(conversationId, items) {
    return call('POST', `/conversations/${conversationId}/messages`, {
      content: items.map((i) => i.title).join(', '),
      content_type: 'cards',
      content_attributes: { items },
      message_type: 'outgoing',
      private: false,
    });
  },

  sendPrivateNote(conversationId, content) {
    return call('POST', `/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: true,
    });
  },

  typing(conversationId, on) {
    return call('POST', `/conversations/${conversationId}/toggle_typing_status`, {
      typing_status: on ? 'on' : 'off',
    }).catch(() => {});
  },

  // Hand the conversation to humans: status "open" makes it appear for agents
  // and lets auto-assignment pick it up.
  openForHumans(conversationId) {
    return call('POST', `/conversations/${conversationId}/toggle_status`, { status: 'open' });
  },

  async addLabels(conversationId, labels) {
    const current = await call('GET', `/conversations/${conversationId}/labels`).catch(() => ({ payload: [] }));
    const merged = [...new Set([...(current?.payload || []), ...labels])];
    return call('POST', `/conversations/${conversationId}/labels`, { labels: merged });
  },

  getConversation(conversationId) {
    return call('GET', `/conversations/${conversationId}`);
  },
};
