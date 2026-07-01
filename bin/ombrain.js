#!/usr/bin/env node
'use strict';

/**
 * ombrain — system-wide CLI client for the om-brain HTTP API.
 *
 * Unlike bin/om-brain-cli.js (which loads the Brain's modules directly and only
 * works from inside the source tree), this command is a thin HTTP client. It
 * talks to a running om-brain service over its REST API, so it works from ANY
 * server that can reach the Brain — no source code required on that host.
 *
 * TOPOLOGY (master / backup with per-host API ports)
 * ---------------------------------------------------
 * ombrain talks to a *registry* of Brain servers, not a single URL. Each server
 * has a role (master | backup), a priority, and one or more API ports (default
 * 8390 on om-dev). For every request ombrain:
 *   1. picks the highest-priority reachable server (master first), and
 *   2. load-balances the request across that server's port list (round-robin),
 *      skipping dead ports, then
 *   3. fails over to the next server (backup) if the whole pool is unreachable.
 * The endpoint that actually served the request is reported on stderr.
 *
 * Endpoint resolution precedence (first match wins):
 *   1. --url <url>           one explicit endpoint, no failover
 *   2. --server <name>       one named registry server (its pool, no host failover)
 *   3. $OMBRAIN_URL          one explicit endpoint, no failover
 *   4. the server registry   master -> backups, each across its port list
 *   5. http://127.0.0.1:8390 last-resort default (local Brain API)
 *
 * Registry files (JSON), highest precedence first:
 *   - $OMBRAIN_SERVERS                  (explicit path)
 *   - ~/.config/ombrain/servers.json    (per-user)
 *   - /etc/om-brain/ombrain.servers.json (system-wide)
 *
 * Zero runtime dependencies — uses only Node's built-in http/https/fs.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const DEFAULT_URL = 'http://127.0.0.1:8390';
const VERSION = '2.0.0';

// Where registries live (read order: env > user > system).
const SYSTEM_REGISTRY = '/etc/om-brain/ombrain.servers.json';
const USER_REGISTRY = path.join(os.homedir(), '.config', 'ombrain', 'servers.json');

// Built-in default topology when no registry file exists yet.
function defaultRegistry() {
  return {
    version: 1,
    // Round-robin offset persisted so successive invocations spread load.
    rr: 0,
    servers: [
      {
        name: 'master',
        scheme: 'http',
        host: '192.168.1.254',
        ports: '8390',
        role: 'master',
        priority: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tiny ANSI helpers (auto-disabled when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const cyan = (s) => c('36', s);

function die(msg, code = 1) {
  process.stderr.write(`${red('error:')} ${msg}\n`);
  process.exit(code);
}
function note(msg) { process.stderr.write(dim(msg) + '\n'); }

/** Print API data: human-readable by default; pass --json for machine output. */
function emit(flags, data, formatter) {
  if (flags && flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (typeof data === 'string') {
    process.stdout.write(data + '\n');
    return;
  }
  const text = typeof formatter === 'function' ? formatter(data) : formatGeneric(data);
  process.stdout.write(text + '\n');
}

function out(obj) {
  emit({ json: false }, obj);
}

function formatGeneric(b) {
  if (b == null) return '';
  if (Array.isArray(b)) return b.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
  if (typeof b !== 'object') return String(b);
  return Object.entries(b)
    .filter(([k, v]) => v != null && v !== '' && k !== 'ok')
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((x) => '  ' + (typeof x === 'object' ? JSON.stringify(x) : x)).join('\n')}`;
      if (typeof v === 'object') return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${v}`;
    })
    .join('\n');
}

function formatOpsAuthBlock(auth) {
  const lines = [];
  const authState = auth.valid ? green('valid') : (auth.configured ? red(auth.reason || 'invalid') : yellow('not configured'));
  lines.push(`  ops jwt (${auth.jwt_var || 'BRAIN_OPS_JWT'}): ${authState}`);
  const days = auth.days_until_expiry;
  if (auth.valid && auth.expires_at != null && days != null) {
    if (days <= 14) {
      lines.push(yellow(`    WARNING: expires in ${days} day(s) on ${auth.expires_at}`));
      lines.push(dim('    Re-provision: provision-brain-ingest.sh --update-auth01'));
    } else {
      lines.push(`    expires: ${auth.expires_at} (${days} days remaining)`);
    }
  } else if (!auth.valid) {
    if (auth.reason === 'expired' || (days != null && days < 0)) {
      lines.push(red('    WARNING: ops JWT EXPIRED — adapters report auth_degraded'));
      lines.push(dim('    Re-provision: provision-brain-ingest.sh --update-auth01'));
    } else if (auth.reason === 'missing') {
      lines.push(yellow('    WARNING: ops JWT not configured'));
    } else if (auth.reason === 'malformed') {
      lines.push(red('    WARNING: ops JWT malformed'));
    } else {
      lines.push(red(`    WARNING: ops JWT invalid (${auth.reason || 'unknown'})`));
    }
  } else if (auth.expires_at) {
    lines.push(`    expires: ${auth.expires_at}`);
  }
  if (auth.api_base_url) lines.push(`    api: ${auth.api_base_url}`);
  return lines;
}

function formatStatus(b) {
  const svc = b.service || 'om-brain';
  const status = b.ok ? green('ok') : red('FAIL');
  const lines = [`${bold(svc)}  ${status}`];
  if (b.version) lines.push(`  version: ${b.version}`);
  if (b.uptime_sec != null) lines.push(`  uptime: ${b.uptime_sec}s`);
  if (b.bind) lines.push(`  bind: ${b.bind.host}:${b.bind.port}`);
  if (b.api && b.api.lan) lines.push(`  lan: ${b.api.lan}`);
  else if (b.lan_api) lines.push(`  lan: ${b.lan_api}`);
  if (b.nats) {
    const natsState = b.nats.state || 'unknown';
    const natsLine = natsState === 'connected' ? green(natsState) : yellow(natsState);
    lines.push(`  nats: ${natsLine}${b.nats.url_host ? ' (' + b.nats.url_host + ')' : ''}`);
  }
  if (b.ops_auth) {
    lines.push(...formatOpsAuthBlock(b.ops_auth));
  }
  if (b.adapters && Object.keys(b.adapters).length) {
    lines.push('  adapters:');
    for (const [name, row] of Object.entries(b.adapters)) {
      if (!row.enabled) continue;
      const st = row.state === 'ok'
        ? green(row.state)
        : (row.state === 'auth_degraded' ? red(row.state) : (row.state === 'auth_error' ? red(row.state) : yellow(row.state || 'unknown')));
      const extra = row.last_status != null ? ` http=${row.last_status}` : '';
      const msg = row.auth_message ? ` — ${row.auth_message}` : '';
      lines.push(`    ${name}: ${st}${extra}${msg}`);
    }
  }
  if (b.recent_auth_errors && b.recent_auth_errors.length) {
    lines.push(yellow('  recent auth errors:'));
    for (const err of b.recent_auth_errors.slice(0, 5)) {
      const label = err.auth_message || err.last_error || err.state || 'auth_error';
      lines.push(`    ${err.adapter}: ${label} (${err.last_poll_at || '?'})`);
    }
  }
  return lines.join('\n');
}

function opsAuthExitHint(b) {
  const auth = b && b.ops_auth;
  if (!auth) return 0;
  if (!auth.valid) return 2;
  if (auth.needs_attention || (auth.days_until_expiry != null && auth.days_until_expiry <= 14)) return 1;
  return 0;
}

function formatHealth(b) {
  const svc = b.service || 'om-brain';
  const status = b.ok ? green('ok') : red('FAIL');
  const lines = [`${bold(svc)}  ${status}`];
  if (b.phase != null) lines.push(`  phase: ${b.phase}`);
  if (b.posture) lines.push(`  posture: ${b.posture}`);
  if (b.memory_backend) lines.push(`  memory: ${b.memory_backend}`);
  if (b.node_env) lines.push(`  env: ${b.node_env}`);
  if (b.llm_endpoint_allowed != null) {
    const llm = b.llm_endpoint_allowed ? green('allowed') : yellow('blocked');
    lines.push(`  llm: ${llm}${b.llm_endpoint_reason ? ' (' + b.llm_endpoint_reason + ')' : ''}`);
  }
  if (b.executes_actions != null) lines.push(`  executes actions: ${b.executes_actions ? 'yes' : 'no'}`);
  if (b.port != null) lines.push(`  port: ${b.port}`);
  return lines.join('\n');
}

function formatAsk(b) {
  const lines = [];
  if (b.mode) lines.push(`${bold('mode')}: ${cyan(b.mode)}`);
  if (b.answer != null) {
    if (lines.length) lines.push('');
    lines.push(typeof b.answer === 'string' ? b.answer : String(b.answer));
  }
  if (b.recommendation && b.recommendation !== b.answer) {
    lines.push('');
    lines.push(`${bold('recommendation')}: ${b.recommendation}`);
  }
  if (b.detail && b.detail.type) {
    lines.push('');
    lines.push(dim(`detail: ${b.detail.type}`));
  }
  return lines.join('\n');
}

function formatClassify(b) {
  const parts = [`${bold('mode')}: ${cyan(b.mode || 'unknown')}`];
  if (b.detail_type) parts.push(`${bold('type')}: ${b.detail_type}`);
  return parts.join('\n');
}

