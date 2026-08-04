# Nagios as fleet monitoring source of truth

**Host:** `ops` / `192.168.1.40`  
**UI:** `http://192.168.1.40:8080/nagios4/`  
**JSON CGI (LAN, currently open):**  
- Hosts: `http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi?query=hostlist&details=true`  
- Services: `http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi?query=servicelist&details=true`  
- Objects: `http://192.168.1.40:8080/nagios4/cgi-bin/objectjson.cgi?query=hostlist`

Livestatus / NRPE were **not** exposed on `.40` at integration time (ports 6557/5666 closed). Prefer statusjson until livestatus is enabled.

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
  → event_memory (source=nagios)
  → Command Console Operator Action Queue / Event Ledger
```

OMAI `platform_inventory` still powers the inventory API for ops UI metadata, but **must not** emit host reachability events (gated by `PLATFORM_INVENTORY_EMIT_HEALTH_EVENTS`, default off). OMBrain also drops residual `platform_inventory` host/health events when `BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true`.

## Enable on om-dev

```bash
# /etc/om-brain/om-brain.env
BRAIN_ENABLE_NAGIOS_ADAPTER=true
BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true
BRAIN_NAGIOS_STATUSJSON_URL=http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi
```

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

## Follow-up checklist

1. Add service checks for Keycloak (.253:8080), MariaDB (.241:3306), FreeIPA (.252), NFS (.79:2049), Brain webhook (:8391).
2. Map Nagios host aliases to inventory names (`om-prod01`, `omstudio`, …) instead of `host-192-168-1-x`.
3. Secure statusjson (Basic auth / allowlist) and document credentials for adapters.
4. Optional: enable MK Livestatus and switch adapter off HTTP CGI.
5. Point OMAI Platform Status / Overview (already deprecated) at Nagios statusjson or deep-link the UI.
6. OMStudio / OM health widgets that still call `/api/platform/inventory` for reachability should consume Nagios instead.
