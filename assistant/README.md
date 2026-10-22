# SiaMoods chat assistant

AI shopping & support assistant for the SiaMoods Chatwoot inboxes. Runs as a
Chatwoot **Agent Bot**: Chatwoot sends every message of a bot-enabled inbox to
this service; it answers with Claude, searching the live siamoods.com catalog,
and hands the conversation to a human when needed.

## What it does
- Replies in Armenian / Russian / English (customer's language)
- Searches the real catalog (type, stone, collection, budget, discounts, sizes in stock)
- Answers delivery / payment / exchange / store questions from `src/knowledge.js`
- Website chat: shows product cards; Messenger/Instagram: links in text
- Tags conversations with the shop's labels
- Hands off to a consultant (status → open + private note with an Armenian summary)
- Steps back for 12h as soon as a consultant writes in the conversation
- Any error → conversation silently handed to humans

## Configuration (Coolify environment variables)
| Variable | Required | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | — |
| `CHATWOOT_BOT_TOKEN` | yes | agent bot access token |
| `WEBHOOK_SECRET` | yes | random string; bot URL = `https://<host>/webhook/<secret>` |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-5-5` (e.g. `claude-opus-5-5`, `claude-haiku-5-5`) |
| `ALLOWED_INBOX_IDS` | no | all inboxes the bot is attached to |
| `CHATWOOT_BASE_URL` | no | `https://chat.siamoods.com` |
| `CHATWOOT_ACCOUNT_ID` | no | `2` |
| `SITE_API_BASE_URL` | no | `https://admin.siamoods.com/api` |
| `DEBOUNCE_MS` | no | `3500` |

Persistent volume: `/data` (conversation history for context, auto-cleaned after 60 days).

## Change shop facts
Edit `src/knowledge.js` (and tone rules in `src/prompt.js`), push to `main`;
GitHub Actions builds `ghcr.io/vardanab72/siamoods-chat-assistant:latest`.
Redeploy in Coolify.

## Tests
`npm test` — mocked end-to-end flow (webhook → Claude tool use → catalog → Chatwoot).