function formatPascha(b) {
  if (b.pascha) {
    const disp = b.pascha_display ? ` (${b.pascha_display})` : '';
    return `Pascha ${b.year}: ${bold(b.pascha)}${disp}`;
  }
  return formatGeneric(b);
}

function formatFasting(b) {
  const level = b.level != null ? b.level : 'unknown';
  return `${b.date}: ${bold(level)}${b.reason ? ' — ' + b.reason : ''}`;
}

function formatFeasts(b) {
  const lines = [`Feasts for ${b.year} (${b.moveable_count || 0} moveable, ${b.fixed_count || 0} fixed)`, ''];
  const printGroup = (label, items) => {
    if (!items || !items.length) return;
    lines.push(bold(label));
    for (const f of items) lines.push(`  ${f.date}  ${f.name}`);
    lines.push('');
  };
  printGroup('Moveable', b.moveable_feasts);
  printGroup('Fixed', b.fixed_feasts);
  return lines.join('\n').trimEnd();
}

function formatToday(b) {
  const lines = [`${bold('Today')} ${b.date}`];
  if (b.season) lines.push(`  season: ${b.season}`);
  if (b.fasting) {
    const f = b.fasting;
    lines.push(`  fasting: ${f.level || 'none'}${f.reason ? ' — ' + f.reason : ''}`);
  }
  if (b.saints && b.saints.length) {
    lines.push(`  saints (${b.saint_count || b.saints.length}):`);
    for (const s of b.saints.slice(0, 12)) lines.push(`    • ${s.name}`);
    if (b.saints.length > 12) lines.push(dim(`    … and ${b.saints.length - 12} more`));
  }
  return lines.join('\n');
}

function formatSaints(b) {
  const cal = b.calendar === 'new' ? 'N.S.' : 'O.S.';
  const lines = [`Saints ${b.date} (${cal}, ${b.year}) — ${b.count || 0} commemorated`, ''];
  if (b.saints && b.saints.length) {
    for (const s of b.saints) lines.push(`  • ${s.name}`);
  } else {
    lines.push('  (none recorded)');
  }
  return lines.join('\n');
}

function formatYear(b) {
  const lines = [`Calendar ${b.year}`];
  if (b.pascha) lines.push(`  Pascha: ${b.pascha}`);
  if (b.western_easter) lines.push(`  Western Easter: ${b.western_easter}`);
  if (b.moveable_feasts) {
    const n = Array.isArray(b.moveable_feasts) ? b.moveable_feasts.length : Object.keys(b.moveable_feasts).length;
    lines.push(`  moveable feasts: ${n}`);
  }
  if (b.fixed_feasts) {
    const n = Array.isArray(b.fixed_feasts) ? b.fixed_feasts.length : Object.keys(b.fixed_feasts).length;
    lines.push(`  fixed feasts: ${n}`);
  }
  return lines.join('\n');
}

function formatRange(b) {
  const lines = [`Fasting calendar ${b.start} → ${b.end} (${b.count || 0} days)`, ''];
  if (b.days) {
    for (const d of b.days) {
      const f = d.fasting || {};
      lines.push(`  ${d.date}  ${f.level || 'none'}${f.reason ? ' — ' + f.reason : ''}`);
    }
  }
  return lines.join('\n');
}

function formatModes(b) {
  const modes = b.modes || b;
  if (!Array.isArray(modes)) return formatGeneric(b);
  return modes.map((m) => `  ${cyan(String(m.id || m).padEnd(14))} ${m.description || m.label || ''}`).join('\n').trim();
}

function formatChurchFind(b) {
  const churches = b.churches || b.results || [];
  if (!churches.length) return b.note || 'No churches found.';
  const lines = [`Found ${churches.length} church(es)`, ''];
  for (const c of churches) {
    lines.push(`  ${bold(c.name || 'Unknown')}`);
    if (c.address) lines.push(`    ${c.address}`);
    if (c.jurisdiction) lines.push(`    ${dim(c.jurisdiction)}`);
  }
  return lines.join('\n');
}

function formatSkillsList(b) {
  const rows = b.skills || [];
  if (!rows.length) return 'No active skills.';
  const lines = [`${bold('Skills')} (${b.count != null ? b.count : rows.length})`, ''];
  for (const s of rows) {
    lines.push(`  ${cyan(String(s.skill_key).padEnd(32))} [${s.language}] v${s.version || 1} runs=${s.run_count || 0}`);
    if (s.title) lines.push(`    ${s.title}`);
  }
  return lines.join('\n');
}

function formatSkillDetail(b) {
  const s = b.skill || b;
  if (!s || !s.skill_key) return formatGeneric(b);
  const lines = [
    `${bold(s.skill_key)}  [${s.language}] v${s.version || 1}`,
    s.title ? `title: ${s.title}` : null,
    s.description ? `description: ${s.description}` : null,
    '',
    s.script_body || '(no script body)',
  ].filter((x) => x != null);
  return lines.join('\n');
}

function formatSkillRun(b) {
  if (b.dry_run) return `${yellow('dry-run')} — would execute ${b.skill_key || 'skill'} (${b.language || '?'})`;
  if (b.executed) {
    const code = b.exit_code != null ? b.exit_code : '?';
    const status = b.exit_code === 0 ? green('ok') : red('failed');
    return `executed ${b.skill_key || 'skill'} — exit ${code} ${status}`;
  }
  return formatGeneric(b);
}

function formatActionsList(b) {
  const rows = b.actions || [];
  if (!rows.length) return 'No actions registered.';
  const lines = [`${bold('Actions')} (${b.count != null ? b.count : rows.length})`, ''];
  for (const a of rows) {
    lines.push(`  ${cyan(String(a.id).padEnd(36))} [${a.risk}] ${a.title || ''}`);
    if (a.category) lines.push(`    ${dim(a.category)} · ${a.source || 'omai'}`);
  }
  return lines.join('\n');
}

function formatActionDetail(b) {
  const a = b.action || b;
  if (!a || !a.id) return formatGeneric(b);
  const lines = [
    `${bold(a.id)}  [${a.risk}]`,
    a.title ? `title: ${a.title}` : null,
    a.description ? `description: ${a.description}` : null,
    a.mutation != null ? `mutation: ${a.mutation}` : null,
    a.supports_dry_run != null ? `supports_dry_run: ${a.supports_dry_run}` : null,
    a.required_roles ? `roles: ${a.required_roles.join(', ')}` : null,
  ].filter((x) => x != null);
  return lines.join('\n');
}

function formatActionRun(b) {
  if (b.dry_run) {
    const preview = b.preview && b.preview.input ? ` with title "${b.preview.input.title || '?'}"` : '';
    return `${yellow('dry-run')} — would run ${b.action_id || 'action'}${preview}`;
  }
  if (b.committed && b.result) {
    if (b.result.work_item_code) {
      const plane = b.result.plane_mirror;
      const planeLine = plane
        ? (plane.ok ? `  plane: ${plane.issue_identifier || plane.issue_id}` : `  plane: ${yellow('mirror failed')}`)
        : '';
      return [
        `${green('draft created')} ${bold(b.result.work_item_code)}  #${b.result.item_id}`,
        `  title: ${b.result.title}`,
        b.result.category ? `  category: ${b.result.category}` : null,
        planeLine,
      ].filter(Boolean).join('\n');
    }
    const summary = b.result.overall_ok != null
      ? (b.result.overall_ok ? green('healthy') : red('unhealthy'))
      : (b.result.fleet_health ? `fleet ${b.result.fleet_health.score}%` : green('ok'));
    return `executed ${b.action_id || 'action'} — ${summary}`;
  }
  return formatGeneric(b);
}

function formatDraftCreate(b) {
  return formatActionRun(b);
}

function formatActionResolve(b) {
  if (!b.matched) return `No action matched for: ${b.query || b.matched_query || ''}`;
  const a = b.action || {};
  return [
    `${bold('matched')}: ${cyan(a.id || '?')}`,
    a.title ? `title: ${a.title}` : null,
    b.confidence != null ? `confidence: ${b.confidence}` : null,
  ].filter(Boolean).join('\n');
}

function formatActionHistory(b) {
  const rows = b.history || [];
  if (!rows.length) return 'No action executions recorded.';
  const lines = [`${bold('Action history')} (${b.count != null ? b.count : rows.length})`, ''];
  for (const h of rows.slice(0, 20)) {
    const id = h.action_id || h.entity_id || h.action || '?';
    const when = h.created_at || h.executed_at || '';
    lines.push(`  ${when}  ${cyan(String(id))}  ${h.details?.result || h.result || ''}`);
  }
  return lines.join('\n');
}

function inferLanguageFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.sh' || ext === '.bash') return 'bash';
  if (ext === '.py') return 'python';
  if (ext === '.js' || ext === '.mjs') return 'node';
  return null;
}

function httpErrorMessage(status, body) {
  const parts = [`${status}`];
  if (body && body.error) parts.push(String(body.error));
  if (body && Array.isArray(body.details)) parts.push(body.details.join(', '));
  if (body && Array.isArray(body.allowed)) parts.push(`allowed: ${body.allowed.join(', ')}`);
  if (body && body.hint) parts.push(`(${body.hint})`);
  return parts.join(' ').trim();
}

