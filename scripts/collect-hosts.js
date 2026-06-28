'use strict';

/**
 * collect-hosts — passive DNS + TCP reachability verifier for declared hosts.
 *
 * Reads om-brain/inventory/hosts.json (declared truth), resolves each hostname
 * via DNS, probes key_ports with TCP connect only. No logins, no credentialed
 * probes, no secrets in output.
 *
 * Writes om-brain/inventory/HOST-SNAPSHOT.md (committed snapshot for agents).
 *
 * Usage:
 *   node scripts/collect-hosts.js [--hosts <path>] [--out <path>] [--timeout-ms <n>]
 *
 * Recommended run host: om-dev (.254) on the LAN.
 */

const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_HOSTS = path.join(ROOT, 'inventory', 'hosts.json');
const DEFAULT_OUT = path.join(ROOT, 'inventory', 'HOST-SNAPSHOT.md');
const DEFAULT_TIMEOUT_MS = 3000;

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    hostsPath: DEFAULT_HOSTS,
    outPath: DEFAULT_OUT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hosts' && argv[i + 1]) opts.hostsPath = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) opts.outPath = argv[++i];
    else if (argv[i] === '--timeout-ms' && argv[i + 1]) {
      opts.timeoutMs = Number(argv[++i]);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(
        'Usage: node scripts/collect-hosts.js [--hosts <path>] [--out <path>] [--timeout-ms <n>]\n',
      );
      process.exit(0);
    }
  }
  if (!path.isAbsolute(opts.hostsPath)) {
    opts.hostsPath = path.resolve(ROOT, opts.hostsPath);
  }
  if (!path.isAbsolute(opts.outPath)) {
    opts.outPath = path.resolve(ROOT, opts.outPath);
  }
  return opts;
}

function fqdn(name, domain) {
  if (!name || name.includes('.')) return name;
  return `${name}.${domain}`;
}

