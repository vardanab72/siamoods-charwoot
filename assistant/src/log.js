// JSON-lines logging (visible in Coolify logs). Never log message contents or secrets.
const write = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra || {}) }));

export const log = {
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