function formatServerList(data) {
  const lines = [`registry: ${data.registry}`, ''];
  if (!data.servers || !data.servers.length) return lines.concat('(no servers registered)').join('\n');
  lines.push(`${'NAME'.padEnd(12)} ${'ROLE'.padEnd(8)} ${'PRI'.padStart(3)}  ${'HOST'.padEnd(16)} PORTS           POOL`);
  for (const s of data.servers) {
    const host = String(s.endpoint || '').replace(/^https?:\/\//, '');
    lines.push(`${s.name.padEnd(12)} ${String(s.role).padEnd(8)} ${String(s.priority).padStart(3)}  ${host.padEnd(16)} ${String(s.ports).padEnd(15)} ${s.port_count}`);
  }
  return lines.join('\n');
}

function formatServerStatus(report) {
  if (!report.length) return '(no servers in registry)';
  return report.map((s) => {
    const tag = s.reachable ? green('UP  ') : red('DOWN');
    const sample = `${s.healthy_in_sample}/${s.sampled} healthy in sample`;
    return `${bold(s.name.padEnd(12))} ${String(s.role).padEnd(7)} ${String(s.host).padEnd(16)} pool ${s.ports}  ${tag}  (${sample})`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Port-pool parsing: "60000-62000", "8391,8392", "8391, 60000-60010"
// Returns a (possibly large) lazy iterator factory rather than a materialized
// array, so a 2001-port range doesn't allocate needlessly.
// ---------------------------------------------------------------------------
function parsePortSpec(spec) {
  // Normalize to a list of [start,end] inclusive segments.
  const segments = [];
  String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((tok) => {
      const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10);
        let b = parseInt(m[2], 10);
        if (a > b) [a, b] = [b, a];
        segments.push([a, b]);
      } else if (/^\d+$/.test(tok)) {
        const p = parseInt(tok, 10);
        segments.push([p, p]);
      }
    });
  return segments;
}

function portCount(segments) {
  return segments.reduce((n, [a, b]) => n + (b - a + 1), 0);
}

// Get the i-th port (0-based) across the ordered segments.
function portAt(segments, i) {
  let idx = i;
  for (const [a, b] of segments) {
    const len = b - a + 1;
    if (idx < len) return a + idx;
    idx -= len;
  }
  return null;
}

// Build an ordered list of ports to try for one server on this request,
// starting at a round-robin offset and wrapping, capped at `maxTries`.
function portsToTry(segments, rrStart, maxTries) {
  const total = portCount(segments);
  if (total === 0) return [];
  const tries = Math.min(maxTries, total);
  const ports = [];
  for (let k = 0; k < tries; k += 1) {
    ports.push(portAt(segments, (rrStart + k) % total));
  }
  return ports;
}

// ---------------------------------------------------------------------------
// Registry load / save
// ---------------------------------------------------------------------------
function registryPath(forWrite) {
  if (process.env.OMBRAIN_SERVERS) return process.env.OMBRAIN_SERVERS;
  // Read precedence: user file if present, else system file if present.
  if (!forWrite) {
    if (fs.existsSync(USER_REGISTRY)) return USER_REGISTRY;
    if (fs.existsSync(SYSTEM_REGISTRY)) return SYSTEM_REGISTRY;
    return null;
  }
  // Write precedence: explicit env, else system if writable/exists, else user.
  if (fs.existsSync(SYSTEM_REGISTRY)) {
    try { fs.accessSync(SYSTEM_REGISTRY, fs.constants.W_OK); return SYSTEM_REGISTRY; }
    catch (_) { /* fall through to user */ }
  }
  return USER_REGISTRY;
}

function loadRegistry() {
  const p = registryPath(false);
  if (!p) return defaultRegistry();        // no file anywhere -> built-in default
  try {
    const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
    // A valid file with an explicit (even empty) servers array is respected as-is;
    // we only synthesize a default when the file is missing or malformed.
    if (!reg.servers || !Array.isArray(reg.servers)) {
      return defaultRegistry();
    }
    if (typeof reg.rr !== 'number') reg.rr = 0;
    return reg;
  } catch (e) {
    note(`warning: could not read registry ${p}: ${e.message}; using built-in default`);
    return defaultRegistry();
  }
}

function saveRegistry(reg, explicitPath) {
  const p = explicitPath || registryPath(true);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  return p;
}

// Persist only the round-robin cursor (best-effort; never fatal).
function bumpRR(reg, delta) {
  try {
    reg.rr = ((reg.rr || 0) + delta) % 1000000;
    const p = registryPath(true);
    // Only write if we can without surprising the user (file must already exist
    // or be the user file). Avoid creating /etc files implicitly here.
    if (fs.existsSync(p) || p === USER_REGISTRY) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(reg, null, 2) + '\n', 'utf8');
    }
  } catch (_) { /* best-effort */ }
}

// Sorted server list: master(s) first, then by priority ascending.
function orderedServers(reg) {
  return [...reg.servers].sort((a, b) => {
    const ra = a.role === 'master' ? 0 : 1;
    const rb = b.role === 'master' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (a.priority || 0) - (b.priority || 0);
  });
}

function serverBase(srv, port) {
  return `${srv.scheme || 'http'}://${srv.host}:${port}`;
}

