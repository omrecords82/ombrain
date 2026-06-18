'use strict';

/**
 * Minimal structured logger that runs every message through the redactor before
 * it reaches stdout. This is a defense-in-depth layer: no never-log secret or
 * tenant identifier should ever appear in Brain logs (OM-DOCTRINE-0001
 * secrets.never_log + tenant.sanctity).
 */

const { redactForLog } = require('../ai/redactor');

function emit(level, msg, meta) {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === 'string' ? msg : redactForLog(msg),
  };
  if (meta !== undefined) record.meta = redactForLog(meta);
  // Redact the whole record string as a final pass.
  const line = redactForLog(JSON.stringify(record));
  process.stdout.write(line + '\n');
}

module.exports = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
};
