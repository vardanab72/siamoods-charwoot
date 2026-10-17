# siamoods-chatwoot

Official Chatwoot image plus an Armenian (`hy`) translation of the live-chat
widget used on siamoods.com (`chat.siamoods.com`).

- `overlay/app/javascript/widget/i18n/locale/hy.json` — Armenian widget strings
- `Dockerfile` — registers `hy`, rebuilds frontend assets on top of `chatwoot/chatwoot:<version>`
- GitHub Actions builds and pushes `ghcr.io/vardanab72/siamoods-chatwoot:<version>-hy`

## Deploy (Coolify)
In the Chatwoot service, replace the image of **both** the Rails and Sidekiq
containers:

```
chatwoot/chatwoot:v4.18.0  →  ghcr.io/vardanab72/siamoods-chatwoot:v4.18.0-hy
```
then redeploy. No database changes; rolling back = switch the image back.

## Upgrading Chatwoot
1. Change `CHATWOOT_VERSION` in `.github/workflows/build.yml`
2. Compare upstream `app/javascript/widget/i18n/locale/en.json` with `hy.json` and translate any new keys
3. Push — the build fails loudly if the patches no longer apply
4. Update the image tag in Coolify