// ---------------------------------------------------------------------------
// Low-level HTTP request (built-in, promise-wrapped)
// ---------------------------------------------------------------------------
function request(method, base, reqPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(base + reqPath); }
    catch (e) { return reject(new Error(`bad URL: ${base + reqPath}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(u, { method, headers, timeout: timeoutMs || 30000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (data) { try { parsed = JSON.parse(data); } catch (_) { parsed = data; } }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

const UNREACHABLE = /ECONNREFUSED|timed out|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i;

// ---------------------------------------------------------------------------
// Topology-aware request: try master across its port pool, then backups.
// Returns { status, body, endpoint } or throws an aggregated unreachable error.
// `opts`: { url, server, timeout, maxPortTries, quiet }
// ---------------------------------------------------------------------------
async function topoRequest(method, reqPath, body, opts) {
  const timeout = opts.timeout || 30000;
  const maxPortTries = opts.maxPortTries || 6; // cap attempts within a big pool

  // 1. Single explicit endpoint (no failover).
  if (opts.url) {
    const base = opts.url.replace(/\/+$/, '');
    const r = await request(method, base, reqPath, body, timeout);
    return { ...r, endpoint: base };
  }

  // Build the candidate server list.
  let servers = orderedServers(opts.registry);

  // Empty registry: fall back to the built-in default endpoint so the CLI
  // still works out-of-the-box with no configuration.
  if (servers.length === 0) {
    const base = DEFAULT_URL;
    const r = await request(method, base, reqPath, body, timeout);
    return { ...r, endpoint: base };
  }

  if (opts.server) {
    servers = servers.filter((s) => s.name === opts.server);
    if (servers.length === 0) die(`no server named "${opts.server}" in the registry`);
  }

  const errors = [];
  let rr = opts.registry.rr || 0;

  for (const srv of servers) {
    const segments = parsePortSpec(srv.ports);
    if (segments.length === 0) {
      errors.push(`${srv.name}: no ports configured`);
      continue;
    }
    const ports = portsToTry(segments, rr, maxPortTries);
    for (let i = 0; i < ports.length; i += 1) {
      const port = ports[i];
      const base = serverBase(srv, port);
      try {
        const r = await request(method, base, reqPath, body, timeout);
        // Reachable (even a 4xx/5xx is "reachable" — surface it, don't fail over).
        if (!opts.quiet) {
          const tag = srv.role === 'master' ? 'master' : 'backup';
          note(`[via ${tag}: ${srv.name} ${srv.host}:${port}]`);
        }
        // Advance the RR cursor so the next invocation starts elsewhere.
        bumpRR(opts.registry, i + 1);
        return { ...r, endpoint: base };
      } catch (e) {
        if (UNREACHABLE.test(String(e.message))) {
          errors.push(`${srv.name} ${srv.host}:${port} — ${e.message}`);
          continue; // try next port in this server's pool
        }
        throw e; // non-connection error: don't mask it
      }
    }
    // Whole pool for this server failed; advance rr and try next server.
    rr += maxPortTries;
  }

  const detail = errors.slice(0, 6).join('\n  ');
  const more = errors.length > 6 ? `\n  ... and ${errors.length - 6} more` : '';
  const err = new Error(`all Brain endpoints unreachable:\n  ${detail}${more}`);
  err.allUnreachable = true;
  throw err;
}

// Encode a query-string from an object, skipping null/undefined.
function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') { flags.url = argv[++i]; }
    else if (a.startsWith('--url=')) { flags.url = a.slice(6); }
    else if (a === '--server') { flags.server = argv[++i]; }
    else if (a.startsWith('--server=')) { flags.server = a.slice(9); }
    else if (a === '--role') { flags.role = argv[++i]; }
    else if (a.startsWith('--role=')) { flags.role = a.slice(7); }
    else if (a === '--ports') { flags.ports = argv[++i]; }
    else if (a.startsWith('--ports=')) { flags.ports = a.slice(8); }
    else if (a === '--priority') { flags.priority = parseInt(argv[++i], 10); }
    else if (a === '--scheme') { flags.scheme = argv[++i]; }
    else if (a === '--json') { flags.json = true; }
    else if (a === '--quiet') { flags.quiet = true; }
    else if (a === '--timeout') { flags.timeout = parseInt(argv[++i], 10); }
    else if (a === '--session') { flags.session = argv[++i]; }
    else if (a === '--mode') { flags.mode = argv[++i]; }
    else if (a === '--file') { flags.file = argv[++i]; }
    else if (a.startsWith('--file=')) { flags.file = a.slice(7); }
    else if (a === '--key') { flags.key = argv[++i]; }
    else if (a.startsWith('--key=')) { flags.key = a.slice(6); }
    else if (a === '--language') { flags.language = argv[++i]; }
    else if (a.startsWith('--language=')) { flags.language = a.slice(11); }
    else if (a === '--title') { flags.title = argv[++i]; }
    else if (a === '--description') { flags.description = argv[++i]; }
    else if (a === '--tags') { flags.tags = argv[++i]; }
    else if (a === '--script') { flags.script = argv[++i]; }
    else if (a === '--commit') { flags.commit = true; }
    else if (a === '--dry-run') { flags.dryRun = true; }
    else if (a === '--submit') { flags.submit = true; }
    else if (a === '--confirm') { flags.confirm = true; }
    else if (a === '--source') { flags.source = argv[++i]; }
    else if (a.startsWith('--source=')) { flags.source = a.slice(9); }
    else if (a === '--category') { flags.category = argv[++i]; }
    else if (a.startsWith('--category=')) { flags.category = a.slice(11); }
    else if (a === '--prefix') { flags.prefix = argv[++i]; }
    else if (a.startsWith('--prefix=')) { flags.prefix = a.slice(9); }
    else if (a === '--mirror-plane') { flags.mirrorPlane = true; }
    else if (a === '--risk') { flags.risk = argv[++i]; }
    else if (a.startsWith('--risk=')) { flags.risk = a.slice(7); }
    else if (a === '--limit') { flags.limit = parseInt(argv[++i], 10); }
    else if (a.startsWith('--limit=')) { flags.limit = parseInt(a.slice(8), 10); }
    else if (a === '--input') { flags.input = argv[++i]; }
    else if (a.startsWith('--input=')) { flags.input = a.slice(8); }
    else if (a === '--scope') { flags.scope = argv[++i]; }
    else if (a.startsWith('--scope=')) { flags.scope = a.slice(8); }
    else if (a === '--value') { flags.value = argv[++i]; }
    else if (a.startsWith('--value=')) { flags.value = a.slice(8); }
    else if (a === '--email') { flags.email = argv[++i]; }
    else if (a.startsWith('--email=')) { flags.email = a.slice(8); }
    else if (a === '--method') { flags.method = argv[++i]; }
    else if (a.startsWith('--method=')) { flags.method = a.slice(9); }
    else if (a === '--reason') { flags.reason = argv[++i]; }
    else if (a.startsWith('--reason=')) { flags.reason = a.slice(9); }
    else if (a === '--state') { flags.state = argv[++i]; }
    else if (a.startsWith('--state=')) { flags.state = a.slice(8); }
    else if (a === '--password-stdin') { flags.passwordStdin = true; }
    else if (a === '--yes' || a === '-y') { flags.yes = true; }
    else if (a === '-h' || a === '--help') { flags.help = true; }
    else if (a === '-v' || a === '--version') { flags.version = true; }
    else { positional.push(a); }
  }
  return { positional, flags };
}

// Resolve runtime options for topoRequest from flags + env + registry.
function resolveOpts(flags, registry) {
  let url = flags.url || null;
  // $OMBRAIN_URL counts as an explicit single endpoint only if no --server given.
  if (!url && !flags.server && process.env.OMBRAIN_URL) url = process.env.OMBRAIN_URL;
  return {
    url,
    server: flags.server || null,
    registry,
    timeout: flags.timeout || 30000,
    quiet: !!flags.quiet,
  };
}

// ---------------------------------------------------------------------------
// `ombrain server ...` management subcommands
// ---------------------------------------------------------------------------
async function cmdServer(rest, flags) {
  const sub = rest[0];
  const reg = loadRegistry();

  const findByName = (n) => reg.servers.find((s) => s.name === n);

  switch (sub) {
    case undefined:
    case 'list': {
      const rows = orderedServers(reg).map((s) => ({
        name: s.name,
        role: s.role,
        priority: s.priority || 0,
        endpoint: `${s.scheme || 'http'}://${s.host}`,
        ports: s.ports,
        port_count: portCount(parsePortSpec(s.ports)),
      }));
      emit(flags, { registry: registryPath(false) || '(built-in default)', servers: rows }, formatServerList);
      return;
    }

    case 'add': {
      const [name, host] = rest.slice(1);
      if (!name || !host) die('usage: ombrain server add <name> <host> [--ports 8390] [--role master|backup] [--priority N] [--scheme http|https]');
      if (findByName(name)) die(`server "${name}" already exists (use 'server ports' or 'server remove')`);
      const role = flags.role || 'backup';
      if (role !== 'master' && role !== 'backup') die('--role must be master or backup');
      if (role === 'master') reg.servers.forEach((s) => { if (s.role === 'master') s.role = 'backup'; });
      reg.servers.push({
        name,
        scheme: flags.scheme || 'http',
        host,
        ports: flags.ports || '8390',
        role,
        priority: Number.isFinite(flags.priority) ? flags.priority : (role === 'master' ? 0 : 10),
      });
      const p = saveRegistry(reg);
      out(`added ${role} "${name}" -> ${host} ports ${flags.ports || '8390'}  (registry: ${p})`);
      return;
    }

    case 'set-master': {
      const name = rest[1];
      if (!name) die('usage: ombrain server set-master <name>');
      const target = findByName(name);
      if (!target) die(`no server named "${name}"`);
      reg.servers.forEach((s) => { s.role = (s === target) ? 'master' : 'backup'; });
      target.priority = 0;
      const p = saveRegistry(reg);
      out(`"${name}" is now master  (registry: ${p})`);
      return;
    }

    case 'ports': {
      // ombrain server ports <name> <spec>   — replace the pool
      const [name, spec] = rest.slice(1);
      if (!name || !spec) die('usage: ombrain server ports <name> <8390|8391,8392>');
      const t = findByName(name);
      if (!t) die(`no server named "${name}"`);
      if (portCount(parsePortSpec(spec)) === 0) die(`invalid port spec: ${spec}`);
      t.ports = spec;
      const p = saveRegistry(reg);
      out(`"${name}" ports set to ${spec}  (registry: ${p})`);
      return;
    }

    case 'remove': {
      const name = rest[1];
      if (!name) die('usage: ombrain server remove <name>');
      const before = reg.servers.length;
      reg.servers = reg.servers.filter((s) => s.name !== name);
      if (reg.servers.length === before) die(`no server named "${name}"`);
      const p = saveRegistry(reg);
      out(`removed "${name}"  (registry: ${p})`);
      return;
    }

    case 'status': {
      // Ping a small sample of each server's pool to gauge health without
      // hammering thousands of ports.
      const timeout = flags.timeout || 3000;
      const report = [];
      for (const s of orderedServers(reg)) {
        const segs = parsePortSpec(s.ports);
        const sample = portsToTry(segs, 0, Math.min(5, portCount(segs)));
        let up = 0; const probes = [];
        for (const port of sample) {
          const base = serverBase(s, port);
          try {
            const r = await request('GET', base, '/health', null, timeout);
            const ok = r.status === 200 && r.body && r.body.ok;
            if (ok) up += 1;
            probes.push({ port, ok: !!ok, status: r.status });
          } catch (e) {
            probes.push({ port, ok: false, error: e.message });
          }
        }
        report.push({
          name: s.name, role: s.role, host: s.host, ports: s.ports,
          pool_size: portCount(segs),
          sampled: sample.length, healthy_in_sample: up,
          reachable: up > 0, probes,
        });
      }
      emit(flags, { topology_status: report }, (data) => formatServerStatus(data.topology_status));
      // exit non-zero if the master has no healthy sampled port
      const master = report.find((r) => r.role === 'master');
      if (master && !master.reachable) process.exitCode = 3;
      return;
    }

    default:
      die(`unknown 'server' subcommand: ${sub}\n` +
        'try: list | add | set-master | ports | remove | status');
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  out(`${bold('ombrain')} — command-line client for the om-brain service (v${VERSION})

${yellow('Usage:')}
  ombrain <command> [args...] [global flags]

${yellow('Topology:')}
  Brain API listens on loopback :8390 (local) and nginx LAN edge :8390 on om-dev.
  ombrain talks to a registry of Brain servers (master + optional backups). Each
  host exposes one or more API ports (default 8390). Requests round-robin across
  the master's ports and fail over to backups when unreachable.

${yellow('Global flags:')}
  --url <url>        One explicit endpoint (bypasses the registry / failover)
  --server <name>    Use one named registry server (its pool; no host failover)
  --quiet            Suppress the "[via master: ...]" endpoint note on stderr
  --json             Machine-readable JSON output (default is plain text)
  --session <id>     Session id for ask/session commands
  --mode <mode>      Force a mode for 'ask' (knowledge|technical|ops|...)
  --timeout <ms>     Per-request timeout (default 30000)
  -h, --help / -v, --version

${yellow('Servers:')}
  server list                              Show the registry
  server add <name> <host> [--ports 8390] [--role master|backup]
                                           [--priority N] [--scheme http|https]
  server set-master <name>                 Promote a server to master
  server ports <name> <spec>               Replace a server's port list
  server remove <name>                     Remove a server
  server status                            Probe each server's pool health

${yellow('Core:')}
  status                         Full runtime status (adapters, NATS, ops JWT)
  ask <query...>                 Ask anything; routed by the mode router
  health | ping | classify <query...>

${yellow('Calendar:')}
  pascha <year> | year <year> | feasts <year> | today
  saints <month> <day> [old|new] [year]
  fasting <YYYY-MM-DD> | range <start> <end>

${yellow('Knowledge / church / session:')}
  theology ask <query...> | theology topics | theology sources
  church find <lat> <lng> [miles] | church jurisdictions
  session <id> | modes

${yellow('Actions (OMAI operational bridge):')}
  action|actions list [--source omai] [--category C] [--risk read|low|medium|high]
  action|actions show <action_id>
  action|actions run <action_id> [--input JSON|--file path] [--dry-run] [--commit] [--confirm]
  action|actions resolve <query...>
  action|actions history [--limit N]

${yellow('Draft work items (governance intake):')}
  draft create --title "..." [--description "..."] [--category om-backend]
               [--prefix OMOD|OMAD|OMSD] [--mirror-plane] [--dry-run] [--commit]

${yellow('Skills (executable scripts):')}
  skill|skills list                              List active skills
  skill|skills show <key>                        Show one skill (+ script body)
  skill|skills add --file <path> [--key K]       Register from a script file
                   [--language bash|python|node] [--title T] [--description D]
                   [--tags a,b]  OR  --script '...'
  skill|skills run <key> [--dry-run] [--commit]  Dry-run default; --commit executes

${yellow('Teaching agent (skill/procedure proposals — no execution):')}
  teach-skill --dry-run <proposal.json>   Validate manifest locally (schema + safety)
  teach-skill --submit <proposal.json>    Submit to Brain after validation passes

${yellow('Global settings governance (OM backend — human-approval gated):')}
  settings get <key>                       Read effective value of a setting
  settings set <key> <value> --scope global
                                           Propose a GLOBAL change (NEVER applied
                                           directly; creates an OMBA-#### approval)
  approvals list [--state submitted] [--key K] [--limit N]
  approvals show <OMBA-####>               Full report (old/new, risk, auth state)
  approve <OMBA-####> [--email you@org]    Approve after a FRESH human auth challenge
                     [--method session_reauth|totp|signed_token] [--password-stdin]
  reject  <OMBA-####> [--reason "..."]
    OMBrain facilitates only: it can never apply a global setting itself, and
    can never approve its own proposals. A plaintext "yes" is never accepted.
    Config: OM_SETTINGS_API_BASE (default https://orthodoxmetrics.com),
            OM_SETTINGS_TOKEN (super_admin JWT for transport).

${yellow('OM Docs Pickup — governed internal-doc filing (facilitator; approval-gated):')}
  pickup list [--state all|waiting|...]     List pickup items + filing state
  pickup show <pickup_id>                   Show one pickup item
  pickup file <pickup_id> [--category C]     Request Brain Approval to file into
              [--title T] [--file target/path.md]   docs/internal/ (never files now)
  pickup requests [--state submitted|approved|filed]  List filing requests
  "pickup and file omdocs-pickup <pickup_id>"   Natural-language filing request
    OMBrain facilitates only: a human super_admin must approve in OMStudio before
    a document is placed under docs/internal/. Config: OM_SETTINGS_API_BASE,
    OM_SETTINGS_TOKEN (super_admin JWT for transport).

${yellow('Examples:')}
  ombrain server add master 192.168.1.254 --ports 8390 --role master
  ombrain server add backup1 192.168.1.239 --ports 8390 --role backup
  ombrain status
  ombrain server status
  ombrain pascha 2026
  ombrain ask "what is theosis" --session demo-1
  ombrain --url http://127.0.0.1:8390 health
  ombrain skill add --file ./scripts/hello.sh --key echo-test
  ombrain skills run echo-test --commit
  ombrain actions list
  ombrain actions run omai.system.status
  ombrain draft create --title "Fix session cookie" --category om-auth --commit
  ombrain ask "create a draft work item for OCR column mapping"
`);
}

