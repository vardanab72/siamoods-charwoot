// All settings come from environment variables (set in Coolify).

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),

  // Agent bot "secret" from Chatwoot; used to verify X-Chatwoot-Signature on every webhook.
  webhookSecret: required('CHATWOOT_WEBHOOK_SECRET'),

  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  maxTokens: Number(process.env.MAX_TOKENS || 1200),
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS || 6),

  chatwootBaseUrl: (process.env.CHATWOOT_BASE_URL || 'https://chat.siamoods.com').replace(/\/$/, ''),
  chatwootAccountId: Number(process.env.CHATWOOT_ACCOUNT_ID || 2),
  chatwootBotToken: required('CHATWOOT_BOT_TOKEN'),

  siteApiBaseUrl: (process.env.SITE_API_BASE_URL || 'https://api.siamoods.com/api').replace(/\/$/, ''),
  siteBaseUrl: (process.env.SITE_BASE_URL || 'https://siamoods.com').replace(/\/$/, ''),

  // Wait this long after the customer's last message before answering,
  // so several quick messages are answered together.
  debounceMs: Number(process.env.DEBOUNCE_MS || 3500),

  // Only these inbox IDs are answered (comma separated). Empty = every inbox the bot is attached to.
  allowedInboxIds: (process.env.ALLOWED_INBOX_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean),

  // Test mode: when set (comma-separated Chatwoot contact IDs), only these contacts get AI replies;
  // other conversations are opened for humans immediately.
  testContactIds: (process.env.TEST_CONTACT_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean),

  // Echo messages (sent outside Chatwoot) that are automatic, not a person answering.
  // Default: n8n comment→DM messages and Meta's FAQ / welcome / away texts.
  automatedEchoPatterns: (
    process.env.AUTOMATED_ECHO_PATTERNS ||
    [
      '^մանրամասների և պատվիրելու համար',
      '^Մենք Ձեզ շուտով կպատասխանենք',
      '^Այս մոդելը այս պահին առկա չէ',
      '^✅ Անվճար առաքում Հայփոստով',
      '^🤗 Հարգելի',
      '^🙂 Ողջույն .*շնորհակալություն հաղորդագրության համար',
    ].join('||')
  )
    .split('||')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(p, 'u')),

  // Optional: URL that returns { caption, permalink } for an Instagram media id (?id=...),
  // e.g. an n8n webhook using the shop's Instagram token. Used for posts customers share in DM.
  igCaptionUrl: (process.env.IG_CAPTION_URL ?? 'https://n8n.siamoods.com/webhook/ig-post-caption-fa4ace249a0bce3f').trim(),

  dataDir: process.env.DATA_DIR || '/data',
  timezone: 'Asia/Yerevan',
};
