'use strict';

/**
 * Built-in operation catalog — seeded into operation_registry on DB init.
 */

const BUILTIN_OPERATIONS = [
  {
    id: 'doc-registry-scan',
    title: 'Documentation registry scan',
    description: 'Scan fleet documentation paths, update doc_registry and DOC-SNAPSHOT',
    handler_ref: 'docRegistryScan',
    script_ref: 'scripts/scan-doc-registry.js',
  },
  {
    id: 'host-snapshot',
    title: 'Host inventory snapshot',
    description: 'DNS + TCP reachability check for declared hosts; writes HOST-SNAPSHOT.md',
    handler_ref: 'hostSnapshot',
    script_ref: 'scripts/collect-hosts.js',
  },
  {
    id: 'schema-snapshot',
    title: 'Database schema snapshot',
    description: 'Read-only dump of brain.db DDL and row counts to SCHEMA-SNAPSHOT.md',
    handler_ref: 'schemaSnapshot',
    script_ref: 'scripts/dump-schema.js',
  },
  {
    id: 'workshop.status@v1',
    title: 'Workshop status probe',
    description: 'Read-only GET of OM Workshop (.251) __server/status via WorkshopClient',
    handler_ref: 'workshopStatus',
    script_ref: null,
  },
  {
    id: 'fleet.find_env_files@v1',
    title: 'Fleet .env file location scan',
    description: 'Safe path-only scan for .env and .env.* under /var/www, /opt, /etc/omai on fleet hosts (never reads contents)',
    handler_ref: 'fleetFindEnvFiles',
    script_ref: 'scripts/fleet/handlers/find-env-files.sh',
    spawn_mode: 'fleet_ssh',
    transport: 'nats',
  },
];

function getBuiltinOperations() {
  return BUILTIN_OPERATIONS.map((o) => ({ ...o }));
}

function getBuiltinOperation(id) {
  return BUILTIN_OPERATIONS.find((o) => o.id === id) || null;
}

module.exports = {
  BUILTIN_OPERATIONS,
  getBuiltinOperations,
  getBuiltinOperation,
};
