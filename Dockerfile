# Chatwoot with Armenian (hy) live-chat widget for SiaMoods.
#
# Official Chatwoot image + Armenian widget translation. Only the frontend
# assets are rebuilt; Ruby code, gems and the database are untouched.
# To upgrade Chatwoot: bump CHATWOOT_VERSION, rebuild, and check the build
# passes (it fails loudly if upstream files changed shape).

ARG CHATWOOT_VERSION=v4.18.0

FROM chatwoot/chatwoot:${CHATWOOT_VERSION} AS builder

ARG PNPM_VERSION=10.2.0
ENV NODE_OPTIONS="--max-old-space-size=4096 --openssl-legacy-provider"
ENV RAILS_ENV=production

WORKDIR /app

RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && npm install -g pnpm@${PNPM_VERSION}

# Armenian widget strings
COPY overlay/ /app/

# Register hy in the widget's locale list
RUN sed -i "s#^import hu from './locale/hu.json';#&\nimport hy from './locale/hy.json';#" app/javascript/widget/i18n/index.js \
  && sed -i "s#^  hu,#&\n  hy,#" app/javascript/widget/i18n/index.js \
  && grep -q "^import hy from './locale/hy.json';" app/javascript/widget/i18n/index.js \
  && grep -q "^  hy,$" app/javascript/widget/i18n/index.js

# Add Armenian to the server's enabled languages (the widget only switches to
# languages on this list)
RUN sed -i "s#\(iso_639_1_code: 'sl', enabled: true }\)#\1,\n  44 => { name: 'Հայերեն (hy)', iso_639_3_code: 'hye', iso_639_1_code: 'hy', enabled: true }#" config/initializers/languages.rb \
  && grep -q "iso_639_1_code: 'hy'" config/initializers/languages.rb \
  && ruby -c config/initializers/languages.rb

RUN rm -rf public/vite public/packs \
  && pnpm i --frozen-lockfile \
  && SECRET_KEY_BASE=precompile_placeholder RAILS_LOG_TO_STDOUT=enabled bundle exec rake assets:precompile \
  && grep -rlq "Մենք առցանց ենք" public/vite \
  && test -f public/packs/js/sdk.js

FROM chatwoot/chatwoot:${CHATWOOT_VERSION}

COPY --from=builder /app/public/vite /app/public/vite
COPY --from=builder /app/public/packs /app/public/packs
COPY --from=builder /app/config/initializers/languages.rb /app/config/initializers/languages.rb
COPY --from=builder /app/app/javascript/widget/i18n /app/app/javascript/widget/i18n
