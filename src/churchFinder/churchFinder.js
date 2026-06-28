'use strict';

/**
 * Church Finder Service (P1-2, 2026-06-27)
 *
 * DB-backed caching via church_memory; live lookup via OMAI /api/brain/places/* proxy.
 */

const http = require('http');
const https = require('https');

const DEFAULT_PROXY_BASE = 'http://192.168.1.239:7060';
const DEFAULT_RADIUS_MILES = 25;
const MILES_TO_METERS = 1609.344;
const EARTH_RADIUS_MILES = 3958.8;

function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a));
}

const JURISDICTION_PATTERNS = [
  { pattern: /greek orthodox/i, jurisdiction: 'Greek Orthodox Archdiocese of America (GOA)' },
  { pattern: /antiochian/i, jurisdiction: 'Antiochian Orthodox Christian Archdiocese' },
  { pattern: /\boca\b|orthodox church in america/i, jurisdiction: 'Orthodox Church in America (OCA)' },
  { pattern: /russian orthodox/i, jurisdiction: 'Russian Orthodox Church Outside Russia (ROCOR)' },
  { pattern: /\brocor\b/i, jurisdiction: 'Russian Orthodox Church Outside Russia (ROCOR)' },
  { pattern: /serbian orthodox/i, jurisdiction: 'Serbian Orthodox Church' },
  { pattern: /romanian orthodox/i, jurisdiction: 'Romanian Orthodox Episcopate' },
  { pattern: /bulgarian orthodox/i, jurisdiction: 'Bulgarian Orthodox Diocese' },
  { pattern: /ukrainian orthodox/i, jurisdiction: 'Ukrainian Orthodox Church' },
  { pattern: /coptic/i, jurisdiction: 'Coptic Orthodox Church' },
  { pattern: /ethiopian orthodox/i, jurisdiction: 'Ethiopian Orthodox Tewahedo Church' },
  { pattern: /armenian apostolic/i, jurisdiction: 'Armenian Apostolic Church' },
  { pattern: /carpatho-russian/i, jurisdiction: 'American Carpatho-Russian Orthodox Diocese' },
  { pattern: /albanian orthodox/i, jurisdiction: 'Albanian Orthodox Diocese' },
  { pattern: /macedonian orthodox/i, jurisdiction: 'Macedonian Orthodox Church' },
];

function detectJurisdiction(name) {
  for (const { pattern, jurisdiction } of JURISDICTION_PATTERNS) {
    if (pattern.test(name)) return jurisdiction;
  }
  return null;
}

function proxyPost(proxyBaseUrl, path, body, serviceToken, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, proxyBaseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const bodyBuf = Buffer.from(JSON.stringify(body));

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': String(bodyBuf.length),
    };
    if (serviceToken) {
      headers['X-Service-Token'] = serviceToken;
      headers['X-Source-System'] = 'om-brain-church-finder';
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`proxy_timeout after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.end(bodyBuf);
  });
}

function normalizePlaceResult(place, refLat, refLng) {
  const lat = place.geometry && place.geometry.location ? place.geometry.location.lat : null;
  const lng = place.geometry && place.geometry.location ? place.geometry.location.lng : null;
  const distance = (lat != null && lng != null && refLat != null && refLng != null)
    ? Math.round(haversine(refLat, refLng, lat, lng) * 10) / 10
    : null;

  const name = place.name || '';
  const jurisdiction = detectJurisdiction(name);

  return {
    place_id: place.place_id || null,
    name,
    address: place.formatted_address || place.vicinity || null,
    city: null,
    state: null,
    country: 'US',
    lat,
    lng,
    phone: place.formatted_phone_number || null,
    website: place.website || null,
    google_maps_url: place.url || (place.place_id ? `https://maps.google.com/?cid=${place.place_id}` : null),
    rating: place.rating || null,
    rating_count: place.user_ratings_total || null,
    jurisdiction,
    liturgical_calendar: null,
    canonical: null,
    opening_hours: place.opening_hours || null,
    hours_source: 'google_places',
    distance_miles: distance,
    data_sources: ['google_places'],
  };
}

class ChurchFinder {
  constructor(config = {}) {
    this.proxyBaseUrl = (config.proxyBaseUrl
      || process.env.OMAI_PROXY_URL
      || DEFAULT_PROXY_BASE).replace(/\/$/, '');
    this.serviceToken = config.serviceToken || process.env.OMSTUDIO_SERVICE_TOKEN || '';
    this.timeoutMs = config.timeoutMs || 8000;
    this.cacheTtlHours = config.cacheTtlHours
      || Number(process.env.BRAIN_CHURCH_CACHE_TTL_HOURS || 168);
    this.db = config.db || null;
    this.logger = config.logger || { info: () => {}, warn: () => {}, error: () => {} };
  }

