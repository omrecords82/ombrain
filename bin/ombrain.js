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
 * Base URL resolution (first match wins):
 *   1. --url <url> flag
 *   2. $OMBRAIN_URL environment variable
 *   3. http://127.0.0.1:8390   (the service default; loopback on the Brain host)
 *
 * Install system-wide with: om-brain/deploy/install-ombrain.sh
 *
 * Zero runtime dependencies — uses only Node's built-in http/https.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_URL = 'http://127.0.0.1:8390';
const VERSION = '1.0.0';

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

function out(obj) {
  if (typeof obj === 'string') {
    process.stdout.write(obj + '\n');
  } else {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Argument parsing — pull global flags out of argv, keep positionals in order
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') { flags.url = argv[++i]; }
    else if (a.startsWith('--url=')) { flags.url = a.slice(6); }
    else if (a === '--json') { flags.json = true; }
    else if (a === '--raw') { flags.raw = true; }
    else if (a === '--timeout') { flags.timeout = parseInt(argv[++i], 10); }
    else if (a === '--session') { flags.session = argv[++i]; }
    else if (a === '--mode') { flags.mode = argv[++i]; }
    else if (a === '-h' || a === '--help') { flags.help = true; }
    else if (a === '-v' || a === '--version') { flags.version = true; }
    else { positional.push(a); }
  }
  return { positional, flags };
}

