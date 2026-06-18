'use strict';

/**
 * Log ingestion adapter (READ-ONLY) — Spec v1.1 §4.
 *
 * Subscribes to a WebSocket logger endpoint (wss://.../ws/omai-logger).
 * Reconnects with exponential backoff (capped). JWT bearer auth from env.
 * Every received log frame is REDACTED before persistence.
 *
 * The `ws` dependency is loaded lazily so the package runs and tests pass even
 * if it is not installed in the build sandbox; the adapter then logs a redacted
 * warning and stays inert (no crash loop).
 */

const { config } = require('../config');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

function tryLoadWs() {
  try {
    // eslint-disable-next-line global-require
    return require('ws');
  } catch (_) {
    return null;
  }
}

class LogAdapter {
  constructor(deps = {}) {
    this.db = deps.db;
    this.WS = deps.WebSocketImpl || tryLoadWs();
    this.cfg = config.ingest;
    this.ws = null;
    this.backoff = this.cfg.logWsBackoffMs;
    this.stopped = false;
  }

  _connect() {
    if (this.stopped) return;
    if (!this.WS) {
      logger.warn('log_adapter_no_ws_dependency');
      return;
    }
    const headers = {};
    if (this.cfg.jwt) headers.Authorization = `Bearer ${this.cfg.jwt}`;

    try {
      this.ws = new this.WS(this.cfg.logWsUrl, { headers });
    } catch (e) {
      logger.warn('log_adapter_connect_throw', { name: e && e.name });
      return this._scheduleReconnect();
    }

    this.ws.on('open', () => {
      this.backoff = this.cfg.logWsBackoffMs; // reset on success
      logger.info('log_adapter_connected');
    });

    this.ws.on('message', (buf) => {
      let parsed;
      try {
        parsed = JSON.parse(buf.toString());
      } catch (_) {
        parsed = { raw: buf.toString() };
      }
      const safe = redactForLog(parsed);
      this.db &&
        this.db.insertEvent({
          source: 'log_ws',
          event_type: safe.level || safe.type || 'log',
          severity: safe.level || null,
          church_id: null,
          correlation: safe.request_id || null,
          payload_json: JSON.stringify(safe),
        });
    });

    this.ws.on('close', () => {
      logger.warn('log_adapter_closed');
      this._scheduleReconnect();
    });

    this.ws.on('error', (e) => {
      logger.warn('log_adapter_error', { name: e && e.name });
      // close handler will schedule reconnect
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.cfg.logWsBackoffMaxMs);
    const t = setTimeout(() => this._connect(), delay);
    if (t.unref) t.unref();
    logger.info('log_adapter_reconnect_scheduled', { delay_ms: delay });
  }

  start() {
    if (!this.cfg.enableLogAdapter) {
      logger.info('log_adapter_disabled');
      return;
    }
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    try {
      this.ws && this.ws.close();
    } catch (_) {
      /* ignore */
    }
    this.ws = null;
  }
}

module.exports = { LogAdapter };