  async _geocode(input) {
    const latLngMatch = String(input).match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (latLngMatch) {
      return { lat: parseFloat(latLngMatch[1]), lng: parseFloat(latLngMatch[2]), formatted_address: input };
    }

    try {
      const resp = await proxyPost(
        this.proxyBaseUrl,
        '/api/brain/places/geocode',
        { input },
        this.serviceToken,
        this.timeoutMs,
      );
      const body = resp.body;
      if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS' && !body.ok) {
        return null;
      }
      const top = (body.results && body.results[0]) || body;
      const loc = top.geometry ? top.geometry.location : { lat: body.lat, lng: body.lng };
      if (!loc || loc.lat == null) return null;
      return {
        lat: loc.lat,
        lng: loc.lng,
        formatted_address: top.formatted_address || body.formatted_address || input,
        place_id: top.place_id || body.place_id,
      };
    } catch (err) {
      this.logger.warn('church_finder_geocode_error', { input, error: err.message });
      return null;
    }
  }

  _checkCache(lat, lng, radiusMiles) {
    if (!this.db || typeof this.db.churchesByLatLng !== 'function') return [];
    try {
      return this.db.churchesByLatLng(lat, lng, radiusMiles);
    } catch (_) {
      return [];
    }
  }

  async _fetchNearby(lat, lng, radiusMiles) {
    const radiusMeters = Math.round(radiusMiles * MILES_TO_METERS);
    try {
      const resp = await proxyPost(
        this.proxyBaseUrl,
        '/api/brain/places/nearby',
        { lat, lng, radius_meters: radiusMeters, keyword: 'Orthodox church' },
        this.serviceToken,
        this.timeoutMs,
      );
      const body = resp.body;
      if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS' && !body.ok) {
        this.logger.warn('church_finder_nearby_error', { status: body.status || body.error });
        return { error: body.status || body.error || 'google_error', results: [] };
      }
      return { error: null, results: body.results || [] };
    } catch (err) {
      this.logger.warn('church_finder_nearby_fetch_error', { error: err.message });
      return { error: err.message, results: [] };
    }
  }

  _mergeEnrichment(normalized) {
    if (!this.db || !normalized.place_id) return normalized;
    try {
      const cached = typeof this.db.churchByPlaceId === 'function'
        ? this.db.churchByPlaceId(normalized.place_id)
        : null;
      if (!cached) return normalized;
      return {
        ...normalized,
        jurisdiction: cached.jurisdiction || normalized.jurisdiction,
        liturgical_calendar: cached.liturgical_calendar || null,
        canonical: cached.canonical != null ? cached.canonical : null,
        phone: cached.phone || normalized.phone,
        website: cached.website || normalized.website,
        hours_source: cached.service_schedule_json ? 'church_memory' : normalized.hours_source,
        service_schedule: cached.service_schedule_json
          ? JSON.parse(cached.service_schedule_json)
          : undefined,
        data_sources: cached.jurisdiction
          ? [...new Set([...normalized.data_sources, 'church_memory'])]
          : normalized.data_sources,
      };
    } catch (_) {
      return normalized;
    }
  }

  _cacheResult(normalized) {
    if (!this.db || !normalized.place_id) return;
    try {
      this.db.upsertChurch({
        id: normalized.place_id,
        place_id: normalized.place_id,
        name: normalized.name,
        jurisdiction: normalized.jurisdiction,
        address: normalized.address,
        city: normalized.city,
        state: normalized.state,
        country: normalized.country || 'US',
        lat: normalized.lat,
        lng: normalized.lng,
        phone: normalized.phone,
        website: normalized.website,
        liturgical_calendar: normalized.liturgical_calendar,
        source: 'google_places',
        last_verified: new Date().toISOString(),
        google_maps_url: normalized.google_maps_url,
        rating: normalized.rating,
        rating_count: normalized.rating_count,
        hours_source: normalized.hours_source,
        last_fetched_at: new Date().toISOString(),
      });
    } catch (_) {}
  }

  async findChurches({ input, radiusMiles = DEFAULT_RADIUS_MILES } = {}) {
    if (!input) {
      return { error: 'input_required', churches: [], total: 0 };
    }

    const geo = await this._geocode(input);
    if (!geo) {
      return {
        error: 'geocode_failed',
        churches: [],
        total: 0,
        note: `Could not geocode "${input}". Try a zip code, city name, or "lat,lng" format.`,
      };
    }

    const { lat, lng, formatted_address } = geo;
    this.logger.info('church_finder_geocoded', { input, lat, lng });

    const cached = this._checkCache(lat, lng, radiusMiles);
    if (cached.length > 0) {
      const results = cached
        .map((r) => ({
          ...r,
          distance_miles: r.lat != null ? Math.round(haversine(lat, lng, r.lat, r.lng) * 10) / 10 : null,
          data_sources: ['church_memory'],
        }))
        .sort((a, b) => (a.distance_miles || 999) - (b.distance_miles || 999));
      return {
        query: input,
        geocoded_address: formatted_address,
        churches: results,
        total: results.length,
        source: 'church_memory_cache',
      };
    }

    const { error, results: rawResults } = await this._fetchNearby(lat, lng, radiusMiles);
    if (error) {
      // The cache was already checked above and was empty. Live lookup failed
      // (proxy down / GOOGLE_PLACES_API_KEY absent / circuit-breaker block), so
      // degrade gracefully: signal `degraded` + `mode: 'cache_only'` so callers
      // present a clear "live search unavailable" state rather than a hard error.
      // See docs/om-brain/adr/0002-church-finder-places-key.md.
      return {
        error,
        degraded: true,
        mode: 'cache_only',
        query: input,
        geocoded_address: formatted_address,
        churches: [],
        total: 0,
        note: `Live church lookup is currently unavailable (${error}). No cached Orthodox churches near "${input}" yet. Live lookup requires the OMAI Places proxy and GOOGLE_PLACES_API_KEY; cached results from church_memory are served automatically when present.`,
      };
    }

    if (rawResults.length === 0) {
      return {
        query: input,
        geocoded_address: formatted_address,
        churches: [],
        total: 0,
        note: `No Orthodox churches found within ${radiusMiles} miles of "${input}".`,
      };
    }

    const churches = rawResults
      .map((place) => {
        const normalized = normalizePlaceResult(place, lat, lng);
        const enriched = this._mergeEnrichment(normalized);
        this._cacheResult(normalized);
        return enriched;
      })
      .sort((a, b) => (a.distance_miles || 999) - (b.distance_miles || 999));

    return {
      query: input,
      geocoded_address: formatted_address,
      churches,
      total: churches.length,
      source: 'google_places_live',
    };
  }

  async searchByText({ query, limit = 5 } = {}) {
    if (!query) return { error: 'query_required', results: [] };
    try {
      const resp = await proxyPost(
        this.proxyBaseUrl,
        '/api/brain/places/text',
        { query },
        this.serviceToken,
        this.timeoutMs,
      );
      const body = resp.body;
      if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS' && !body.ok) {
        return { error: body.status || body.error || 'google_error', results: [] };
      }
      const results = (body.results || [])
        .slice(0, limit)
        .map((place) => this._mergeEnrichment(normalizePlaceResult(place, null, null)));
      return { error: null, results };
    } catch (err) {
      return { error: err.message, results: [] };
    }
  }

  async searchNearby({ lat, lng, radiusMiles = DEFAULT_RADIUS_MILES, limit = 10 } = {}) {
    const { error, results: rawResults } = await this._fetchNearby(lat, lng, radiusMiles);
    if (error) return { error, results: [] };
    const results = rawResults
      .slice(0, limit)
      .map((place) => this._mergeEnrichment(normalizePlaceResult(place, lat, lng)));
    return { error: null, results };
  }

  searchByLatLng(opts) {
    return this.searchNearby(opts);
  }

  searchByZip({ zip, radiusMiles = DEFAULT_RADIUS_MILES, limit = 10 } = {}) {
    return this.findChurches({ input: zip, radiusMiles }).then((out) => ({
      error: out.error || null,
      results: (out.churches || []).slice(0, limit),
      ...out,
    }));
  }

  enrichChurch(placeId, enrichmentData = {}) {
    if (!this.db) return { ok: false, error: 'no_db' };
    try {
      if (typeof this.db.enrichChurch === 'function') {
        this.db.enrichChurch(placeId, enrichmentData);
        return { ok: true, place_id: placeId };
      }
      return { ok: false, error: 'enrichChurch_not_available' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = { ChurchFinder };
