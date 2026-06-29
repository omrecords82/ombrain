'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_HOSTS_PATH = path.join(ROOT, 'inventory', 'hosts.json');

function loadHostsInventory(hostsPath = DEFAULT_HOSTS_PATH) {
  const raw = fs.readFileSync(hostsPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.hosts)) {
    throw new Error(`invalid hosts inventory: ${hostsPath}`);
  }
  return data;
}

function resolveHost(nameOrIp, hostsPath = DEFAULT_HOSTS_PATH) {
  const inv = loadHostsInventory(hostsPath);
  const needle = String(nameOrIp || '').trim().toLowerCase();
  if (!needle) return null;

  for (const host of inv.hosts) {
    const names = [host.name, ...(host.aliases || [])].map((n) => String(n).toLowerCase());
    if (names.includes(needle) || host.ip === nameOrIp) {
      return { ...host };
    }
  }
  return null;
}

function listHostNames(hostsPath = DEFAULT_HOSTS_PATH) {
  return loadHostsInventory(hostsPath).hosts.map((h) => h.name);
}

module.exports = {
  ROOT,
  DEFAULT_HOSTS_PATH,
  loadHostsInventory,
  resolveHost,
  listHostNames,
};