// ---------------------------------------------------------------------------
// Actions — HTTP client for /brain/actions (OMAI operational bridge)
// ---------------------------------------------------------------------------
async function cmdActions(rest, flags, opts) {
  const sub = rest[0];
  const tail = rest.slice(1);

  const get = async (p, formatter) => {
    const { status, body } = await topoRequest('GET', p, null, opts);
    if (status === 403) die('access denied — insufficient permissions for this action', 2);
    if (status >= 400) die(httpErrorMessage(status, body), 2);
    emit(flags, body, formatter);
  };
  const post = async (p, payload, formatter) => {
    const { status, body } = await topoRequest('POST', p, payload, opts);
    if (status === 403) die('access denied — insufficient permissions for this action', 2);
    if (status === 428) die(`${body && body.message ? body.message : 'confirmation required'} (pass --confirm)`, 2);
    if (status >= 400) die(httpErrorMessage(status, body), 2);
    emit(flags, body, formatter);
  };

  if (sub === 'list' || sub === undefined) {
    const q = qs({ source: flags.source, category: flags.category, risk: flags.risk });
    return get(`/brain/actions${q}`, formatActionsList);
  }

  if (sub === 'show') {
    const id = tail[0];
    if (!id) die('usage: ombrain action show <action_id>');
    return get(`/brain/actions/${encodeURIComponent(id)}`, formatActionDetail);
  }

  if (sub === 'resolve') {
    if (tail.length === 0) die('usage: ombrain action resolve <query...>');
    return post('/brain/actions/resolve', { query: tail.join(' ') }, formatActionResolve);
  }

  if (sub === 'history') {
    const q = qs({ limit: flags.limit });
    return get(`/brain/actions/history${q}`, formatActionHistory);
  }

  if (sub === 'run') {
    const id = tail[0];
    if (!id) die('usage: ombrain action run <action_id> [--input JSON|--file path] [--dry-run|--commit]');
    let input;
    if (flags.input) {
      try { input = JSON.parse(flags.input); }
      catch (e) { die(`invalid --input JSON: ${e.message}`); }
    } else if (flags.file) {
      try { input = JSON.parse(fs.readFileSync(flags.file, 'utf8')); }
      catch (e) { die(`could not read/parse --file ${flags.file}: ${e.message}`); }
    }
    const commit = flags.commit && !flags.dryRun;
    return post(`/brain/actions/${encodeURIComponent(id)}/run`, {
      input,
      commit: !!flags.commit,
      dry_run: flags.dryRun ? true : undefined,
      confirmed: !!flags.confirm,
    }, formatActionRun);
  }

  die(`unknown action subcommand: ${sub}\n` +
    'try: list | show | run | resolve | history');
}

// ---------------------------------------------------------------------------
// Draft — convenience wrapper for omai.work_item.create_draft@v1
// ---------------------------------------------------------------------------
async function cmdDraft(rest, flags, opts) {
  const sub = rest[0];
  const tail = rest.slice(1);

  const post = async (p, payload, formatter) => {
    const { status, body } = await topoRequest('POST', p, payload, opts);
    if (status === 403) die('access denied — insufficient permissions for draft intake', 2);
    if (status === 428) die(`${body && body.message ? body.message : 'confirmation required'} (pass --confirm)`, 2);
    if (status >= 400) die(httpErrorMessage(status, body), 2);
    emit(flags, body, formatter);
  };

  if (sub === 'create') {
    const title = flags.title || (tail.length ? tail.join(' ') : null);
    if (!title) {
      die('usage: ombrain draft create --title "..." [--description "..."] [--category C] ' +
          '[--prefix OMOD|OMAD|OMSD] [--mirror-plane] [--dry-run|--commit]');
    }
    if (!flags.commit && !flags.dryRun) {
      note('hint: pass --commit to create the draft (dry-run is default for writes)');
      flags.dryRun = true;
    }
    const input = {
      title,
      description: flags.description,
      category: flags.category,
      prefix: flags.prefix,
      mirror_plane: !!flags.mirrorPlane,
    };
    return post('/brain/actions/omai.work_item.create_draft@v1/run', {
      input,
      commit: !!flags.commit,
      dry_run: flags.dryRun ? true : undefined,
      confirmed: !!flags.confirm,
    }, formatDraftCreate);
  }

  die(`unknown draft subcommand: ${sub}\ntry: create`);
}

