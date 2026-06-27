'use strict';

class ChurchFinder {
  constructor(config = {}) {
    this.proxyBaseUrl = (config.proxyBaseUrl || 'http://192.168.1.239:7060').replace(/\/$/, '');
    this.googleApiKey = config.googleApiKey || '';
    this.timeoutMs = config.timeoutMs || 8000;
    this.logger = config.logger || { info: () => {}, error: () => {} };
  }

  async _fetch(path, body) {
    const url = `${this.proxyBaseUrl}/api/brain/places${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { error: `proxy_http_${res.status}`, results: [] };
      }
      return await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') return { error: 'proxy_timeout', results: [] };
      return { error: 'proxy_unavailable', results: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  async searchByText({ query, limit = 5 } = {}) {
    if (!query) return { error: 'query_required', results: [] };
    const out = await this._fetch('/text-search', { query, limit });
    if (out.error) return out;
    return { results: out.results || out.churches || [], raw: out };
  }

  async searchNearby({ lat, lng, limit = 5, radiusMiles = 25 } = {}) {
    if (lat == null || lng == null) return { error: 'coordinates_required', results: [] };
    const out = await this._fetch('/nearby', { lat, lng, limit, radiusMiles });
    if (out.error) return out;
    return { results: out.results || out.churches || [], raw: out };
  }
}

module.exports = { ChurchFinder };
