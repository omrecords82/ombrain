'use strict';

/** Allowlisted om-dev resource check names (must match omdev-resource-check.sh). */
const ALLOWED_OMDEV_RESOURCE_CHECKS = Object.freeze([
  'root_disk',
  'inodes',
  'memory',
  'swap',
  'load',
  'om_brain_service',
  'om_brain_console_service',
  'nginx',
  'cert_expiry',
  'plans_mount',
]);

function isAllowlistedResourceCheck(name) {
  return ALLOWED_OMDEV_RESOURCE_CHECKS.includes(String(name || ''));
}

module.exports = {
  ALLOWED_OMDEV_RESOURCE_CHECKS,
  isAllowlistedResourceCheck,
};
