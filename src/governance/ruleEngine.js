'use strict';

/**
 * Deterministic governance / rule engine (Spec v1.1 §3, §8; Annex A §B.1).
 *
 * AUTHORITATIVE, pure code, fully unit-tested. The LLM advisory output may be
 * attached as a secondary note but can NEVER override these rules:
 *   - a model "No" cannot clear a gate
 *   - a model "Yes" cannot trigger an action
 *
 * Exposed functions:
 *   - classifyChange(proposal) → human-only domain detection
 *   - isAutoSafe(action)       → only the three documented safe actions are true
 *   - tenantGuard(context)     → cross-tenant detection → Tier 0 halt-and-escalate
 *   - evaluate(proposal,ctx)   → combined deterministic verdict
 */

// ---------------------------------------------------------------------------
// Human-only domains (RULE authority.human_only_domains). Each domain has
// keyword and structural matchers. Detection is by keyword + structure, never
// by the model.
// ---------------------------------------------------------------------------
const HUMAN_ONLY_DOMAINS = [
  {
    domain: 'schema',
    rule: 'authority.human_only_domains#schema',
    keywords: [
      /\bschema\b/i, /\bmigration\b/i, /\balter\s+table\b/i, /\bcreate\s+table\b/i,
      /\bdrop\s+table\b/i, /\bddl\b/i, /\badd\s+column\b/i, /\bdrop\s+column\b/i,
    ],
  },
  {
    domain: 'routing',
    rule: 'authority.human_only_domains#routing',
    keywords: [
      /\bnginx\b/i, /\brouting\b/i, /\broute\b/i, /\blocation\s+\^?~/i,
      /\bproxy_pass\b/i, /\breverse\s+proxy\b/i, /\bedge\b/i, /\bsites-available\b/i,
    ],
  },
  {
    domain: 'auth',
    rule: 'authority.human_only_domains#auth',
    keywords: [
      /\bauthentication\b/i, /\bauth\b/i, /\bsession\b/i, /\bkeycloak\b/i,
      /\boidc\b/i, /\brealm\b/i, /\blogin\b/i, /\bsso\b/i, /\bcookie\b/i,
    ],
  },
  {
    domain: 'billing',
    rule: 'authority.human_only_domains#billing',
    keywords: [/\bbilling\b/i, /\bstripe\b/i, /\binvoice\b/i, /\bpayment\b/i, /\bprice_id\b/i, /\bwebhook\b/i],
  },
  {
    domain: 'permissions',
    rule: 'authority.human_only_domains#permissions',
    keywords: [/\bpermission/i, /\brbac\b/i, /\brole\b/i, /\bgrant\b/i, /\brequirerole\b/i, /\bprivilege/i, /\bsuper_admin\b/i],
  },
  {
    domain: 'secrets',
    rule: 'authority.human_only_domains#secrets',
    keywords: [/\bsecret/i, /\bpassword/i, /\bjwt\b/i, /\bkey\s+rotation\b/i, /\brotate\b/i, /\bcredential/i, /\btoken\b/i],
  },
  {
    domain: 'substrate',
    rule: 'authority.human_only_domains#substrate',
    keywords: [/\bmanifest\b/i, /\bregistry\b/i, /\bsubstrate\b/i, /\becosystem-config\b/i, /\binfrastructure\b/i, /\bcomponent\s+boundary\b/i],
  },
  {
    domain: 'data_deletion',
    rule: 'authority.human_only_domains#data_deletion',
    keywords: [/\bdelete\b/i, /\bdrop\b/i, /\btruncate\b/i, /\bpurge\b/i, /\bremove\s+data\b/i, /\bdecommission\b/i],
  },
  {
    domain: 'cross_system',
    rule: 'authority.human_only_domains#cross_system',
    keywords: [
      /\bcross[-_\s]?system\b/i, /\bom\s*<?->?\s*omai\b/i, /\bomai\s*<?->?\s*omstudio\b/i,
      /\bomstudio\b.*\bom\b/i,
    ],
  },
];

// The ONLY three auto-safe actions (RULE authority.auto_safe_allowed).
// service_restart EXCLUDES the main OM backend.
const AUTO_SAFE_ACTIONS = new Set([
  'service_restart',
  'reconcile_stale_deploy',
  'remove_maintenance_flag',
]);

const OM_BACKEND_UNITS = new Set(['orthodox-backend', 'om-backend']);

