'use strict';

/**
 * OrthodoxMetrics Brain — Phase 1 external substrate entrypoint.
 *
 * Wires config -> memory -> AI client -> orchestrator -> adapters -> HTTP API.
 * The Brain observes, analyzes, explains, and recommends. It NEVER executes
 * governed or never-auto actions.
 */

const { config } = require('./config');
const { MemoryDB } = require('./memory/db');
const { BrainAIClient } = require('./ai/client');
const { Orchestrator } = require('./orchestrator/orchestrator');
const { EventAdapter } = require('./adapters/eventAdapter');
const { InventoryAdapter } = require('./adapters/inventoryAdapter');
const { LogAdapter } = require('./adapters/logAdapter');
const { createServer } = require('./api/server');
const logger = require('./util/logger');

function main() {
  logger.info('brain_boot', {
    node_env: config.nodeEnv,
    llm_base_url_host: new URL(config.llm.baseUrl).host,
  });

  const db = new MemoryDB({ dbPath: config.memory.dbPath, embeddingDim: config.memory.embeddingDim }).init();
  logger.info('memory_backend', { backend: db.backendName() });

  const aiClient = new BrainAIClient();
  const orchestrator = new Orchestrator({ db, aiClient });

  // Read-only ingestion adapters (disabled by default via env).
  const eventAdapter = new EventAdapter({ db });
  const inventoryAdapter = new InventoryAdapter({ db });
  const logAdapter = new LogAdapter({ db });
  eventAdapter.start();
  inventoryAdapter.start();
  logAdapter.start();

  const app = createServer({ db, orchestrator });
  const server = app.listen(config.http.port, config.http.host, () => {
    logger.info('http_listening', { host: config.http.host, port: config.http.port });
  });

  const shutdown = () => {
    logger.info('brain_shutdown');
    eventAdapter.stop();
    inventoryAdapter.stop();
    logAdapter.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { main };
