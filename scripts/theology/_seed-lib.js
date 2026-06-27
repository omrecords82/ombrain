'use strict';

const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.BRAIN_DB_PATH || process.env.DB_PATH || '/var/lib/om-brain/brain.db';

function openDb() {
  return new Database(DB_PATH);
}

function insertTheology(db, row) {
  const id = row.id || crypto.randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO theological_memory
     (id, category, subcategory, reference_key, title, body, source, language)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.category,
    row.subcategory || null,
    row.reference_key,
    row.title || null,
    row.body,
    row.source,
    row.language || 'en',
  );
  return id;
}

function insertMany(db, rows) {
  let inserted = 0;
  for (const row of rows) {
    const info = db.prepare(
      `INSERT OR IGNORE INTO theological_memory
       (id, category, subcategory, reference_key, title, body, source, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id || crypto.randomUUID(),
      row.category,
      row.subcategory || null,
      row.reference_key,
      row.title || null,
      row.body,
      row.source,
      row.language || 'en',
    );
    if (info.changes > 0) inserted += 1;
  }
  return inserted;
}

module.exports = { openDb, insertTheology, insertMany, DB_PATH };
