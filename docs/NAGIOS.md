# Nagios as fleet monitoring source of truth

**Host:** `ops` / `192.168.1.40`  
**UI:** `http://192.168.1.40:8080/nagios4/`  
**JSON CGI (LAN, currently open):**  
- Hosts: `http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi?query=hostlist&details=true`  
- Services: `http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi?query=servicelist&details=true`  
- Objects: `http://192.168.1.40:8080/nagios4/cgi-bin/objectjson.cgi?query=hostlist`

Livestatus / NRPE were **not** exposed on `.40` at integration time (ports 6557/5666 closed). Prefer statusjson until livestatus is enabled.

## Why previous OMBrain host errors “disappeared”

Verified causes (all intentional, not silent healing of the underlying flap):

1. **OMAI stopped emitting inventory health transitions** unless `PLATFORM_INVENTORY_EMIT_HEALTH_EVENTS=true` (default off). The SSH/TCP probes from om-prod01 were the source of noisy `host.unreachable` / `host.recovered` rows.
2. **OMBrain drops residual inventory health events** when `BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true` (default on with Nagios SoT).
3. **Nagios adapter baselines on first poll** and only emits *transitions*. Hosts already DOWN at adapter start do not create events until they change state again.

Missing monitoring data must never be shown as Healthy — see `/status` → `nagios_monitoring.freshness`.

## Misleading path (retired)

```
OMAI platformInventory collectors (ssh/tcp-probe from om-prod01)
  → publishFleetTransitions → platform_events (host.unreachable / host.recovered)
  → OMBrain eventAdapter poll → event_memory → Command Console
```

Those probes flapped from the om-prod01 vantage even when hosts were reachable from om-dev (.254).

## Nagios-backed path

```
Nagios Core on ops (.40)
  → OMBrain nagiosAdapter (statusjson poll)
  → event_memory (source=nagios) + work_memory incidents (correlated)
  → /status.nagios_monitoring freshness
  → Command Console Operator Action Queue / Event Ledger
```

OMAI `platform_inventory` still powers the inventory API for ops UI metadata, but **must not** emit host reachability events (gated by `PLATFORM_INVENTORY_EMIT_HEALTH_EVENTS`, default off). OMBrain also drops residual `platform_inventory` host/health events when `BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true`.

## Incident correlation

- One `work_memory` incident per Nagios object (`host:…` / `service:…`).
- Bad transitions open or update the same incident (no duplicate incidents for repeated hard CRITICAL).
- Idempotent event keys (`idempotency_key`) prevent duplicate event rows for the same from→to transition.
- Recovery closes the incident only when Nagios reports verified OK/UP (`recovered_verified=true`).

## Enable on om-dev

```bash
# /etc/om-brain/om-brain.env
BRAIN_ENABLE_NAGIOS_ADAPTER=true
BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true
BRAIN_NAGIOS_STATUSJSON_URL=http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi
BRAIN_NAGIOS_STALE_MS=180000
```

## Rollback

1. Set `BRAIN_ENABLE_NAGIOS_ADAPTER=false` in `/etc/om-brain/om-brain.env`.
2. Optionally leave `BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true` so inventory flaps stay suppressed.
3. `sudo systemctl restart om-brain.service`.
4. Or restore prior release: `sudo /opt/om-brain/deploy/rollback.sh` (uses `/var/backups/om-brain/`).

Do **not** re-enable `PLATFORM_INVENTORY_EMIT_HEALTH_EVENTS` without an explicit owner decision — that recreates the flap storm.

## Status bitmasks (Core 4.x statusjson)

| Object  | OK/UP | Warning | Critical/Down | Unreachable/Unknown |
|---------|-------|---------|---------------|---------------------|
| Host    | 2     | —       | 4             | 8                   |
| Service | 2     | 4       | 16            | 8                   |

## Checks already in Nagios (sample)

| Host object           | Services                                      |
|-----------------------|-----------------------------------------------|
| host-192-168-1-239    | PING, OM HTTPS, OM API Health, OMAI           |
| host-192-168-1-242    | PING, OM Studio                               |
| host-192-168-1-251    | PING, OM Workshop HTTP                        |
| host-192-168-1-254    | PING, OMBrain, OMDev Web                      |
| Most LAN hosts        | PING only                                     |
| localhost (ops)       | Load, Users, HTTP, Disk, SSH, Swap, Processes |

## Follow-up checklist

1. Add service checks for Keycloak (.253:8080), MariaDB (.241:3306), FreeIPA (.252), NFS (.79:2049), Brain webhook (:8391), disk/memory/certs on app hosts.
2. Map Nagios host aliases to inventory names (`om-prod01`, `omstudio`, …) instead of `host-192-168-1-x`.
3. Secure statusjson (Basic auth / allowlist) and document credentials for adapters.
4. Optional: enable MK Livestatus and switch adapter off HTTP CGI.
5. Point OMAI Platform Status / Overview (already deprecated) at Nagios statusjson or deep-link the UI.
6. OMStudio / OM health widgets that still call `/api/platform/inventory` for reachability should consume Nagios instead.
7. Confirm Nagios notification commands/contacts are delivering (email/webhook) — UI checks alone are not notifications.