// ---------------------------------------------------------------------------
// Skills — HTTP client for /brain/skills (mirrors bin/om-brain-cli.js skills *)
// ---------------------------------------------------------------------------
async function cmdSkills(rest, flags, opts) {
  const sub = rest[0];
  const tail = rest.slice(1);

  const get = async (p, formatter) => {
    const { status, body } = await topoRequest('GET', p, null, opts);
    if (status >= 400) die(httpErrorMessage(status, body), 2);
    emit(flags, body, formatter);
  };
  const post = async (p, payload, formatter) => {
    const { status, body } = await topoRequest('POST', p, payload, opts);
    if (status >= 400) die(httpErrorMessage(status, body), 2);
    emit(flags, body, formatter);
  };

  if (sub === 'list' || sub === undefined) {
    return get('/brain/skills', formatSkillsList);
  }

  if (sub === 'show') {
    const key = tail[0];
    if (!key) die('usage: ombrain skill show <key>');
    return get(`/brain/skills/${encodeURIComponent(key)}`, formatSkillDetail);
  }

  if (sub === 'add') {
    let script = flags.script;
    if (!script && flags.file) {
      try { script = fs.readFileSync(flags.file, 'utf8'); }
      catch (e) { die(`could not read --file ${flags.file}: ${e.message}`); }
    }
    if (!script) {
      die('usage: ombrain skill add --file <path> [--key K] [--language bash|python|node]\n' +
          '   or: ombrain skill add --script \'...\' --key K --language bash');
    }
    const language = (flags.language || (flags.file ? inferLanguageFromPath(flags.file) : null) || '').toLowerCase();
    if (!language) die('Could not infer language — pass --language bash|python|node');
    const key = flags.key || (flags.file ? path.basename(flags.file, path.extname(flags.file)) : null);
    if (!key) die('--key is required when using --script without --file');
    const tags = flags.tags ? String(flags.tags).split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const payload = {
      key,
      language,
      script,
      title: flags.title,
      description: flags.description,
      tags,
    };
    const { status, body } = await topoRequest('POST', '/brain/skills', payload, opts);
    if (status >= 400) die(httpErrorMessage(status, body), 2);
    if (body && body.warnings && body.warnings.length) {
      note(`warning: ${body.warnings.join(', ')}`);
    }
    if (flags.json) {
      emit(flags, body);
      return;
    }
    out(green(`✓ Skill saved: ${body.skill_key} (${language}) v${body.version || 1}`));
    return;
  }

  if (sub === 'run') {
    const key = tail[0];
    if (!key) die('usage: ombrain skill run <key> [--dry-run|--commit]');
    const execute = flags.commit && !flags.dryRun;
    return post(`/brain/skills/${encodeURIComponent(key)}/run`, { execute }, formatSkillRun);
  }

  die(`unknown skill subcommand: ${sub}\n` +
    'try: list | show | add | run');
}

