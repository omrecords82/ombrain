'use strict';

/**
 * Church Finder — cache-first + graceful degradation tests (ADR-0002).
 * These exercise the offline-testable paths (no live Google/proxy needed).
 * Run: cd om-brain && npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { ChurchFinder } = require('../src/churchFinder/churchFinder');

// A finder whose geocoder is stubbed to a fixed point and whose live fetch
// always fails — simulating "no proxy / no GOOGLE_PLACES_API_KEY".
function makeFinder({ cacheRows = [] } = {}) {
  const cf = new ChurchFinder({
    db: {
      churchesByLatLng: () => cacheRows,
      churchByPlaceId: () => null,
      upsertChurch: () => {},
    },
  });
  // Stub geocode to avoid any network.
  cf._geocode = async () => ({ lat: 40.0, lng: -75.0, formatted_address: 'Test, US' });
  return cf;
}

test('cache hit returns church_memory results without any live lookup', async () => {
  const cf = makeFinder({
    cacheRows: [
      { place_id: 'a', name: 'St. Nicholas Greek Orthodox', lat: 40.01, lng: -75.01 },
      { place_id: 'b', name: 'Holy Trinity OCA', lat: 40.2, lng: -75.2 },
    ],
  });
  // Make live fetch throw if ever called.
  cf._fetchNearby = async () => { throw new Error('live lookup must not be called on cache hit'); };

  const out = await cf.findChurches({ input: '19000' });
  assert.strictEqual(out.source, 'church_memory_cache');
  assert.strictEqual(out.total, 2);
  // Sorted by distance ascending.
  assert.ok(out.churches[0].distance_miles <= out.churches[1].distance_miles);
  assert.deepStrictEqual(out.churches[0].data_sources, ['church_memory']);
});

test('cache miss + failed live lookup degrades gracefully (cache_only)', async () => {
  const cf = makeFinder({ cacheRows: [] });
  cf._fetchNearby = async () => ({ error: 'proxy_timeout', results: [] });

  const out = await cf.findChurches({ input: '19000' });
  assert.strictEqual(out.degraded, true);
  assert.strictEqual(out.mode, 'cache_only');
  assert.strictEqual(out.total, 0);
  assert.match(out.note, /currently unavailable/i);
  assert.strictEqual(out.error, 'proxy_timeout');
});

test('cache miss + successful live lookup returns live results', async () => {
  const cf = makeFinder({ cacheRows: [] });
  cf._fetchNearby = async () => ({
    error: null,
    results: [
      { place_id: 'x', name: 'St. George Antiochian',
        geometry: { location: { lat: 40.05, lng: -75.05 } } },
    ],
  });

  const out = await cf.findChurches({ input: '19000' });
  assert.strictEqual(out.source, 'google_places_live');
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.churches[0].jurisdiction, 'Antiochian Orthodox Christian Archdiocese');
});

test('missing input is rejected', async () => {
  const cf = makeFinder();
  const out = await cf.findChurches({});
  assert.strictEqual(out.error, 'input_required');
});