// Never-auto actions (RULE authority.never_auto_actions).
// Note: \b in JS regex treats '_' as a word char, so 'database_backup' has no
// word boundary before 'backup'. Use (^|[^a-z]) style sub-token matching so
// underscore-delimited action ids (database_backup, nfs_restore, service_stop)
// are caught.
const NEVER_AUTO_PATTERNS = [
  /(^|[^a-z])backup([^a-z]|$)/i,
  /(^|[^a-z])restore([^a-z]|$)/i,
  /(^|[^a-z])promote([^a-z]|$)/i,
  /(^|[^a-z])hotfix([^a-z]|$)/i,
  /(^|[^a-z])stop([^a-z]|$)/i,
  /(^|[^a-z])disable([^a-z]|$)/i,
  /(^|[^a-z])purge([^a-z]|$)/i,
  /confirm_production/i,
  /(^|[^a-z])ssh[-_]?keys?([^a-z]|$)/i,
];

/**
 * Flatten a proposal into a single searchable text blob, including structured
 * fields so structure-based hints (e.g., proposal.domain, proposal.target) are
 * considered, not only free text.
 */
function proposalText(proposal) {
  if (proposal == null) return '';
  if (typeof proposal === 'string') return proposal;
  try {
    return JSON.stringify(proposal);
  } catch (_) {
    return String(proposal);
  }
}

/**
 * classifyChange — does the proposal touch a human-only domain?
 * @returns {{
 *   humanOnly: boolean,
 *   domains: string[],
 *   matchedRules: string[],
 *   classification: string,
 *   requiresOmstudio: boolean,
 *   note: string
 * }}
 */
function classifyChange(proposal) {
  const text = proposalText(proposal);

  // Structural hint: an explicit domain field is honored directly.
  const explicitDomain =
    proposal && typeof proposal === 'object' && typeof proposal.domain === 'string'
      ? proposal.domain.toLowerCase()
      : null;

  const domains = [];
  const matchedRules = [];

  for (const d of HUMAN_ONLY_DOMAINS) {
    const byKeyword = d.keywords.some((re) => re.test(text));
    const byStructure = explicitDomain && explicitDomain.includes(d.domain.split('_')[0]);
    if (byKeyword || byStructure) {
      domains.push(d.domain);
      matchedRules.push(d.rule);
    }
  }

  const humanOnly = domains.length > 0;
  return {
    humanOnly,
    domains,
    matchedRules,
    classification: humanOnly ? 'requires_human_superadmin' : 'within_phase1_authority',
    requiresOmstudio: humanOnly,
    note: humanOnly
      ? 'requires human superadmin approval via OMStudio'
      : 'no human-only domain detected by deterministic engine',
  };
}

/**
 * isAutoSafe — only the three documented safe actions return true; everything
 * else false. service_restart on the OM backend is NOT auto-safe.
 *
 * @param {string|object} action  action id or { action, target }
 */
function isAutoSafe(action) {
  let id;
  let target;
  if (action && typeof action === 'object') {
    id = String(action.action || action.id || '').trim();
    target = String(action.target || action.unit || action.service || '').trim();
  } else {
    id = String(action || '').trim();
  }

  if (!AUTO_SAFE_ACTIONS.has(id)) return false;

  if (id === 'service_restart') {
    // Never auto-safe for the main OM backend self-restart path.
    if (target && OM_BACKEND_UNITS.has(target.toLowerCase())) return false;
  }
  return true;
}

/**
 * isNeverAuto — does the action match a never-auto pattern?
 */
function isNeverAuto(action) {
  const id = typeof action === 'object' && action ? String(action.action || action.id || '') : String(action || '');
  return NEVER_AUTO_PATTERNS.some((re) => re.test(id));
}

/**
 * tenantGuard — detect cross-tenant access patterns → Tier 0 halt-and-escalate.
 *
 * Triggers when more than one distinct church_id / om_church_* tenant appears in
 * the same context, or when a tenant-scoped read crosses a session's church
 * (sessionChurchId vs accessedChurchId mismatch), or an explicit
 * crossTenant=true flag.
 *
 * @param {object} context
 * @returns {{ crossTenant: boolean, tier: string|null, action: string|null,
 *             rule: string, detail: string, tenants: string[] }}
 */
