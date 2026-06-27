'use strict';

const BOOKS = {
  genesis: 'Genesis', gen: 'Genesis', exodus: 'Exodus', ex: 'Exodus',
  matthew: 'Matthew', matt: 'Matthew', mt: 'Matthew',
  john: 'John', jn: 'John', romans: 'Romans', rom: 'Romans',
};

function parseReference(raw) {
  const m = String(raw || '').trim().match(/^([1-3]?\s*[A-Za-z]+)\s+(\d+)(?::(\d+)(?:-(\d+))?)?$/);
  if (!m) return null;
  const bookKey = m[1].toLowerCase().replace(/\s+/g, '');
  const book = BOOKS[bookKey] || m[1].trim();
  return {
    book,
    chapter: Number(m[2]),
    verse: m[3] ? Number(m[3]) : null,
    verseEnd: m[4] ? Number(m[4]) : (m[3] ? Number(m[3]) : null),
    raw: raw.trim(),
  };
}

function extractReferences(text) {
  const re = /\b([1-3]?\s*[A-Za-z]+)\s+(\d+):(\d+)(?:-(\d+))?/g;
  const out = [];
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push(parseReference(m[0]));
  }
  return out.filter(Boolean);
}

function search(_query) {
  return [];
}

function getBySlug(_slug) {
  return null;
}

function listSlugs() {
  return [];
}

module.exports = {
  parseReference,
  extractReferences,
  search,
  getBySlug,
  listSlugs,
};
