'use strict';

/**
 * Schema and safety validation for Teaching Agent skill/procedure proposals.
 * Rejects direct execution, shell, credentials, restart, DB mutation, deploy,
 * firewall, and cross-server actions unless explicitly human_gated_action.
 */

const { validateSkillScript, VALID_LANGUAGES, normalizeSkillKey, isValidSkillKey } = require('../skills/skillSafety');

const MANIFEST_TYPE = 'skill_proposal';
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'destructive']);
const VALID_CATEGORIES = new Set([
  'knowledge', 'diagnostic', 'ops', 'documentation', 'governance', 'proposal',
]);

/** Patterns that require human_gated_action or are always rejected */
const FORBIDDEN_ACTION_PATTERNS = [
  { re: /\b(shell|bash|sh\s+-c|exec\s|subprocess|child_process)\b/i, reason: 'direct_execution' },
  { re: /\bsystemctl\s+(restart|stop|start|reload|disable|mask)\b/i, reason: 'service_restart' },
  { re: /\b(deploy|rsync|git\s+push|om-deploy|omai-deploy)\b/i, reason: 'deploy' },
  { re: /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|INSERT\s+INTO|UPDATE\s+.*SET|DELETE\s+FROM|TRUNCATE)\b/i, reason: 'db_mutation' },
  { re: /\b(iptables|ufw|firewall-cmd|nft\s+add)\b/i, reason: 'firewall' },
  { re: /\b(credential|password|secret|api[_-]?key|token|\.env\b|vault)\b/i, reason: 'credential_access' },
  { re: /\b(fleet\s+scan|scan\s+all\s+hosts|cross[-_\s]?server|multi[-_\s]?host)\b/i, reason: 'cross_server' },
  { re: /\b(rm\s+-rf|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh)\b/i, reason: 'destructive_shell' },
];

const REQUIRED_MANIFEST_FIELDS = [
  'type', 'name', 'description', 'category', 'risk_level',
  'allowed_inputs', 'required_context', 'deterministic_steps',
  'model_advisory_steps', 'forbidden_actions', 'governance_required',
  'verification_steps', 'rollback_or_disable_plan',
];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isStepArray(v) {
  if (!Array.isArray(v)) return false;
  return v.every((step) => {
    if (typeof step === 'string') return step.trim().length > 0;
    return step && typeof step === 'object' && isNonEmptyString(step.action || step.step);
  });
}

/**
 * Validate manifest shape (structural schema).
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateManifestSchema(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest_required'], warnings: [] };
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null) {
      errors.push(`missing_field:${field}`);
    }
  }

  if (manifest.type !== MANIFEST_TYPE) {
    errors.push('invalid_type');
  }

  const name = normalizeSkillKey(manifest.name);
  if (!isValidSkillKey(name)) {
    errors.push('invalid_name');
  }

  if (!isNonEmptyString(manifest.description)) {
    errors.push('description_required');
  }

  if (!VALID_CATEGORIES.has(String(manifest.category || ''))) {
    errors.push('invalid_category');
  }

  if (!VALID_RISK_LEVELS.has(String(manifest.risk_level || ''))) {
    errors.push('invalid_risk_level');
  }

  if (!isStringArray(manifest.allowed_inputs)) errors.push('allowed_inputs_must_be_string_array');
  if (!isStringArray(manifest.required_context)) errors.push('required_context_must_be_string_array');
  if (!isStepArray(manifest.deterministic_steps)) errors.push('deterministic_steps_invalid');
  if (!isStepArray(manifest.model_advisory_steps)) errors.push('model_advisory_steps_invalid');
  if (!isStringArray(manifest.forbidden_actions)) errors.push('forbidden_actions_must_be_string_array');
  if (typeof manifest.governance_required !== 'boolean') errors.push('governance_required_must_be_boolean');
  if (!isStringArray(manifest.verification_steps)) errors.push('verification_steps_must_be_string_array');
  if (!isNonEmptyString(manifest.rollback_or_disable_plan)) errors.push('rollback_or_disable_plan_required');

  if (manifest.script_body != null) {
    const lang = String(manifest.language || '').toLowerCase();
    if (!VALID_LANGUAGES.has(lang)) {
      errors.push('invalid_language_for_script');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Scan manifest text fields for forbidden action patterns.
 * @returns {{ hits: Array<{ reason: string, field: string }>, human_gated_required: boolean }}
 */
