'use strict';

const crypto = require('crypto');
const logger = require('../util/logger');

class BtwQueue {
  constructor(config = {}) {
    this.db = config.db || null;
    this.modeRouter = config.modeRouter || null;
    this.log = config.logger || logger;
  }

  enqueue({ session_id, question, mode } = {}) {
    if (!session_id || !question) {
      return { ok: false, error: 'session_id_and_question_required' };
    }

    const btw_id = crypto.randomUUID();
    if (!this.db) {
      return { ok: false, error: 'no_db', btw_id };
    }

    if (typeof this.db.enqueueBtwQuestion === 'function') {
      this.db.enqueueBtwQuestion({ session_id, btw_id, question, mode: mode || 'auto' });
    } else {
      this.db.enqueueBtw({
        id: btw_id,
        message: question,
        category: 'ops',
        priority: 'normal',
        delivery_mode: 'next_interaction',
        source_ref: session_id,
      });
    }

    this.log.info('btw_queued', { session_id, btw_id, mode: mode || 'auto' });
    return { ok: true, btw_id, queued: true };
  }

  async process(session_id, deps = {}) {
    if (!this.db || !session_id) return [];

    let pending = [];
    if (typeof this.db.pendingBtwQuestions === 'function') {
      pending = this.db.pendingBtwQuestions(session_id);
    } else {
      pending = this.db.pendingBtw().filter((r) => r.source_ref === session_id);
    }

    if (!pending || pending.length === 0) return [];

    const answered = [];
    for (const item of pending) {
      const question = item.question || item.message;
      const btw_id = item.btw_id || item.id;
      const mode = item.mode || 'auto';
      let answer = null;

      try {
        if (this.modeRouter && typeof this.modeRouter.routeQuery === 'function') {
          const result = await this.modeRouter.routeQuery(question, {
            ...deps,
            sessionId: session_id,
            btw: true,
          });
          answer = this._extractAnswer(result);
        } else {
          answer = `[BTW] Question queued: "${question}"`;
        }
      } catch (err) {
        answer = `[BTW] Error processing question: ${err && err.message}`;
      }

      try {
        if (typeof this.db.answerBtw === 'function') {
          this.db.answerBtw(btw_id, answer);
        } else {
          this.db.markBtwDelivered(btw_id);
        }
      } catch (_) {}

      answered.push({ btw_id, question, mode, answer, answered_at: new Date().toISOString() });
    }

    return answered;
  }

  history(session_id) {
    if (!this.db || !session_id) return [];
    if (typeof this.db.btwHistory === 'function') {
      return this.db.btwHistory(session_id);
    }
    return (this.db.pendingBtw ? this.db.pendingBtw() : [])
      .filter((r) => r.source_ref === session_id);
  }

  _extractAnswer(result) {
    if (!result) return '[BTW] No answer returned.';
    if (typeof result === 'string') return result;
    if (result.answer) return result.answer;
    if (result.analysis) return result.analysis;
    if (result.recommendation) return result.recommendation;
    return JSON.stringify(result).slice(0, 500);
  }
}

module.exports = { BtwQueue };