// ---------------------------------------------------------------------------
// Teaching agent — compile/validate/submit skill proposals (no execution)
// ---------------------------------------------------------------------------
async function cmdTeachSkill(rest, flags, opts) {
  const filePath = flags.file || rest[0];
  if (!filePath) {
    die('usage: ombrain teach-skill --dry-run|--submit <proposal.json>\n' +
        '       ombrain teach-skill --dry-run --file ./examples/skills/read-only-doc-registry-search.json');
  }

  let raw;
  try {
    raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch (e) {
    die(`could not read ${filePath}: ${e.message}`);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    die(`invalid JSON in ${filePath}: ${e.message}`);
  }

  const { processTeachingRequest } = require('../src/agents/teachingAgent');

  if (flags.dryRun || !flags.submit) {
    const result = await processTeachingRequest(input, { dryRun: true, submit: false });
    if (flags.json) {
      emit(flags, result);
      return;
    }
    if (!result.ok) {
      die(`validation failed: ${(result.errors || [result.error]).join(', ')}`, 2);
    }
    out(green('✓ Proposal valid (dry-run)'));
    out(`  name: ${result.manifest && result.manifest.name}`);
    out(`  risk: ${result.manifest && result.manifest.risk_level}`);
    out(`  governance_required: ${result.governance_required}`);
    if (result.warnings && result.warnings.length) {
      note(`warnings: ${result.warnings.join(', ')}`);
    }
    if (!flags.submit) {
      note('pass --submit to register after validation');
    }
    return;
  }

  const preCheck = await processTeachingRequest(input, { dryRun: true, submit: false });
  if (!preCheck.ok) {
    die(`validation failed: ${(preCheck.errors || [preCheck.error]).join(', ')}`, 2);
  }

  const { status, body } = await topoRequest('POST', '/brain/teach/skill-proposal', {
    input,
    submit: true,
  }, opts);

  if (status >= 400) die(httpErrorMessage(status, body), 2);

  if (flags.json) {
    emit(flags, body);
    return;
  }

  out(green(`✓ Teaching proposal submitted: ${body.stored && body.stored.slug}`));
  if (body.governance_required) {
    out(`  governance: ${body.governance && body.governance.submitted ? 'submitted' : 'pending'}`);
    if (body.governance && body.governance.omstudio_ref) {
      out(`  omstudio_ref: ${body.governance.omstudio_ref}`);
    }
  }
  if (body.stored) {
    out(`  approved: ${body.stored.approved}`);
  }
}

// ---------------------------------------------------------------------------
// OM settings-approval governance (facilitator only — never self-approves)
//
// These commands talk to the OM backend settings-approval API, NOT the Brain
// API. OMBrain proposes global settings changes and helps a human super_admin
// approve them with a FRESH auth challenge. OMBrain can never apply a global
// setting directly, and can never approve its own proposals.
// ---------------------------------------------------------------------------
function omApiConfig() {
  const base = (process.env.OM_SETTINGS_API_BASE || process.env.OM_API_BASE_URL || 'https://orthodoxmetrics.com')
    .replace(/\/+$/, '');
  const token = process.env.OM_SETTINGS_TOKEN || process.env.OM_ADMIN_JWT || process.env.BRAIN_OPS_JWT || '';
  return { base, token };
}

function omRequest(method, reqPath, body, timeoutMs) {
  const { base, token } = omApiConfig();
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(base + reqPath); }
    catch (e) { return reject(new Error(`bad URL: ${base + reqPath}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(u, { method, headers, timeout: timeoutMs || 30000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (data) { try { parsed = JSON.parse(data); } catch (_) { parsed = data; } }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

function omDie(status, body) {
  const msg = (body && (body.error || body.message)) || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    die(`${msg}\n${dim('hint: set OM_SETTINGS_TOKEN to a super_admin JWT for the OM backend (transport only; approval still needs a fresh human challenge).')}`, 2);
  }
  die(msg, 2);
}

// Read a line from stdin (visible), used for email / non-secret prompts.
function readLine(promptText) {
  return new Promise((resolve) => {
    process.stderr.write(promptText);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    rl.once('line', (line) => { rl.close(); resolve(line.trim()); });
  });
}

// Read a secret from stdin with echo suppressed (best-effort).
function readSecret(promptText) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(promptText);
    let value = '';
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(value);
      } else if (ch === '\u0003') { // Ctrl-C
        process.stderr.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') { // backspace
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function formatApprovalList(b) {
  const rows = b.approvals || [];
  if (!rows.length) return 'No settings approvals.';
  const lines = [`${bold('Settings approvals')} (${b.total != null ? b.total : rows.length})`, ''];
  for (const a of rows) {
    const st = a.approval_state;
    const color = st === 'applied' ? green : (st === 'rejected' || st === 'failed' || st === 'expired' ? red : yellow);
    lines.push(`  ${cyan(String(a.approval_ref).padEnd(10))} ${color(String(st).padEnd(13))} [${a.risk_level}] ${a.setting_key}`);
    lines.push(`    ${dim(`${a.old_value == null ? '(default)' : a.old_value} -> ${a.proposed_value}  by ${a.requested_by} via ${a.proposal_source}`)}`);
  }
  return lines.join('\n');
}

function formatApproval(b) {
  const a = b.approval || b;
  if (!a || !a.approval_ref) return formatGeneric(b);
  const apps = Array.isArray(a.affected_apps) ? a.affected_apps.join(', ') : (a.affected_apps || '');
  const lines = [
    `${bold(a.approval_ref)}  ${a.approval_state}`,
    `  setting:        ${a.setting_key}`,
    `  scope:          ${a.scope_type}${a.scope_id ? ':' + a.scope_id : ''}`,
    `  old value:      ${a.old_value == null ? '(default)' : a.old_value}`,
    `  new value:      ${a.proposed_value}`,
    `  affected apps:  ${apps}`,
    `  risk level:     ${a.risk_level}`,
    `  classification: ${a.classification}`,
    `  auth required:  ${a.auth_required ? 'yes' : 'no'}`,
    `  proposed by:    ${a.requested_by} (source: ${a.proposal_source})`,
  ];
  if (a.auth_verified_by) lines.push(`  authenticated:  ${a.auth_verified_by} via ${a.auth_method} at ${a.auth_verified_at}`);
  if (a.approved_by) lines.push(`  approved by:    ${green(a.approved_by)} at ${a.approved_at}`);
  if (a.applied_at) lines.push(`  applied at:     ${a.applied_at}`);
  if (a.rejected_by) lines.push(`  rejected by:    ${red(a.rejected_by)}${a.rejection_reason ? ' — ' + a.rejection_reason : ''}`);
  if (a.apply_error) lines.push(`  apply error:    ${red(a.apply_error)}`);
  if (a.omstudio_ref) lines.push(`  omstudio ref:   ${a.omstudio_ref}`);
  return lines.join('\n');
}

async function cmdSettings(rest, flags) {
  const sub = rest[0];
  if (sub === 'get') {
    const key = rest[1] || flags.key;
    if (!key) die('usage: ombrain settings get <key>');
    const { status, body } = await omRequest('GET', `/api/admin/settings/value${qs({ key })}`);
    if (status >= 400) return omDie(status, body);
    emit(flags, body, (b) => `${b.key} = ${b.value == null ? '(unset/default)' : b.value}`);
    return;
  }

  if (sub === 'set') {
    const key = rest[1];
    const value = rest[2] !== undefined ? rest[2] : flags.value;
    if (!key || value === undefined) die('usage: ombrain settings set <key> <value> --scope global');
    const scope = flags.scope || 'global';
    if (scope !== 'global') {
      die('ombrain only facilitates GLOBAL settings via approval gating. Use the OM admin UI for church-scoped overrides.');
    }
    const { status, body } = await omRequest('POST', '/api/admin/settings/approvals', {
      key, value, requested_by: 'ombrain', proposal_source: 'ombrain',
    });
    if (status >= 400) return omDie(status, body);
    const a = body.approval || {};
    if (flags.json) { emit(flags, body); return; }
    out(yellow('Global setting change requires human authentication — NOT applied.'));
    out('');
    out(formatApproval({ approval: a }));
    out('');
    out(`Created ${bold(a.approval_ref)}. To approve you must authenticate as a super_admin:`);
    out(`  ${cyan(`ombrain approve ${a.approval_ref}`)}`);
    out(dim('  (or approve in the OMStudio Brain Approvals UI). A plaintext "yes" is not accepted.'));
    return;
  }

  die('usage: ombrain settings <get|set>\n' +
      '  ombrain settings get <key>\n' +
      '  ombrain settings set <key> <value> --scope global');
}

async function cmdApprovals(rest, flags) {
  const sub = rest[0];
  if (sub === 'list' || sub === undefined) {
    const { status, body } = await omRequest('GET', `/api/admin/settings/approvals${qs({ state: flags.state, key: flags.key, limit: flags.limit })}`);
    if (status >= 400) return omDie(status, body);
    emit(flags, body, formatApprovalList);
    return;
  }
  if (sub === 'show') {
    const ref = rest[1];
    if (!ref) die('usage: ombrain approvals show <OMBA-####>');
    const { status, body } = await omRequest('GET', `/api/admin/settings/approvals/${encodeURIComponent(ref)}`);
    if (status >= 400) return omDie(status, body);
    emit(flags, body, formatApproval);
    return;
  }
  die('usage: ombrain approvals <list|show>');
}

async function cmdApprove(rest, flags) {
  const ref = rest[0];
  if (!ref) die('usage: ombrain approve <OMBA-####> [--email you@org] [--method session_reauth]');
  if (flags.yes) {
    note('a plaintext confirmation is NOT sufficient to approve a global setting; a fresh human auth challenge is required.');
  }

  // 1-2. Load approval + confirm it is pending.
  const showRes = await omRequest('GET', `/api/admin/settings/approvals/${encodeURIComponent(ref)}`);
  if (showRes.status >= 400) return omDie(showRes.status, showRes.body);
  const approval = showRes.body.approval;
  if (!approval) die(`approval ${ref} not found`, 2);
  if (['approved', 'applied', 'rejected', 'expired', 'failed'].includes(approval.approval_state)) {
    die(`approval ${ref} is ${approval.approval_state}; cannot approve`, 2);
  }
  out(formatApproval({ approval }));
  out('');

  // 4. Issue a FRESH auth challenge.
  const method = flags.method || 'session_reauth';
  const chRes = await omRequest('POST', `/api/admin/settings/approvals/${encodeURIComponent(ref)}/challenge`, { method });
  if (chRes.status >= 400) return omDie(chRes.status, chRes.body);
  const challenge = chRes.body.challenge;
  note(`auth challenge issued (${challenge.method}); expires ${challenge.expires_at}`);

  // Gather the fresh human credential for the challenge.
  let response = {};
  if (method === 'session_reauth') {
    const email = flags.email || await readLine('super_admin email: ');
    let password;
    if (flags.passwordStdin) {
      password = require('fs').readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    } else {
      password = await readSecret('super_admin password: ');
    }
    if (!email || !password) die('email and password are required (plaintext confirmation is not accepted)', 2);
    response = { email, password };
  } else if (method === 'totp') {
    const email = flags.email || await readLine('super_admin email: ');
    const code = await readLine('TOTP code: ');
    response = { email, token: code };
  } else if (method === 'signed_token') {
    const token = await readSecret('OMStudio signed approval token: ');
    response = { token };
  } else {
    die(`unsupported auth method: ${method}`, 2);
  }

  // 5-9. Verify + apply on the server; OMBrain never applies locally.
  const apRes = await omRequest('POST', `/api/admin/settings/approvals/${encodeURIComponent(ref)}/approve`, {
    challenge_id: challenge.challenge_id,
    response,
  });
  if (apRes.status >= 400) return omDie(apRes.status, apRes.body);
  if (flags.json) { emit(flags, apRes.body); return; }
  const a = apRes.body.approval || {};
  out(green(`✓ ${ref} approved and applied by ${a.approved_by}`));
  out(`  ${a.setting_key} = ${apRes.body.effective_value}`);
}

// ---------------------------------------------------------------------------
// OM Docs Pickup — governed internal-documentation filing (facilitator only)
//
// OMBrain can request/track/explain filing and, AFTER a human super_admin
// approves in OMStudio, trigger the deterministic file. It can NEVER
// self-authorize placement of a document under docs/internal/.
// ---------------------------------------------------------------------------
function formatPickupFile(b) {
  const f = (b && b.file) || b;
  if (!f || !f.id) return formatGeneric(b);
  const lines = [
    `${bold(f.pickupId || f.id)}  ${f.filingState || 'none'}`,
    `  title:       ${f.title || f.originalName}`,
    `  file:        ${f.originalName}`,
    `  status:      ${f.status}`,
  ];
  if (f.proposedCategory) lines.push(`  category:    ${f.proposedCategory}`);
  if (f.proposedTargetDocsPath) lines.push(`  target:      ${f.proposedTargetDocsPath}`);
  if (f.filingReceipt) lines.push(`  receipt:     ${f.filingReceipt}`);
  if (f.filedDocsPath) lines.push(`  filed at:    ${f.filedDocsPath}`);
  return lines.join('\n');
}

function formatFilingRequest(b) {
  const r = (b && b.request) || b;
  if (!r || !r.receipt) return formatGeneric(b);
  const lines = [
    `${bold(r.receipt)}  ${r.status}`,
    `  pickup id:   ${r.pickupId}`,
    `  document:    ${r.title || r.sourceFilename}`,
    `  target path: ${r.proposedTargetPath}`,
    `  category:    ${r.categoryLabel || r.category}`,
    `  visibility:  ${r.visibility}`,
    `  requested:   ${r.requestingActor} (via ${r.requestSource})`,
  ];
  if (r.omstudioRef) lines.push(`  omstudio:    ${r.omstudioRef}`);
  if (r.approvedBy) lines.push(`  approved by: ${green(r.approvedBy)} at ${r.approvedAt}`);
  if (r.rejectedBy) lines.push(`  rejected by: ${red(r.rejectedBy)}${r.decisionNote ? ' — ' + r.decisionNote : ''}`);
  if (r.filedDocsPath) lines.push(`  filed:       ${green(r.filedDocsPath)}`);
  return lines.join('\n');
}

async function cmdPickup(rest, flags) {
  const sub = rest[0];

  if (sub === 'list') {
    const { status, body } = await omRequest('GET', `/api/docs-pickup/list${qs({ tab: flags.state || 'all' })}`);
    if (status >= 400) return omDie(status, body);
    const files = (body.data && body.data.files) || body.files || [];
    if (flags.json) { emit(flags, { files }); return; }
    if (!files.length) { out('No pickup items.'); return; }
    out(`${bold('Pickup items')} (${files.length})\n`);
    for (const f of files) {
      out(`  ${cyan(String(f.pickupId || f.id).padEnd(28))} ${String(f.filingState || 'none').padEnd(24)} ${f.title || f.originalName}`);
    }
    return;
  }

  if (sub === 'show') {
    const id = rest[1] || flags.key;
    if (!id) die('usage: ombrain pickup show <pickup_id>');
    const { status, body } = await omRequest('GET', `/api/docs-pickup/pickup/${encodeURIComponent(id)}`);
    if (status >= 400) return omDie(status, body);
    emit(flags, (body.data || body), formatPickupFile);
    return;
  }

  if (sub === 'file' || sub === 'request') {
    const id = rest[1] || flags.key;
    if (!id) die('usage: ombrain pickup file <pickup_id> [--category "Architecture"] [--target docs/internal/...] [--title "..."]');
    const payload = {
      category: flags.category,
      visibility: flags.value || 'internal',
      targetPath: flags.file, // reuse --file as target path override, optional
      title: flags.title,
      requestSource: 'ombrain_cli',
      requestingActor: flags.email || 'ombrain',
    };
    const { status, body } = await omRequest('POST', `/api/docs-pickup/${encodeURIComponent(id)}/request-filing`, payload);
    if (status >= 400) return omDie(status, body);
    const data = body.data || body;
    if (flags.json) { emit(flags, data); return; }
    const r = data.request || {};
    out(yellow('Internal documentation filing requires human super_admin approval — NOT filed.'));
    out('');
    out(formatFilingRequest({ request: r }));
    out('');
    out(`Created receipt ${bold(r.receipt)}. A human super_admin must approve it in the`);
    out('OMStudio Brain Approvals surface (or OM Docs Pickup) before it can be filed.');
    out(dim('OMBrain facilitates only — it cannot self-authorize placement under docs/internal/.'));
    return;
  }

  if (sub === 'requests') {
    const { status, body } = await omRequest('GET', `/api/docs-pickup/filing/requests${qs({ status: flags.state, limit: flags.limit })}`);
    if (status >= 400) return omDie(status, body);
    const requests = (body.data && body.data.requests) || body.requests || [];
    if (flags.json) { emit(flags, { requests }); return; }
    if (!requests.length) { out('No filing requests.'); return; }
    out(`${bold('Filing requests')} (${requests.length})\n`);
    for (const r of requests) {
      out(`  ${cyan(String(r.receipt).padEnd(10))} ${String(r.status).padEnd(10)} ${r.pickupId}  ${r.proposedTargetPath}`);
    }
    return;
  }

  die('usage: ombrain pickup <list|show|file|requests>\n'
    + '  ombrain pickup file <pickup_id> [--category "Architecture"]\n'
    + "  ombrain \"pickup and file omdocs-pickup <pickup_id>\"");
}

async function cmdReject(rest, flags) {
  const ref = rest[0];
  if (!ref) die('usage: ombrain reject <OMBA-####> [--reason "..."]');
  const { status, body } = await omRequest('POST', `/api/admin/settings/approvals/${encodeURIComponent(ref)}/reject`, {
    reason: flags.reason || null,
  });
  if (status >= 400) return omDie(status, body);
  if (flags.json) { emit(flags, body); return; }
  out(red(`✗ ${ref} rejected`));
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) { out(`ombrain ${VERSION}`); return; }
  if (flags.help || positional.length === 0) { printHelp(); return; }

  const cmd = positional[0];
  const rest = positional.slice(1);

  // Natural-language docs-filing form:
  //   ombrain "pickup and file omdocs-pickup <pickup_id>"
  // (arrives as a single positional, or as multiple space-split tokens).
  const joined = positional.join(' ');
  const nlFile = joined.match(/pickup\s+and\s+file\s+omdocs-pickup\s+(\S+)/i);
  if (nlFile) {
    return cmdPickup(['file', nlFile[1]], flags);
  }

  // pickup — OM Docs Pickup governed filing (facilitator; talks to OM backend).
  if (cmd === 'pickup') return cmdPickup(rest, flags);

  // Registry management is handled before any network resolution.
  if (cmd === 'server') return cmdServer(rest, flags);

  // settings-approval governance — talks to the OM backend, not the Brain API.
  if (cmd === 'settings') return cmdSettings(rest, flags);
  if (cmd === 'approvals') return cmdApprovals(rest, flags);
  if (cmd === 'approve') return cmdApprove(rest, flags);
  if (cmd === 'reject') return cmdReject(rest, flags);

  // skill / skills — executable script registry (singular alias supported)
  if (cmd === 'skill' || cmd === 'skills') {
    const registry = loadRegistry();
    const opts = resolveOpts(flags, registry);
    return cmdSkills(rest, flags, opts);
  }

  // action / actions — OMAI operational bridge (separate from skills)
  if (cmd === 'action' || cmd === 'actions') {
    const registry = loadRegistry();
    const opts = resolveOpts(flags, registry);
    return cmdActions(rest, flags, opts);
  }

  // draft — governance intake wrapper
  if (cmd === 'draft') {
    const registry = loadRegistry();
    const opts = resolveOpts(flags, registry);
    return cmdDraft(rest, flags, opts);
  }

  // teach-skill — teaching agent proposal compiler
  if (cmd === 'teach-skill') {
    const registry = loadRegistry();
    const opts = resolveOpts(flags, registry);
    return cmdTeachSkill(rest, flags, opts);
  }

  const registry = loadRegistry();
  const opts = resolveOpts(flags, registry);

  // GET/POST helpers that go through the topology-aware request layer.
  const get = async (p, formatter) => {
    const { status, body } = await topoRequest('GET', p, null, opts);
    if (status >= 400) die(`${status} ${(body && body.error) || ''} ${(body && body.hint) ? '(' + body.hint + ')' : ''}`.trim(), 2);
    emit(flags, body, formatter);
  };
  const post = async (p, payload, formatter) => {
    const { status, body } = await topoRequest('POST', p, payload, opts);
    if (status >= 400) die(`${status} ${(body && body.error) || ''} ${(body && body.hint) ? '(' + body.hint + ')' : ''}`.trim(), 2);
    emit(flags, body, formatter);
  };

  try {
    switch (cmd) {
      case 'health':
        return await get('/health', formatHealth);

      case 'status': {
        const { status, body } = await topoRequest('GET', '/status', null, opts);
        if (status >= 400) die(`${status} ${(body && body.error) || ''} ${(body && body.hint) ? '(' + body.hint + ')' : ''}`.trim(), 2);
        emit(flags, body, formatStatus);
        if (!flags.json) {
          const hint = opsAuthExitHint(body);
          if (hint === 2) note('ops auth: expired or invalid — re-provision with provision-brain-ingest.sh --update-auth01');
          else if (hint === 1) note('ops auth: expires within 14 days — schedule JWT rotation');
          process.exitCode = hint || 0;
        }
        return;
      }

      case 'ping': {
        const { status, body, endpoint } = await topoRequest('GET', '/health', null, { ...opts, quiet: true });
        if (status === 200 && body && body.ok) { out(green(`ok  ${endpoint}`)); return; }
        die(`unhealthy (${status}) ${endpoint}`, 2);
        return;
      }

      case 'ask': {
        if (rest.length === 0) die('usage: ombrain ask <query...>');
        return await post('/brain/ask', {
          query: rest.join(' '),
          session_id: flags.session,
          force_mode: flags.mode,
        }, formatAsk);
      }

      case 'classify': {
        if (rest.length === 0) die('usage: ombrain classify <query...>');
        const { status, body } = await topoRequest('POST', '/brain/ask',
          { query: rest.join(' '), session_id: flags.session }, opts);
        if (status >= 400) die(`${status} ${(body && body.error) || ''}`.trim(), 2);
        emit(flags, { query: rest.join(' '), mode: body && body.mode, detail_type: body && body.detail && body.detail.type }, formatClassify);
        return;
      }

      case 'modes':
        return await get('/brain/modes', formatModes);

      // ---- Calendar ----
      case 'pascha':
        if (!rest[0]) die('usage: ombrain pascha <year>');
        return await get(`/brain/calendar/pascha/${encodeURIComponent(rest[0])}`, formatPascha);
      case 'year':
        if (!rest[0]) die('usage: ombrain year <year>');
        return await get(`/brain/calendar/year/${encodeURIComponent(rest[0])}`, formatYear);
      case 'feasts':
        if (!rest[0]) die('usage: ombrain feasts <year>');
        return await get(`/brain/calendar/feasts/${encodeURIComponent(rest[0])}`, formatFeasts);
      case 'today':
        return await get('/brain/calendar/today', formatToday);
      case 'saints': {
        const [month, day, calendar, year] = rest;
        if (!month || !day) die('usage: ombrain saints <month> <day> [old|new] [year]');
        return await get('/brain/calendar/saints' + qs({
          month, day, calendar: calendar || 'old', year: year || new Date().getUTCFullYear(),
        }), formatSaints);
      }
      case 'fasting':
        if (!rest[0]) die('usage: ombrain fasting <YYYY-MM-DD>');
        return await get('/brain/calendar/fasting' + qs({ date: rest[0] }), formatFasting);
      case 'range': {
        const [start, end] = rest;
        if (!start || !end) die('usage: ombrain range <start YYYY-MM-DD> <end YYYY-MM-DD>');
        return await get('/brain/calendar/range' + qs({ start, end }), formatRange);
      }

      // ---- Theology ----
      case 'theology': {
        const sub = rest[0];
        if (sub === 'ask') {
          if (rest.length < 2) die('usage: ombrain theology ask <query...>');
          return await post('/brain/theology/ask', { query: rest.slice(1).join(' ') }, formatAsk);
        }
        if (sub === 'topics') return await get('/brain/theology/topics');
        if (sub === 'sources') return await get('/brain/theology/sources');
        die('usage: ombrain theology <ask|topics|sources>');
        return;
      }

      // ---- Church ----
      case 'church': {
        const sub = rest[0];
        if (sub === 'find') {
          const [lat, lng, miles] = rest.slice(1);
          if (!lat || !lng) die('usage: ombrain church find <lat> <lng> [miles]');
          return await post('/brain/churches/find', {
            lat: Number(lat), lng: Number(lng),
            radius_miles: miles ? Number(miles) : undefined,
          }, formatChurchFind);
        }
        if (sub === 'jurisdictions') return await get('/brain/churches/jurisdictions');
        die('usage: ombrain church <find|jurisdictions>');
        return;
      }

      // ---- Session ----
      case 'session':
        if (!rest[0]) die('usage: ombrain session <id>');
        return await get(`/brain/session/${encodeURIComponent(rest[0])}`);

      default:
        die(`unknown command: ${cmd}\nRun ${cyan('ombrain --help')} for usage.`);
    }
  } catch (e) {
    if (e && (e.allUnreachable || UNREACHABLE.test(String(e.message)))) {
      die(`${e.message}\n` +
        dim('hint: check `ombrain server status`; ensure the Brain pool is up and reachable, ' +
            'or use --url / an SSH tunnel from other machines.'), 3);
    }
    die(e && e.message ? e.message : String(e));
  }
}

main();
