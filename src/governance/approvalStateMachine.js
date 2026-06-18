'use strict';

/**
 * Deterministic approval state machine (Phase 1 OMStudio governance step).
 *
 * AUTHORITATIVE, pure code, fully unit-tested. Encodes the lifecycle of a
 * human-only / Tier 0 approval request. The model can NEVER influence a
 * transition; the Brain can NEVER self-approve.
 *
 *   PENDING_SUBMISSION ──submit──▶ SUBMITTED
 *          │                          │
 *          │ withdraw                 ├── approve  ──▶ APPROVED   (terminal)
 *          ▼                          ├── reject   ──▶ REJECTED   (terminal)
 *      WITHDRAWN (terminal)           ├── expire   ──▶ EXPIRED    (terminal)
 *                                     └── withdraw ──▶ WITHDRAWN  (terminal)
 *
 * CRITICAL DOCTRINE RULE: the transitions into APPROVED and REJECTED (and
 * EXPIRED) may ONLY originate from an EXTERNAL source — an ingested OMStudio
 * status (or, in dry-run, an explicitly operator-simulated, test-labeled input).
 * A transition request whose `source` is the Brain ('brain_submit' / 'brain')
 * is REJECTED for those target states. This makes it impossible for a model
 * output or the Brain itself to flip an approval to APPROVED/REJECTED.
 */

const STATES = Object.freeze({
  PENDING_SUBMISSION: 'PENDING_SUBMISSION',
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  WITHDRAWN: 'WITHDRAWN',
});

const TERMINAL_STATES = new Set([
  STATES.APPROVED,
  STATES.REJECTED,
  STATES.EXPIRED,
  STATES.WITHDRAWN,
]);

// Target states that can ONLY be set by an external (non-Brain) source.
const EXTERNALLY_SET_STATES = new Set([STATES.APPROVED, STATES.REJECTED, STATES.EXPIRED]);

// Allowed transitions: from -> set(to)
const TRANSITIONS = Object.freeze({
  PENDING_SUBMISSION: new Set([STATES.SUBMITTED, STATES.WITHDRAWN]),
  SUBMITTED: new Set([STATES.APPROVED, STATES.REJECTED, STATES.EXPIRED, STATES.WITHDRAWN]),
  APPROVED: new Set(),
  REJECTED: new Set(),
  EXPIRED: new Set(),
  WITHDRAWN: new Set(),
});

// Sources permitted to drive transitions.
const SOURCES = Object.freeze({
  CREATE: 'create',
  BRAIN_SUBMIT: 'brain_submit', // Brain submitting PENDING -> SUBMITTED
  OMSTUDIO_INGEST: 'omstudio_ingest', // external OMStudio status callback
  DRYRUN_SIM: 'dryrun_sim', // explicit operator-simulated decision (test-only)
});

// Sources that are considered "the Brain itself" and may NOT set externally-
// owned states.
const BRAIN_SOURCES = new Set([SOURCES.BRAIN_SUBMIT, 'brain', SOURCES.CREATE]);

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

function isValidState(state) {
  return Object.prototype.hasOwnProperty.call(STATES, state);
}

/**
 * Validate a proposed transition deterministically.
 *
 * @param {string} fromState
 * @param {string} toState
 * @param {string} source  one of SOURCES (or 'brain')
 * @returns {{ ok: boolean, reason: string }}
 */
function canTransition(fromState, toState, source) {
  if (!isValidState(fromState)) return { ok: false, reason: 'invalid_from_state' };
  if (!isValidState(toState)) return { ok: false, reason: 'invalid_to_state' };

  const allowed = TRANSITIONS[fromState];
  if (!allowed || !allowed.has(toState)) {
    return { ok: false, reason: `transition_not_allowed:${fromState}->${toState}` };
  }

  // Doctrine guard: APPROVED / REJECTED / EXPIRED must come from an external
  // source. The Brain can never self-approve or self-reject.
  if (EXTERNALLY_SET_STATES.has(toState) && BRAIN_SOURCES.has(source)) {
    return { ok: false, reason: `state_requires_external_source:${toState}` };
  }

  // SUBMITTED is the Brain's own action (it submits what it created).
  if (toState === STATES.SUBMITTED && source !== SOURCES.BRAIN_SUBMIT && source !== SOURCES.CREATE) {
    // allow external systems to also confirm submission, but normal path is brain_submit
  }

  return { ok: true, reason: 'ok' };
}

/**
 * Normalize an external OMStudio decision string to a target state.
 * @param {string} decision  e.g. 'approved' | 'rejected' | 'expired' | 'withdrawn'
 * @returns {string|null} a STATES value or null if unrecognized
 */
function mapExternalDecision(decision) {
  const d = String(decision || '').trim().toUpperCase();
  switch (d) {
    case 'APPROVE':
    case 'APPROVED':
      return STATES.APPROVED;
    case 'REJECT':
    case 'REJECTED':
    case 'DENY':
    case 'DENIED':
      return STATES.REJECTED;
    case 'EXPIRE':
    case 'EXPIRED':
      return STATES.EXPIRED;
    case 'WITHDRAW':
    case 'WITHDRAWN':
      return STATES.WITHDRAWN;
    default:
      return null;
  }
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  EXTERNALLY_SET_STATES,
  TRANSITIONS,
  SOURCES,
  BRAIN_SOURCES,
  isTerminal,
  isValidState,
  canTransition,
  mapExternalDecision,
};
