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
const { createRagRetriever } = require('./memory/ragRetriever');
const { Orchestrator } = require('./orchestrator/orchestrator');
const { OmstudioClient } = require('./governance/omstudioClient');
const { GovernanceManager } = require('./governance/governanceManager');
const { EventAdapter } = require('./adapters/eventAdapter');
const { InventoryAdapter } = require('./adapters/inventoryAdapter');
const { LogAdapter } = require('./adapters/logAdapter');
const { AuditorLoop } = require('./auditor/auditorLoop');
const { CronManager } = require('./cron/cronManager');
const { QueryPipeline } = require('./queryPipeline/pipeline');
const { ChurchFinder } = require('./churchFinder');
const { BtwQueue } = require('./session/btwQueue');
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
  const ragRetriever = createRagRetriever({
    aiClient,
    liveEmbeddingsEnabled: config.learning.liveEmbeddingsEnabled,
    dim: config.memory.embeddingDim,
    logger,
  });

  const omstudio = new OmstudioClient({
    baseUrl: config.omstudio.governanceBaseUrl,
    serviceToken: config.omstudio.serviceToken,
    transport: config.omstudio.transport,
    outboxDir: config.omstudio.outboxDir,
    production: config.isProduction,
  });
  const governance = new GovernanceManager({ db, omstudio });
  logger.info('omstudio_governance', { transport: config.omstudio.transport });

  const orchestrator = new Orchestrator({ db, aiClient, governance, ragRetriever });

  const btwQueue = new BtwQueue({ db });
  orchestrator.btwQueue = btwQueue;

  const churchFinder = new ChurchFinder({
    db,
    proxyBaseUrl: process.env.OMAI_PROXY_URL || 'http://192.168.1.239:7060',
    serviceToken: config.omstudio.serviceToken,
  });

  const eventAdapter = new EventAdapter({ db });
  const inventoryAdapter = new InventoryAdapter({ db, governance });
  const logAdapter = new LogAdapter({ db });
  eventAdapter.start();
  inventoryAdapter.start();
  logAdapter.start();

  const auditor = new AuditorLoop({ db, orchestrator });
  auditor.start();

  const pipeline = new QueryPipeline({
    omstudioClient: omstudio,
    orchestrator: { ask: (q) => orchestrator.ask(q) },
    logger,
  });
  const cron = new CronManager({ pipeline });
  cron.start();

  const app = createServer({ db, orchestrator, governance, churchFinder, ragRetriever });
  const server = app.listen(config.http.port, config.http.host, () => {
    logger.info('http_listening', { host: config.http.host, port: config.http.port });
  });

  const shutdown = () => {
    logger.info('brain_shutdown');
    cron.stop();
    auditor.stop();
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
