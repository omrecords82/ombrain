'use strict';

/**
 * System-truth seed facts (Spec v1.1 §5 "System-Truth Memory").
 *
 * A cached representation of verified architecture / routing / RBAC / action
 * catalog / tenant isolation / incident-tier facts distilled from the
 * implementation-truth attachments. Loaded into system_truth_memory at init-db.
 *
 * These are FACTS for recall, not authority — the deterministic rule engine
 * remains the authoritative gate.
 */

module.exports = [
  // architecture
  { domain: 'architecture', fact_key: 'host.om-primary', source_ref: '02-brain-architecture-server-map.md',
    body: 'om-primary 192.168.1.239: public HTTPS edge (nginx), OM SPA + API :3001, OMAI ops :7060, OCR worker. Production edge — NOT an inference host.' },
  { domain: 'architecture', fact_key: 'host.om-db', source_ref: '02-brain-architecture-server-map.md',
    body: 'om-db 192.168.1.241: dedicated MariaDB (orthodoxmetrics_db, omai_db, om_logging_db, om_church_* tenant DBs). Memory/IO sacred — exclude from inference.' },
  { domain: 'architecture', fact_key: 'host.omstudio', source_ref: '02-brain-architecture-server-map.md',
    body: 'omstudio-primary 192.168.1.242: OMStudio V2 planning/governance + local MariaDB omstudio_db. Brain memory/governance transplant target (Phase 2).' },
  { domain: 'architecture', fact_key: 'host.om-dev', source_ref: '02-brain-architecture-server-map.md',
    body: 'om-dev 192.168.1.254: OM Brain (:8390/:8391), Ollama inference, om-brain SQLite. Phase 1 PRIMARY inference host (30 vCPU / 53 GB RAM); inference MUST be isolated via systemd slice/cgroup with hard MemoryMax. NOT Keycloak — SSO is auth1/keycloak .253. DNS auth01 is FreeIPA .252, not this host.' },
  { domain: 'architecture', fact_key: 'host.auth1', source_ref: '02-brain-architecture-server-map.md',
    body: 'auth1 / keycloak 192.168.1.253: Keycloak SSO :8080 + PostgreSQL for OIDC realms orthodoxmetrics, omai, omstudio, workshop (Docker). Legacy inventory id auth0.' },
  { domain: 'architecture', fact_key: 'host.workshop', source_ref: '92-brain-hardware-confirmation-phase1.md',
    body: 'om-workshop 192.168.1.251: Workshop app, low coupling. Secondary/pilot inference host for 3B-4B models.' },

  // routing
  { domain: 'routing', fact_key: 'omai.platform', source_ref: '04-brain-routing-truth.md',
    body: 'OMAI ops APIs (/api/platform/*, /api/deploy-runs, /api/auto-repair/*, /api/admin/* OMAI, etc.) route to 127.0.0.1:7060 via nginx on .239. Public edge https://orthodoxmetrics.com.' },
  { domain: 'routing', fact_key: 'om.backend', source_ref: '04-brain-routing-truth.md',
    body: 'OM backend catch-all /api/* routes to 127.0.0.1:3001 (records, church, auth login/logout/check, billing, ocr). /ws/omai-logger and /socket.io route to :3001.' },
  { domain: 'routing', fact_key: 'maintenance.bypass', source_ref: '04-brain-routing-truth.md',
    body: 'maintenance.on at /var/www/orthodoxmetrics/maintenance.on rewrites SPA to maintenance.html EXCEPT OMAI ops paths (omai, ws/omai-logger, api/(omai|platform|deploy-runs|...)).' },

  // rbac
  { domain: 'rbac', fact_key: 'read.only.probes', source_ref: '05-brain-rbac-matrix.md',
    body: 'Read-only probes (inventory, deploy-runs, auto-repair findings) acceptable at admin role. Mutations require super_admin. OIDC realm grant != role elevation; always check users.role.' },
  { domain: 'rbac', fact_key: 'platform.actions', source_ref: '05-brain-rbac-matrix.md',
    body: '/api/platform/actions/* require super_admin. /api/deploy-runs read-only any authenticated. Brain never uses parish church_admin creds for platform actions.' },

  // action_catalog
  { domain: 'action_catalog', fact_key: 'auto.safe.codes', source_ref: '10-brain-action-catalog.md',
    body: 'Auto-repair safe codes ONLY: service_down -> service_restart (never orthodox-backend), stale_deploy_run -> reconcile_stale_deploy, stale_maintenance_flag -> remove_maintenance_flag.' },
  { domain: 'action_catalog', fact_key: 'never.auto', source_ref: '10-brain-action-catalog.md',
    body: 'Never auto: database backup/restore, NFS restore, change-set promote/hotfix, service stop/disable on required units, any confirm_production op.' },

  // tenant
  { domain: 'tenant', fact_key: 'isolation', source_ref: '08-brain-tenant-isolation.md',
    body: 'church_id (churches.id) + database_name (om_church_<id>) are the tenant keys. Never return one church records to another. Cross-tenant exposure = T0 incident — never auto-remediate.' },

  // incident
  { domain: 'incident', fact_key: 'tiers', source_ref: '16-brain-incident-tiers.md',
    body: 'T0 cross-tenant/auth-bypass/data-loss = none, stop+escalate. T1 prod down = scan+suggest, whitelisted repair only (never auto-restart orthodox-backend; never restart MariaDB .241). T2/T3 auto-repair safe codes OK. T4 read-only diagnostics.' },

  // env
  { domain: 'env', fact_key: 'never.log', source_ref: '09-brain-env-contract.md',
    body: 'Never-log: DB_PASSWORD, SESSION_SECRET, JWT_*_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, *_WEBHOOK_SECRET, GH_TOKEN, OMSTUDIO_SERVICE_TOKEN, OM_BUILD_EVENT_TOKEN, SMTP_PASSWORD, LOB_API_KEY, SSH private keys, Stripe PII.' },
];
