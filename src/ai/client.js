'use strict';

/**
 * AI/model client layer (Spec v1.1 §3, Annex A §C/D/G).
 *
 * - OpenAI-SDK-compatible client pointed at a LOCAL Ollama endpoint via
 *   BRAIN_LLM_BASE_URL (default http://127.0.0.1:11434/v1).
 * - No API key required for local; any key var present is treated as local-only
 *   and is never sent to an external host.
 * - CIRCUIT BREAKER: refuses any host other than the configured local/LAN
 *   endpoint. Hard-blocks api.openai.com and non-RFC1918 hosts in production.
 *   On failure, halts the session and returns an escalation object — never a
 *   silent re-route.
 * - REDACTION: every payload is passed through redactForModel BEFORE it reaches
 *   the model.
 *
 * Two bounded model roles are exposed as separate prompt pipelines:
 *   - diagnostic()          → RAG explanation/recommendation
 *   - governanceAdvisory()  → ADVISORY opinion only (never authoritative)
 *
 * The OpenAI SDK is loaded lazily so the package runs and tests pass even if the
 * dependency is not installed in the build sandbox.
 */

const { config } = require('../config');
const { redactForModel } = require('./redactor');
const breaker = require('./circuitBreaker');
const logger = require('../util/logger');

let OpenAICtor = null;
function getOpenAICtor() {
  if (OpenAICtor !== null) return OpenAICtor;
  try {
    // eslint-disable-next-line global-require
    OpenAICtor = require('openai').OpenAI || require('openai');
  } catch (_) {
    OpenAICtor = false; // mark as unavailable
  }
  return OpenAICtor;
}

class BrainAIClient {
  /**
   * @param {object} [opts]
   * @param {object} [opts.cfg]      override config.llm
   * @param {boolean} [opts.production] override production flag
   * @param {Function} [opts.transport] injectable transport for tests:
   *        async ({model, messages, kind}) => ({content})
   * @param {Function} [opts.embedTransport] injectable embedding transport for tests:
   *        async ({model, input}) => ({vector})
   */
  constructor(opts = {}) {
    this.cfg = Object.assign({}, config.llm, opts.cfg || {});
    this.production = opts.production === undefined ? config.isProduction : opts.production;
    this.transport = opts.transport || null;
    this.embedTransport = opts.embedTransport || null;
    this._sdk = null;
  }

  /**
   * Enforce the circuit breaker against the configured base URL.
   * Throws a tagged error if the host is not permitted.
   */
  assertEndpointAllowed() {
    const verdict = breaker.checkHost(this.cfg.baseUrl, { production: this.production });
    if (!verdict.allowed) {
      const err = new Error('circuit_breaker_block:' + verdict.reason);
      err.code = 'CIRCUIT_BREAKER';
      err.verdict = verdict;
      throw err;
    }
    return verdict;
  }

  _getSdk() {
    if (this._sdk) return this._sdk;
    const Ctor = getOpenAICtor();
    if (!Ctor) return null;
    this._sdk = new Ctor({
      baseURL: this.cfg.baseUrl,
      apiKey: this.cfg.apiKey || 'local-no-key',
      timeout: this.cfg.timeoutMs,
    });
    return this._sdk;
  }

  /**
   * Low-level chat call. Applies the breaker and redaction. Returns
   * { ok, content } on success or { ok:false, escalation } on failure.
   */
  async _chat({ model, messages, sessionId, kind }) {
    // 1) Circuit breaker — refuse non-LAN/external hosts.
    try {
      this.assertEndpointAllowed();
    } catch (e) {
      logger.error('circuit_breaker_blocked_call', { reason: e.verdict && e.verdict.reason });
      return { ok: false, escalation: breaker.buildEscalation(sessionId, 'circuit_breaker', e.verdict) };
    }

    // 2) Redaction — strip secrets and tenant ids from every message BEFORE send.
    const safeMessages = redactForModel(messages);

    // 3) Transport (injectable for tests) or real SDK.
    try {
      if (this.transport) {
        const res = await this.transport({ model, messages: safeMessages, kind });
        return { ok: true, content: res.content, raw: res };
      }
      const sdk = this._getSdk();
      if (!sdk) {
        // Dependency unavailable in sandbox → treat as local-inference failure.
        return {
          ok: false,
          escalation: breaker.buildEscalation(
            sessionId,
            'inference_unavailable',
            'openai SDK not installed; local inference client could not be constructed',
          ),
        };
      }
      const completion = await sdk.chat.completions.create({
        model,
        messages: safeMessages,
        temperature: 0.1,
      });
      const content = completion.choices && completion.choices[0]
        ? completion.choices[0].message.content
        : '';
      return { ok: true, content, raw: completion };
    } catch (e) {
      // Local-inference failure → halt + escalate. NEVER fall back to external.
      logger.error('local_inference_failure', { kind, name: e && e.name });
      return {
        ok: false,
        escalation: breaker.buildEscalation(sessionId, 'inference_failure', e && e.message),
      };
    }
  }