async function resolveHostnames(names, domain) {
  const results = [];
  for (const raw of names) {
    const label = raw.trim();
    if (!label) continue;
    const candidates = label.includes('.')
      ? [label]
      : [label, fqdn(label, domain)];
    let lastErr = null;
    for (const host of candidates) {
      try {
        const res = await dns.lookup(host, { family: 4 });
        results.push({ query: host, address: res.address });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      results.push({ query: candidates[candidates.length - 1], error: lastErr.code || lastErr.message });
    }
  }
  return results;
}

function runnerIsHost(host, runnerHostname) {
  const hn = String(runnerHostname || '').toLowerCase();
  const labels = [host.name, ...(host.aliases || [])].map((n) => n.toLowerCase());
  if (labels.some((n) => hn === n || hn.startsWith(`${n}.`))) return true;
  if (host.name === 'om-dev' && (hn.includes('omdev') || hn.includes('om-dev'))) return true;
  return false;
}

async function probePort(hostIp, port, timeoutMs, tryLocalhost) {
  if (await tcpReachable(hostIp, port, timeoutMs)) return true;
  if (tryLocalhost && hostIp !== '127.0.0.1') {
    return tcpReachable('127.0.0.1', port, timeoutMs);
  }
  return false;
}

function tcpReachable(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

function declaredIps(host) {
  const ips = [host.ip];
  if (Array.isArray(host.secondary_ips)) ips.push(...host.secondary_ips);
  return [...new Set(ips.filter(Boolean))];
}

function dnsDrift(declared, resolvedAddresses, declaredPrimary) {
  if (!resolvedAddresses.length) return { drift: 'dns_unresolved', note: null };
  const ok = resolvedAddresses.some((a) => declared.includes(a));
  if (!ok) return { drift: 'mismatch', note: null };
  const loopbackOnly = resolvedAddresses.filter(
    (a) => a.startsWith('127.') && !declared.includes(a),
  );
  if (
    loopbackOnly.length &&
    declaredPrimary &&
    !String(declaredPrimary).startsWith('127.')
  ) {
    return {
      drift: 'match',
      note: `local loopback resolution (${loopbackOnly.join(', ')}) — LAN A-record also present via alias`,
    };
  }
  return { drift: 'match', note: null };
}

async function verifyHost(host, domain, timeoutMs, runnerHostname) {
  const verifiedAt = new Date().toISOString();
  const declared = declaredIps(host);
  const lookupNames = [host.name, ...(host.aliases || [])];
  const dnsResults = await resolveHostnames(lookupNames, domain);
  const resolvedAddresses = [...new Set(dnsResults.filter((r) => r.address).map((r) => r.address))];
  const { drift, note } = dnsDrift(declared, resolvedAddresses, host.ip);

  const ports = host.key_ports || [];
  const portResults = [];
  const tryLocalhost = runnerIsHost(host, runnerHostname);
  for (const port of ports) {
    const reachable = await probePort(host.ip, port, timeoutMs, tryLocalhost);
    portResults.push({
      port,
      status: reachable ? 'reachable' : 'unreachable',
      verified_at: verifiedAt,
    });
  }

  return {
    name: host.name,
    declared_ip: host.ip,
    declared_ips: declared,
    role: host.role,
    dns: dnsResults,
    dns_drift: drift,
    dns_note: note,
    ports: portResults,
    verified_at: verifiedAt,
  };
}

function formatDnsCell(dnsResults) {
  if (!dnsResults.length) return '—';
  return dnsResults
    .map((r) => {
      if (r.address) return `\`${r.query}\` → \`${r.address}\``;
      return `\`${r.query}\` → _${r.error}_`;
    })
    .join('<br>');
}

function formatPortsCell(ports) {
  if (!ports.length) return '— (no probes)';
  return ports.map((p) => `\`:${p.port}\` ${p.status}`).join('<br>');
}

function buildMarkdown(inventory, results, opts) {
  const generatedAt = new Date().toISOString();
  const hostname = (() => {
    try {
      return require('os').hostname();
    } catch (_) {
      return 'unknown';
    }
  })();

  const lines = [];
  lines.push('# om.internal Host Snapshot');
  lines.push('');
  lines.push(
    '> Auto-generated by `node om-brain/scripts/collect-hosts.js`. **Do not edit manually.**',
  );
  lines.push(`> Generated: ${generatedAt}`);
  lines.push(`> Probe runner: \`${hostname}\``);
  lines.push(`> Declared source: \`om-brain/inventory/hosts.json\` (schema v${inventory.schema_version})`);
  lines.push('');
  lines.push(
    'Agents: **read this file at session start** for authoritative host facts plus last-known reachability.',
  );
  lines.push('Canonical coordination map: `docs/coordination/README-CURSOR.md`.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Property | Value |');
  lines.push('|----------|-------|');
  lines.push(`| Domain | \`${inventory.domain}\` |`);
  lines.push(`| Hosts declared | ${inventory.hosts.length} |`);
  lines.push(`| DNS drift (mismatch / unresolved) | ${results.filter((r) => r.dns_drift !== 'match').length} |`);
  lines.push(`| TCP timeout | ${opts.timeoutMs} ms |`);
  lines.push('');
  lines.push('## Hosts');
  lines.push('');
  lines.push(
    '| Name | Declared IP | Role | DNS | Ports | Drift |',
  );
  lines.push(
    '|------|-------------|------|-----|-------|-------|',
  );

  for (const r of results) {
    let driftBadge =
      r.dns_drift === 'match'
        ? 'match'
        : r.dns_drift === 'mismatch'
          ? '**mismatch**'
          : 'dns_unresolved';
    if (r.dns_note) driftBadge += ` _(info: ${r.dns_note})_`;
    lines.push(
      `| ${r.name} | \`${r.declared_ip}\` | ${r.role || '—'} | ${formatDnsCell(r.dns)} | ${formatPortsCell(r.ports)} | ${driftBadge} |`,
    );
  }
  lines.push('');

  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| Declared IP | \`${r.declared_ip}\` |`);
    if (r.declared_ips.length > 1) {
      lines.push(`| All declared IPs | ${r.declared_ips.map((ip) => `\`${ip}\``).join(', ')} |`);
    }
    lines.push(`| Role | ${r.role || '—'} |`);
    lines.push(`| DNS drift | \`${r.dns_drift}\` |`);
    if (r.dns_note) {
      lines.push(`| DNS note | ${r.dns_note} |`);
    }
    lines.push(`| Verified at | ${r.verified_at} |`);
    lines.push('');
    if (r.ports.length) {
      lines.push('### Port reachability');
      lines.push('');
      lines.push('| Port | Status | Verified at |');
      lines.push('|------|--------|-------------|');
      for (const p of r.ports) {
        lines.push(`| ${p.port} | ${p.status} | ${p.verified_at} |`);
      }
      lines.push('');
    }
    if (r.dns.length) {
      lines.push('### DNS resolution');
      lines.push('');
      for (const d of r.dns) {
        if (d.address) {
          lines.push(`- \`${d.query}\` → \`${d.address}\``);
        } else {
          lines.push(`- \`${d.query}\` → unresolved (${d.error})`);
        }
      }
      lines.push('');
    }
    if (r.dns_drift === 'mismatch') {
      lines.push(
        '> **Drift note:** Resolved address(es) differ from declared IP in `hosts.json`. Update declared truth or DNS zone.',
      );
      lines.push('');
    }
  }

  lines.push('## Regenerate');
  lines.push('');
  lines.push('```bash');
  lines.push('cd om-brain && node scripts/collect-hosts.js');
  lines.push('# commit om-brain/inventory/HOST-SNAPSHOT.md');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const opts = parseArgs();
  if (!fs.existsSync(opts.hostsPath)) {
    process.stderr.write(`[collect-hosts] hosts file not found: ${opts.hostsPath}\n`);
    process.exit(1);
  }

  const inventory = JSON.parse(fs.readFileSync(opts.hostsPath, 'utf8'));
  const domain = inventory.domain || 'om.internal';
  const runnerHostname = require('os').hostname();
  const results = [];

  for (const host of inventory.hosts) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await verifyHost(host, domain, opts.timeoutMs, runnerHostname));
  }

  const markdown = buildMarkdown(inventory, results, opts);
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, markdown, 'utf8');
  process.stdout.write(`[collect-hosts] wrote ${opts.outPath} (${results.length} hosts)\n`);
}

main().catch((err) => {
  process.stderr.write(`[collect-hosts] fatal: ${err.message}\n`);
  process.exit(1);
});
