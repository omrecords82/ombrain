# Theological Knowledge Layer — Sources and Provenance

This document records the sources, licensing, and ingestion method behind the om-brain theological knowledge layer (`theological_memory` table, `src/theology/`, and the `scripts/theology/seed-*.js` scripts). It exists so that every stored claim is traceable to a citable, appropriately-licensed source, per OM-DOCTRINE-0001.

## Design principles

- **Citable.** Every `theological_memory` row carries a source reference so answers can cite chapter-and-verse (scripture) or work-and-section (patristic/conciliar).
- **Immutable.** The table is append-only (enforced by trigger). Corrections supersede rather than overwrite, preserving the audit trail.
- **Public-domain first.** Bundled seed data is restricted to public-domain or clearly-licensed texts so the corpus can ship offline with the service.
- **Representative, then expandable.** The committed seeds are representative samples (enough to exercise retrieval and citation). Expanding to a full corpus is a pure data task that layers onto the existing schema and seed scripts without code changes.

## Sources by layer

| Layer | Seed script | Source | License / status |
| --- | --- | --- | --- |
| Septuagint (OT) | `seed-lxx.js` | Brenton's English Septuagint (1851) | Public domain |
| New Testament | `seed-nt.js` | KJV (1769) / public-domain critical text | Public domain |
| Catechism | `seed-catechism.js` | Longer Catechism of St. Philaret of Moscow | Public domain |
| Ecumenical Councils | `seed-councils.js` | Canons & definitions of the Seven Councils (NPNF series) | Public domain |
| Church Fathers | `seed-fathers.js` | Ante-/Post-Nicene Fathers (NPNF/ANF, public-domain translations) | Public domain |
| Liturgical texts | `seed-liturgy.js` | Divine Liturgy of St. John Chrysostom (public-domain translations) | Public domain |
| Core beliefs | `seed-beliefs.js` | Nicene-Constantinopolitan Creed and conciliar dogmatic definitions | Public domain |
| OSB summaries | `seed-osb-summaries.js` | Original editorial summaries (not reproductions of copyrighted study notes) | Original work |

> **Note on the Orthodox Study Bible.** The OSB's annotations and study notes are copyrighted and are **not** ingested. `seed-osb-summaries.js` stores only original, non-infringing editorial summaries that point readers to the source for the full text.

## Retrieval and embeddings

Semantic search (`theologySearch`) uses the `vec_theological` vec0 virtual table when `sqlite-vec` is loaded, and falls back to a pure-JS cosine scan otherwise. Embeddings are produced by `BrainAIClient.embed()` (the `nomic-embed-text` model by default) and backfilled by `scripts/embed-theology.js` (which delegates to the hardened `backfill-embeddings.js`). No theological text is sent to any non-LAN endpoint; the circuit breaker blocks non-RFC1918 hosts in production.

## Citation and the "non-unanimous" note

When a query touches a matter on which the Fathers or jurisdictions are not unanimous, the orchestrator appends an explicit note to that effect rather than presenting one view as settled. Pastoral answers always defer to a priest / spiritual father and never present the Brain as clergy.

## Configuration

- `BRAIN_THEOLOGY_ENABLED` (default `false`) — master switch; when off, `POST /brain/theology/ask` returns 503.
- `BRAIN_THEOLOGY_TOP_K` (default `8`) — chunks retrieved per semantic search.

## Expanding the corpus

To add material: extend the relevant `scripts/theology/seed-*.js` with public-domain or originally-authored rows (each with a source reference), re-run the seed, then run `scripts/embed-theology.js` to populate embeddings. Keep this table's source/license columns honest — provenance is part of the doctrine, not metadata.