  /**
   * Embedding pipeline — produce a dense vector for RAG retrieval.
   *
   * Same safety discipline as _chat: circuit breaker first (LAN-only), redaction
   * before send, NEVER a silent external fallback. Returns
   *   { ok: true, vector: number[] }            on success
   *   { ok: false, escalation }                  on breaker/inference failure
   * so callers can decide whether to degrade to the deterministic embedder.
   *
   * An injectable `embedTransport` (async ({model,input}) => ({vector})) is used
   * for tests so this path is exercised without the openai SDK or a live model.
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.sessionId]
   * @returns {Promise<{ok:boolean, vector?:number[], escalation?:object}>}
   */
  async embed(text, opts = {}) {
    const sessionId = opts.sessionId;
    // 1) Circuit breaker — refuse non-LAN/external hosts.
    try {
      this.assertEndpointAllowed();
    } catch (e) {
      logger.error('circuit_breaker_blocked_embed', { reason: e.verdict && e.verdict.reason });
      return { ok: false, escalation: breaker.buildEscalation(sessionId, 'circuit_breaker', e.verdict) };
    }
    // 2) Redaction — strip secrets/tenant ids from the text BEFORE send.
    const safe = redactForModel(String(text == null ? '' : text));
    const model = this.cfg.embeddingModel;
    // 3) Transport (injectable for tests) or real SDK.
    try {
      if (this.embedTransport) {
        const res = await this.embedTransport({ model, input: safe });
        return { ok: true, vector: res.vector };
      }
      const sdk = this._getSdk();
      if (!sdk || !sdk.embeddings || typeof sdk.embeddings.create !== 'function') {
        return {
          ok: false,
          escalation: breaker.buildEscalation(
            sessionId,
            'inference_unavailable',
            'openai SDK / embeddings endpoint not available; local embedder could not be constructed',
          ),
        };
      }
      const resp = await sdk.embeddings.create({ model, input: safe });
      const vector = resp && resp.data && resp.data[0] ? resp.data[0].embedding : null;
      if (!Array.isArray(vector) || vector.length === 0) {
        return {
          ok: false,
          escalation: breaker.buildEscalation(sessionId, 'inference_failure', 'empty embedding returned'),
        };
      }
      return { ok: true, vector };
    } catch (e) {
      logger.error('local_embed_failure', { name: e && e.name });
      return {
        ok: false,
        escalation: breaker.buildEscalation(sessionId, 'inference_failure', e && e.message),
      };
    }
  }

  /**
   * Diagnostic pipeline — RAG over event/log + doctrine + intent playbooks.
   * Produces an explanation/recommendation. The output is NEVER authoritative
   * for governance — the deterministic rule engine decides gates.
   */
  async diagnostic({ systemTruth, doctrine, incident, sessionId }) {
    const messages = [
      {
        role: 'system',
        content:
          'You are the OrthodoxMetrics Brain diagnostic role (Phase 1, auditor-first). ' +
          'Observe, analyze, and explain. Recommend only documented safe actions. ' +
          'You never authorize or execute anything. Governance gates are decided by a ' +
          'deterministic rule engine, not by you.',
      },
      { role: 'system', content: 'DOCTRINE:\n' + (doctrine || '') },
      // Redact at the SOURCE: structured objects are redacted before being
      // serialized into prompt text, so no secret value or tenant id is ever
      // embedded as a string in the prompt. _chat applies a second pass too.
      { role: 'system', content: 'SYSTEM TRUTH:\n' + JSON.stringify(redactForModel(systemTruth || {})) },
      { role: 'user', content: 'INCIDENT CONTEXT:\n' + JSON.stringify(redactForModel(incident || {})) },
    ];
    return this._chat({ model: this.cfg.reasoningModel, messages, sessionId, kind: 'diagnostic' });
  }

  /**
   * Governance-advisory pipeline — ADVISORY opinion only. Its output is attached
   * as a secondary note and can NEVER override the deterministic engine.
   */
  async governanceAdvisory({ proposal, doctrine, sessionId }) {
    const messages = [
      {
        role: 'system',
        content:
          'You provide an ADVISORY second opinion only. You do NOT decide whether a ' +
          'governance gate applies. A deterministic rule engine is authoritative. ' +
          'Your "No" cannot wave a change through; your "Yes" cannot trigger an action.',
      },
      { role: 'system', content: 'DOCTRINE:\n' + (doctrine || '') },
      { role: 'user', content: 'PROPOSED CHANGE:\n' + JSON.stringify(redactForModel(proposal || {})) },
    ];
    return this._chat({ model: this.cfg.classifierModel, messages, sessionId, kind: 'governance_advisory' });
  }
}

module.exports = { BrainAIClient, getOpenAICtor };
