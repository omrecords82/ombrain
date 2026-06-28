'use strict';

/**
 * Skill script safety checks — doctrine-aligned guards before store/run.
 * Mirrors handoff-relay denylist patterns (rm -rf, curl|sh, etc.).
 */

const { parseHost, isLanHost } = require('../ai/circuitBreaker');
const { redactForLog } = require('../ai/redactor');

const VALID_LANGUAGES = new Set(['bash', 'python', 'node']);

const UNSAFE_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s|-fr\b|-rf\b)/i, reason: 'destructive_rm' },
  { re: /\brm\s+-(-)?[rR]f\b/i, reason: 'destructive_rm_rf' },
  { re: /curl\s+[^\n|]*\|\s*(ba)?sh\b/i, reason: 'curl_pipe_shell' },
  { re: /wget\s+[^\n|]*\|\s*(ba)?sh\b/i, reason: 'wget_pipe_shell' },
  { re: /\|\s*(ba)?sh\s*($|;|\n)/im, reason: 'pipe_to_shell' },
  { re: /\bmkfs\b/i, reason: 'mkfs' },
  { re: /\bdd\s+if=/i, reason: 'dd_raw_disk' },
  { re: /\bchmod\s+777\b/i, reason: 'chmod_777' },
  { re: />\s*\/dev\/sd[a-z]/i, reason: 'write_block_device' },
  { re: /:\(\)\{\s*:\|:&\s*\};:/, reason: 'fork_bomb' },
  { re: /\bsudo\s+rm\b/i, reason: 'sudo_rm' },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: 'system_power' },
  { re: /\bsystemctl\s+(stop|restart|disable|mask|kill)\b/i, reason: 'systemctl_disruptive' },
  { re: /\bkill\s+-9\s+1\b/, reason: 'kill_init' },
  { re: /\beval\s*\(/i, reason: 'eval' },
  { re: /\bexec\s*\(/i, reason: 'exec_injection' },
  { re: /child_process\.exec\s*\(/i, reason: 'node_exec' },
  { re: /os\.system\s*\(/i, reason: 'python_os_system' },
  { re: /subprocess\.(call|Popen|run)\s*\([^)]*shell\s*=\s*True/i, reason: 'python_shell_true' },
];

const EXTERNAL_URL_RE = /https?:\/\/[^\s'"<>)\]]+/gi;

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
]);

function normalizeSkillKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function isValidSkillKey(key) {
  const k = normalizeSkillKey(key);
  return k.length >= 2 && k.length <= 80 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(k);
}

function scanExternalHosts(scriptBody) {
  const blocked = [];
  const text = String(scriptBody || '');
  let m;
  EXTERNAL_URL_RE.lastIndex = 0;
  while ((m = EXTERNAL_URL_RE.exec(text)) !== null) {
    try {
      const host = parseHost(m[0]);
      if (!host) continue;
      if (ALLOWED_EXTERNAL_HOSTS.has(host)) continue;
      if (isLanHost(host)) continue;
      blocked.push({ url: m[0].slice(0, 120), host, reason: 'external_host_blocked' });
    } catch (_) {
      blocked.push({ url: m[0].slice(0, 120), host: '(unparseable)', reason: 'external_url' });
    }
  }
  return blocked;
}

function scanUnsafePatterns(scriptBody, language) {
  const hits = [];
  const text = String(scriptBody || '');
  for (const { re, reason } of UNSAFE_PATTERNS) {
    if (re.test(text)) hits.push({ reason, pattern: re.source });
  }
  if (language === 'bash' && /\bcurl\b/i.test(text) && /\|\s*(ba)?sh\b/i.test(text)) {
    if (!hits.some((h) => h.reason === 'curl_pipe_shell')) {
      hits.push({ reason: 'curl_pipe_shell', pattern: 'curl|sh' });
    }
  }
  return hits;
}

function detectSecretsInScript(scriptBody) {
  const redacted = redactForLog(String(scriptBody || ''));
  return redacted !== String(scriptBody || '');
}

/**
 * Validate a skill script before store or run.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateSkillScript({ script_body, language }) {
  const errors = [];
  const warnings = [];
  const lang = String(language || '').toLowerCase();

  if (!VALID_LANGUAGES.has(lang)) {
    errors.push('invalid_language');
  }
  if (!script_body || String(script_body).trim().length < 1) {
    errors.push('script_body_required');
  }
  if (String(script_body || '').length > 65536) {
    errors.push('script_body_too_large');
  }

  const unsafe = scanUnsafePatterns(script_body, lang);
  for (const hit of unsafe) {
    errors.push(`unsafe_pattern:${hit.reason}`);
  }

  const external = scanExternalHosts(script_body);
  for (const hit of external) {
    errors.push(`external_host:${hit.host}`);
  }

  if (detectSecretsInScript(script_body)) {
    warnings.push('possible_secrets_detected_redact_before_store');
  }

  return { ok: errors.length === 0, errors, warnings };
}

function sanitizeRunEnv(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (/secret|password|token|api[_-]?key|authorization|bearer/i.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}

module.exports = {
  VALID_LANGUAGES,
  normalizeSkillKey,
  isValidSkillKey,
  validateSkillScript,
  scanUnsafePatterns,
  scanExternalHosts,
  detectSecretsInScript,
  sanitizeRunEnv,
};