function resolveBaseUrl(flags) {
  const raw = flags.url || process.env.OMBRAIN_URL || DEFAULT_URL;
  try {
    // Validate; throws on garbage.
    // eslint-disable-next-line no-new
    new URL(raw);
    return raw.replace(/\/+$/, '');
  } catch (_) {
    die(`invalid base URL: ${raw}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP request (built-in, promise-wrapped)
// ---------------------------------------------------------------------------
function request(method, baseUrl, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(baseUrl + path);
    } catch (e) {
      return reject(new Error(`bad URL: ${baseUrl + path}`));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(
      u,
      { method, headers, timeout: timeoutMs || 30000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          if (data) {
            try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
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
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  out(`${bold('ombrain')} — command-line client for the om-brain service (v${VERSION})

${yellow('Usage:')}
  ombrain <command> [args...] [global flags]

${yellow('Global flags:')}
  --url <url>        Brain base URL (default: $OMBRAIN_URL or ${DEFAULT_URL})
  --session <id>     Session id for ask/session commands
  --mode <mode>      Force a mode for 'ask' (knowledge|technical|ops|...)
  --json             Always print raw JSON (default for most commands)
  --timeout <ms>     Request timeout in milliseconds (default 30000)
  -h, --help         Show this help
  -v, --version      Show version

${yellow('Core:')}
  ask <query...>                 Ask anything; routed by the mode router
  health                         Service health check
  ping                           Same as health, exit 0/1 for scripts

${yellow('Calendar:')}
  pascha <year>                  Pascha date for a year
  year <year>                    Full year record (Orthodox + Western Easter, feasts, fasting)
  feasts <year>                  Moveable feasts for a year
  today                          Today's season, fasting rule, and saints
  saints <month> <day> [old|new] [year]   Saints for a date (default calendar: old)
  fasting <YYYY-MM-DD>           Fasting rule for a date
  range <start> <end>            Per-day fasting + saints across a date range

${yellow('Knowledge / theology / church:')}
  theology ask <query...>        Ask the theology layer
  theology topics                List theology topics
  theology sources               Corpus provenance
  church find <lat> <lng> [miles]   Find nearby Orthodox churches
  church jurisdictions           List jurisdictions

${yellow('Session / modes:')}
  session <id>                   Session summary (decisions + BTW history)
  modes                          List the communication modes
  classify <query...>            Show which mode a query would route to (no answer)

${yellow('Examples:')}
  ombrain pascha 2026
  ombrain saints 12 6 old 2026
  ombrain ask "what is theosis" --session demo-1
  ombrain --url http://10.0.0.254:8390 health
  OMBRAIN_URL=http://127.0.0.1:8390 ombrain today
`);
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) { out(`ombrain ${VERSION}`); return; }
  if (flags.help || positional.length === 0) { printHelp(); return; }

  const base = resolveBaseUrl(flags);
  const timeout = flags.timeout || 30000;
  const cmd = positional[0];
  const rest = positional.slice(1);

  // Helper: GET and print, surfacing non-2xx as errors.
  const get = async (path) => {
    const { status, body } = await request('GET', base, path, null, timeout);
    if (status >= 400) die(`${status} ${(body && body.error) || ''} ${(body && body.hint) ? '(' + body.hint + ')' : ''}`.trim(), 2);
    out(body);
  };
  const post = async (path, payload) => {
    const { status, body } = await request('POST', base, path, payload, timeout);
    if (status >= 400) die(`${status} ${(body && body.error) || ''} ${(body && body.hint) ? '(' + body.hint + ')' : ''}`.trim(), 2);
    out(body);
  };

  try {
    switch (cmd) {
      case 'health':
        return await get('/health');

      case 'ping': {
        const { status, body } = await request('GET', base, '/health', null, timeout);
        if (status === 200 && body && body.ok) { out(green(`ok  ${base}`)); return; }
        die(`unhealthy (${status}) ${base}`, 2);
        return;
      }

      case 'ask': {
        if (rest.length === 0) die('usage: ombrain ask <query...>');
        return await post('/brain/ask', {
          query: rest.join(' '),
          session_id: flags.session,
          force_mode: flags.mode,
        });
      }

      case 'classify': {
        if (rest.length === 0) die('usage: ombrain classify <query...>');
        // Force-mode-free ask with a hint isn't available server-side as a pure
        // classifier route, so we ask and report just the routed mode.
        const { status, body } = await request('POST', base, '/brain/ask',
          { query: rest.join(' '), session_id: flags.session }, timeout);
        if (status >= 400) die(`${status} ${(body && body.error) || ''}`.trim(), 2);
        out({ query: rest.join(' '), mode: body && body.mode, detail_type: body && body.detail && body.detail.type });
        return;
      }

      case 'modes':
        return await get('/brain/modes').catch(async () => {
          // Fallback: some builds expose modes only via the router; print the canonical three.
          out([
            { id: 'knowledge', label: 'Knowledge' },
            { id: 'technical', label: 'Technical' },
            { id: 'ops', label: 'Operations' },
          ]);
        });

      // ---- Calendar ----
      case 'pascha':
        if (!rest[0]) die('usage: ombrain pascha <year>');
        return await get(`/brain/calendar/pascha/${encodeURIComponent(rest[0])}`);

      case 'year':
        if (!rest[0]) die('usage: ombrain year <year>');
        return await get(`/brain/calendar/year/${encodeURIComponent(rest[0])}`);

      case 'feasts':
        if (!rest[0]) die('usage: ombrain feasts <year>');
        return await get(`/brain/calendar/feasts/${encodeURIComponent(rest[0])}`);

      case 'today':
        return await get('/brain/calendar/today');

      case 'saints': {
        const [month, day, calendar, year] = rest;
        if (!month || !day) die('usage: ombrain saints <month> <day> [old|new] [year]');
        return await get('/brain/calendar/saints' + qs({
          month, day,
          calendar: calendar || 'old',
          year: year || new Date().getUTCFullYear(),
        }));
      }

      case 'fasting':
        if (!rest[0]) die('usage: ombrain fasting <YYYY-MM-DD>');
        return await get('/brain/calendar/fasting' + qs({ date: rest[0] }));

      case 'range': {
        const [start, end] = rest;
        if (!start || !end) die('usage: ombrain range <start YYYY-MM-DD> <end YYYY-MM-DD>');
        return await get('/brain/calendar/range' + qs({ start, end }));
      }

      // ---- Theology ----
      case 'theology': {
        const sub = rest[0];
        if (sub === 'ask') {
          if (rest.length < 2) die('usage: ombrain theology ask <query...>');
          return await post('/brain/theology/ask', { query: rest.slice(1).join(' ') });
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
          });
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
    if (e && /ECONNREFUSED|timed out|ENOTFOUND|EHOSTUNREACH/i.test(String(e.message))) {
      die(`cannot reach Brain at ${base} — ${e.message}\n` +
        dim('hint: the service binds to 127.0.0.1:8390 on the Brain host; use --url or an SSH tunnel from other machines.'), 3);
    }
    die(e && e.message ? e.message : String(e));
  }
}

main();