function tenantGuard(context) {
  const tenants = new Set();
  const ctx = context || {};

  // Normalize all tenant references to a canonical numeric/string id so that
  // 'om_church_46' and church_id=46 are recognized as the SAME tenant and do not
  // produce a false cross-tenant positive.
  const norm = (raw) => {
    const s = String(raw).toLowerCase();
    const m = s.match(/om_church_(\w+)/);
    if (m) return 'cid:' + m[1];
    return 'cid:' + s;
  };

  const blob = proposalText(ctx);
  const matches = blob.match(/om_church_\w+/gi) || [];
  for (const m of matches) tenants.add(norm(m));

  // Collect explicit church_id values anywhere in the structure.
  const collectIds = (val) => {
    if (val == null) return;
    if (Array.isArray(val)) return val.forEach(collectIds);
    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (/church_?id/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
          tenants.add(norm(v));
        }
        collectIds(v);
      }
    }
  };
  collectIds(ctx);

  const sessionChurch = ctx.sessionChurchId != null ? norm(ctx.sessionChurchId) : null;
  const accessedChurch = ctx.accessedChurchId != null ? norm(ctx.accessedChurchId) : null;

  let crossTenant = false;
  let detail = '';

  if (ctx.crossTenant === true) {
    crossTenant = true;
    detail = 'explicit crossTenant flag set';
  } else if (sessionChurch && accessedChurch && sessionChurch !== accessedChurch) {
    crossTenant = true;
    detail = 'session church does not match accessed church';
  } else if (tenants.size > 1) {
    crossTenant = true;
    detail = 'multiple distinct tenant identifiers present in one context';
  }

  if (crossTenant) {
    return {
      crossTenant: true,
      tier: 'T0',
      action: 'halt_and_escalate',
      rule: 'tenant.sanctity',
      detail,
      tenants: Array.from(tenants),
    };
  }
  return {
    crossTenant: false,
    tier: null,
    action: null,
    rule: 'tenant.sanctity',
    detail: 'no cross-tenant pattern detected',
    tenants: Array.from(tenants),
  };
}

/**
 * evaluate — combined deterministic verdict for a proposal + context.
 * Order of precedence (highest first):
 *   1. tenant cross-exposure → Tier 0 halt-and-escalate
 *   2. never-auto action      → never_auto (requires human; never executed)
 *   3. human-only domain      → requires_human_superadmin (via OMStudio)
 *   4. auto-safe action       → auto_safe_recommendation (recommend only)
 *   5. otherwise              → informational
 *
 * The model advisory (if supplied) is attached but NEVER changes the verdict.
 */
function evaluate(proposal, context = {}, modelAdvisory = null) {
  const tenant = tenantGuard(Object.assign({}, context, { _proposal: proposal }));
  if (tenant.crossTenant) {
    return {
      classification: 'tier0_halt_escalate',
      requiresOmstudio: true,
      doctrineRule: tenant.rule,
      domains: [],
      tenant,
      autoSafe: false,
      neverAuto: false,
      modelAdvisory,
      modelAdvisoryAuthoritative: false,
      note: 'Tier 0 cross-tenant exposure — halt and escalate. Never auto-remediate.',
    };
  }

  const action = (proposal && typeof proposal === 'object' && (proposal.action || proposal.id)) || proposal;

  if (isNeverAuto(action)) {
    return {
      classification: 'never_auto',
      requiresOmstudio: true,
      doctrineRule: 'authority.never_auto_actions',
      domains: classifyChange(proposal).domains,
      tenant,
      autoSafe: false,
      neverAuto: true,
      modelAdvisory,
      modelAdvisoryAuthoritative: false,
      note: 'Never-auto action. The Brain may explain/recommend escalation only; it will not execute.',
    };
  }

  const change = classifyChange(proposal);
  if (change.humanOnly) {
    return {
      classification: 'requires_human_superadmin',
      requiresOmstudio: true,
      doctrineRule: change.matchedRules[0] || 'authority.human_only_domains',
      domains: change.domains,
      tenant,
      autoSafe: false,
      neverAuto: false,
      modelAdvisory,
      modelAdvisoryAuthoritative: false,
      note: change.note,
    };
  }

  if (isAutoSafe(action)) {
    return {
      classification: 'auto_safe_recommendation',
      requiresOmstudio: false,
      doctrineRule: 'authority.auto_safe_allowed',
      domains: [],
      tenant,
      autoSafe: true,
      neverAuto: false,
      modelAdvisory,
      modelAdvisoryAuthoritative: false,
      note: 'Documented safe action — presented as a RECOMMENDATION only. The Brain does not execute it.',
    };
  }

  return {
    classification: 'informational',
    requiresOmstudio: false,
    doctrineRule: 'doctrine.posture.auditor_first',
    domains: [],
    tenant,
    autoSafe: false,
    neverAuto: false,
    modelAdvisory,
    modelAdvisoryAuthoritative: false,
    note: 'No gate triggered. Observe / analyze / explain only.',
  };
}

module.exports = {
  HUMAN_ONLY_DOMAINS,
  AUTO_SAFE_ACTIONS,
  OM_BACKEND_UNITS,
  classifyChange,
  isAutoSafe,
  isNeverAuto,
  tenantGuard,
  evaluate,
};
