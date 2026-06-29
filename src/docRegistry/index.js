'use strict';

/**
 * Documentation registry — scan, classify, drift detection, snapshot generation.
 * om-brain indexes paths; it does not move or rsync documentation files.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ROOTS = path.join(ROOT, 'inventory', 'doc-roots.json');
const DEFAULT_STRUCTURE = path.join(ROOT, 'inventory', 'doc-structure.json');
const DEFAULT_SNAPSHOT = path.join(ROOT, 'inventory', 'DOC-SNAPSHOT.md');

const MD_EXT = new Set(['.md', '.mdc']);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pathExcluded(absPath, config) {
  const parts = absPath.split(path.sep);
  for (const name of config.exclude_dir_names || []) {
    if (parts.includes(name)) return true;
  }
  for (const glob of config.exclude_path_globs || []) {
    if (absPath.includes(glob.replace(/\//g, path.sep))) return true;
  }
  return false;
}

function matchesPattern(relPath, pattern) {
  const base = path.basename(relPath);
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
    return re.test(base) || re.test(relPath.replace(/\\/g, '/'));
  }
  return relPath.replace(/\\/g, '/').endsWith(pattern) || base === pattern;
}

function shouldIncludeFile(absPath, rootEntry, config) {
  if (pathExcluded(absPath, config)) return false;
  const ext = path.extname(absPath).toLowerCase();
  if (!MD_EXT.has(ext)) return false;

  const rel = path.relative(rootEntry.path, absPath);
  if (rootEntry.include_patterns && rootEntry.include_patterns.length) {
    const relPosix = rel.replace(/\\/g, '/');
    return rootEntry.include_patterns.some((p) => matchesPattern(relPosix, p));
  }
  return true;
}

function walkMarkdown(rootEntry, config, files) {
  const rootPath = rootEntry.path;
  if (!fs.existsSync(rootPath)) return;

  if (rootEntry.include_root_md) {
    for (const name of fs.readdirSync(rootPath)) {
      if (!name.endsWith('.md') && !name.endsWith('.mdc')) continue;
      const abs = path.join(rootPath, name);
      if (fs.statSync(abs).isFile() && shouldIncludeFile(abs, rootEntry, config)) {
        files.push({ absPath: abs, repo: rootEntry.repo });
      }
    }
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (pathExcluded(abs, config)) continue;
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.isFile() && shouldIncludeFile(abs, rootEntry, config)) {
        files.push({ absPath: abs, repo: rootEntry.repo });
      }
    }
  }

  walk(rootPath);
}

function inferTitle(content, filePath) {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim().slice(0, 200);
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, ' ');
}

function classifyPath(absPath, repo, structure) {
  const norm = absPath.replace(/\\/g, '/');
  let category = 'other';
  for (const rule of structure.path_rules || []) {
    if (norm.includes(rule.match)) {
      category = rule.category;
      break;
    }
  }
  if (category === 'archive' || /\/\d-\d+-\d+\//.test(norm) || /\/archive\//i.test(norm)) {
    return { category: 'archive', status: 'archive' };
  }
  return { category, status: 'canonical' };
}

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function scanFilesystem(opts = {}) {
  const rootsPath = opts.rootsPath || DEFAULT_ROOTS;
  const structurePath = opts.structurePath || DEFAULT_STRUCTURE;
  const config = loadJson(rootsPath);
  const structure = loadJson(structurePath);
  const scannedAt = opts.scannedAt || new Date().toISOString();
  const files = [];

  for (const rootEntry of config.roots || []) {
    walkMarkdown(rootEntry, config, files);
  }

  const entries = files.map(({ absPath, repo }) => {
    const stat = fs.statSync(absPath);
    const content = fs.readFileSync(absPath, 'utf8');
    const { category, status } = classifyPath(absPath, repo, structure);
    return {
      path: absPath,
      repo,
      category,
      title: inferTitle(content, absPath),
      status,
      sha256: hashFile(absPath),
      mtime: stat.mtime.toISOString(),
      last_scanned_at: scannedAt,
      notes: null,
    };
  });

  return applyDuplicateDetection(entries, structure);
}

function applyDuplicateDetection(entries, structure) {
  const byHash = new Map();
  for (const e of entries) {
    if (!e.sha256) continue;
    if (!byHash.has(e.sha256)) byHash.set(e.sha256, []);
    byHash.get(e.sha256).push(e);
  }

  const hubPaths = new Set(
    Object.values(structure.trees || {}).map((t) => t.hub_path),
  );

  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const aHub = hubPaths.has(a.path) || a.path.includes('/docs/') ? 0 : 1;
      const bHub = hubPaths.has(b.path) || b.path.includes('/docs/') ? 0 : 1;
      if (aHub !== bHub) return aHub - bHub;
      return a.path.localeCompare(b.path);
    });
    const canonical = group[0];
    canonical.status = canonical.category === 'archive' ? 'archive' : 'canonical';
    for (let i = 1; i < group.length; i += 1) {
      group[i].status = 'duplicate';
      group[i].notes = `duplicate of ${canonical.path}`;
    }
  }

  return entries;
}

function detectDeclaredDrift(entries, structure) {
  const foundPaths = new Set(entries.map((e) => e.path));
  const missing = [];

  for (const [repoKey, tree] of Object.entries(structure.trees || {})) {
    const hub = tree.hub_path;
    if (!fs.existsSync(hub)) continue;
    for (const folder of tree.folders || []) {
      const expected = folder.endsWith('/')
        ? path.join(hub, folder)
        : path.join(hub, folder);
      if (folder.endsWith('/') && !fs.existsSync(expected)) {
        missing.push({
          path: expected,
          repo: repoKey === 'om' ? 'om' : 'omai',
          category: 'other',
          title: `(declared folder missing) ${folder}`,
          status: 'missing',
          sha256: null,
          mtime: null,
          last_scanned_at: new Date().toISOString(),
          notes: 'declared in doc-structure.json but not found on disk',
        });
      } else if (!folder.endsWith('/') && !foundPaths.has(expected) && !fs.existsSync(expected)) {
        missing.push({
          path: expected,
          repo: repoKey === 'om' ? 'om' : 'omai',
          category: 'other',
          title: `(declared file missing) ${folder}`,
          status: 'missing',
          sha256: null,
          mtime: null,
          last_scanned_at: new Date().toISOString(),
          notes: 'declared in doc-structure.json but not found on disk',
        });
      }
    }
  }

  return missing;
}

function runScan(db, opts = {}) {
  const commit = !!opts.commit;
  const scannedAt = new Date().toISOString();
  let entries = scanFilesystem({ ...opts, scannedAt });
  const driftMissing = detectDeclaredDrift(entries, loadJson(opts.structurePath || DEFAULT_STRUCTURE));
  entries = entries.concat(driftMissing);

  const stats = {
    scanned_at: scannedAt,
    total: entries.length,
    by_status: {},
    by_repo: {},
    by_category: {},
    commit,
  };

  for (const e of entries) {
    stats.by_status[e.status] = (stats.by_status[e.status] || 0) + 1;
    stats.by_repo[e.repo] = (stats.by_repo[e.repo] || 0) + 1;
    stats.by_category[e.category] = (stats.by_category[e.category] || 0) + 1;
  }

  if (commit && db && typeof db.replaceDocRegistry === 'function') {
    db.replaceDocRegistry(entries, scannedAt);
  }

  const snapshotPath = opts.outPath || DEFAULT_SNAPSHOT;
  const markdown = buildSnapshotMarkdown(entries, stats, opts);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, markdown, 'utf8');

  return { entries, stats, snapshotPath };
}

function buildSnapshotMarkdown(entries, stats, opts) {
  const hostname = (() => {
    try {
      return require('os').hostname();
    } catch (_) {
      return 'unknown';
    }
  })();

  const lines = [];
  lines.push('# Documentation Registry Snapshot');
  lines.push('');
  lines.push(
    '> Auto-generated by `node om-brain/scripts/scan-doc-registry.js`. **Do not edit manually.**',
  );
  lines.push(`> Generated: ${stats.scanned_at}`);
  lines.push(`> Scan runner: \`${hostname}\``);
  lines.push('> Declared structure: `om-brain/inventory/doc-structure.json`');
  lines.push('> Scan roots: `om-brain/inventory/doc-roots.json`');
  lines.push('');
  lines.push('om-brain **indexes** documentation paths — files remain in their repos.');
  lines.push('See `docs/om-brain/DOC-REGISTRY.md` for ownership and drift policy.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total indexed paths | ${stats.total} |`);
  lines.push(`| Committed to DB | ${stats.commit ? 'yes' : 'no (dry-run)'} |`);
  for (const [k, v] of Object.entries(stats.by_status).sort()) {
    lines.push(`| Status \`${k}\` | ${v} |`);
  }
  lines.push('');
  lines.push('## By repository');
  lines.push('');
  lines.push('| Repo | Count |');
  lines.push('|------|-------|');
  for (const [k, v] of Object.entries(stats.by_repo).sort()) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');
  lines.push('## Drift highlights');
  lines.push('');
  const dupes = entries.filter((e) => e.status === 'duplicate').slice(0, 20);
  const missing = entries.filter((e) => e.status === 'missing');
  lines.push(`- **Duplicates detected:** ${entries.filter((e) => e.status === 'duplicate').length}`);
  lines.push(`- **Declared-but-missing:** ${missing.length}`);
  if (missing.length) {
    for (const m of missing) {
      lines.push(`  - \`${m.path}\``);
    }
  }
  if (dupes.length) {
    lines.push('');
    lines.push('Sample duplicate paths (first 20):');
    lines.push('');
    for (const d of dupes) {
      lines.push(`- \`${d.path}\` → ${d.notes || ''}`);
    }
  }
  lines.push('');
  lines.push('## Regenerate');
  lines.push('');
  lines.push('```bash');
  lines.push('cd om-brain && node scripts/scan-doc-registry.js --commit');
  lines.push('# commit om-brain/inventory/DOC-SNAPSHOT.md');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function getStructure(structurePath = DEFAULT_STRUCTURE) {
  return loadJson(structurePath);
}

module.exports = {
  DEFAULT_ROOTS,
  DEFAULT_STRUCTURE,
  DEFAULT_SNAPSHOT,
  scanFilesystem,
  runScan,
  buildSnapshotMarkdown,
  getStructure,
  classifyPath,
  inferTitle,
};