function scanForbiddenActions(manifest) {
  const hits = [];
  const humanGated = !!manifest.human_gated_action;
  const textFields = [
    ['description', manifest.description],
    ['rollback_or_disable_plan', manifest.rollback_or_disable_plan],
    ...manifest.deterministic_steps.map((s, i) => [`deterministic_steps[${i}]`, typeof s === 'string' ? s : JSON.stringify(s)]),
    ...manifest.model_advisory_steps.map((s, i) => [`model_advisory_steps[${i}]`, typeof s === 'string' ? s : JSON.stringify(s)]),
    ...(manifest.script_body ? [['script_body', manifest.script_body]] : []),
  ];

  for (const [field, text] of textFields) {
    const blob = String(text || '');
    for (const { re, reason } of FORBIDDEN_ACTION_PATTERNS) {
      if (re.test(blob)) {
        hits.push({ reason, field });
      }
    }
  }

  const credentialHit = hits.some((h) => h.reason === 'credential_access');
  const crossServerHit = hits.some((h) => h.reason === 'cross_server');
  const executionHit = hits.some((h) =>
    ['direct_execution', 'destructive_shell', 'service_restart', 'deploy', 'db_mutation', 'firewall'].includes(h.reason),
  );

  const humanGatedRequired = credentialHit || crossServerHit || executionHit;

  return { hits, human_gated_required: humanGatedRequired, human_gated_declared: humanGated };
}

/**
 * Full manifest validation: schema + forbidden patterns + skillSafety for scripts.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], governance_required: boolean, human_gated_required: boolean }}
 */
function validateTeachingManifest(manifest) {
  const schema = validateManifestSchema(manifest);
  const errors = [...schema.errors];
  const warnings = [...schema.warnings];

  if (!schema.ok) {
    return {
      ok: false,
      errors,
      warnings,
      governance_required: true,
      human_gated_required: false,
    };
  }

  const scan = scanForbiddenActions(manifest);
  for (const hit of scan.hits) {
    if (scan.human_gated_declared && ['cross_server', 'credential_access'].includes(hit.reason)) {
      warnings.push(`human_gated:${hit.reason}:${hit.field}`);
      continue;
    }
    if (['direct_execution', 'destructive_shell', 'deploy', 'db_mutation', 'firewall'].includes(hit.reason)) {
      errors.push(`forbidden_action:${hit.reason}:${hit.field}`);
    } else if (hit.reason === 'credential_access' || hit.reason === 'cross_server') {
      if (!scan.human_gated_declared) {
        errors.push(`human_gated_required:${hit.reason}:${hit.field}`);
      } else {
        warnings.push(`human_gated:${hit.reason}:${hit.field}`);
      }
    } else if (hit.reason === 'service_restart') {
      errors.push(`forbidden_action:${hit.reason}:${hit.field}`);
    }
  }

  if (manifest.script_body) {
    const safety = validateSkillScript({
      script_body: manifest.script_body,
      language: manifest.language,
    });
    if (!safety.ok) {
      for (const e of safety.errors) errors.push(`skill_safety:${e}`);
    }
    for (const w of safety.warnings) warnings.push(`skill_safety:${w}`);
  }

  let governanceRequired = !!manifest.governance_required;
  const risk = String(manifest.risk_level);
  if (risk === 'medium' || risk === 'high' || risk === 'destructive') {
    governanceRequired = true;
  }
  if (scan.human_gated_required && !scan.human_gated_declared) {
    governanceRequired = true;
  }
  if (manifest.script_body) {
    governanceRequired = true;
  }

  if (governanceRequired && !manifest.governance_required) {
    warnings.push('governance_required_elevated');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    governance_required: governanceRequired,
    human_gated_required: scan.human_gated_required,
  };
}

/**
 * Validate teaching agent input contract.
 */
function validateTeachingInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['input_required'] };
  }
  if (!isNonEmptyString(input.source)) errors.push('source_required');
  if (!isNonEmptyString(input.goal)) errors.push('goal_required');
  if (input.risk_hint && !VALID_RISK_LEVELS.has(String(input.risk_hint))) {
    errors.push('invalid_risk_hint');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  MANIFEST_TYPE,
  VALID_RISK_LEVELS,
  VALID_CATEGORIES,
  FORBIDDEN_ACTION_PATTERNS,
  validateManifestSchema,
  scanForbiddenActions,
  validateTeachingManifest,
  validateTeachingInput,
  normalizeSkillKey,
  isValidSkillKey,
};
