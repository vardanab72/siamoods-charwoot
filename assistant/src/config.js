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

  siteApiBaseUrl: (process.env.SITE_API_BASE_URL || 'https://admin.siamoods.com/api').replace(/\/$/, ''),
  siteBaseUrl: (process.env.SITE_BASE_URL || 'https://siamoods.com').replace(/\/$/, ''),

  // Wait this long after the customer's last message before answering,
  // so several quick messages are answered together.
  debounceMs: Number(process.env.DEBOUNCE_MS || 3500),

  // Only these inbox IDs are answered (comma separated). Empty = every inbox the bot is attached to.
  allowedInboxIds: (process.env.ALLOWED_INBOX_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean),

  dataDir: process.env.DATA_DIR || '/data',
  timezone: 'Asia/Yerevan',
};
