'use strict';

/**
 * NATS fleet transport — stub for future multi-host dispatch.
 * Swap transport in dispatcher without changing operation model.
 */

function execute(_hostConfig, _handlerRef, _env = {}) {
  return Promise.reject(Object.assign(
    new Error('nats transport not implemented'),
    { code: 'nats_not_implemented' },
  ));
}

module.exports = { execute };
