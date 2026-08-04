# Nagios as fleet monitoring source of truth

**Host:** `ops` / `192.168.1.40`  
**UI:** `http://192.168.1.40:8080/nagios4/`  
**JSON CGI:**  
- Preferred OMBrain path (authenticated local proxy on om-dev): `http://127.0.0.1:18080/nagios4/cgi-bin/statusjson.cgi`  
- Direct LAN URL (legacy / residual until ops-side auth applied): `http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi`

Livestatus / NRPE were **not** exposed on `.40` at integration time (ports 6557/5666 closed). Prefer statusjson until livestatus is enabled.

## Initial-state reconciliation

On the first successful poll after adapter start, OMBrain inspects hard state for all objects:

- Hosts already DOWN/UNREACHABLE → `host.unreachable` with `observation_origin=initial_reconciliation`, `transition_observed=false`, `synthetic=false`
- Services already CRITICAL/WARNING (non-PING) → `service.unhealthy` with the same metadata
- `previous_state` is `absent` (no fabricated prior OK)
- Idempotent fingerprints prevent duplicate events across adapter restarts
- Scheduled downtime suppresses *new* actionable incidents by default (`BRAIN_NAGIOS_RECONCILE_DOWNTIME_ACTIONABLE=false`)
- Acknowledgement state is preserved on the incident context
- UNKNOWN is not treated as confirmed healthy

Subsequent polls emit only real transitions.

## Canonical identity mapping

Single source: `inventory/hosts.json` via `resolveNagiosResourceIdentity`.

Incidents and payloads include `resource_identity` (`canonical_hostname`, `ip_address`, `role`, `mapping_status`, …). Unmapped Nagios objects remain visible with `mapping_status=unmapped`.

## Authentication

OMBrain supports Basic auth against statusjson:

- `BRAIN_NAGIOS_STATUS_USER`
- `BRAIN_NAGIOS_STATUS_PASSWORD_FILE` (preferred; never commit passwords)
- `BRAIN_NAGIOS_AUTH_REQUIRED=true` → fail closed (monitoring unavailable, not healthy)

Install the local proxy on om-dev:

```bash
sudo bash /opt/om-brain/deploy/nagios/scripts/install-status-proxy.sh
sudo systemctl restart om-brain.service
```

Ops-side Apache auth snippet (apply when SSH to `.40` is available):

`deploy/nagios/proxy/ops-apache-statusjson-auth.conf`

Credential ownership: om-brain service identity `ombrain-nagios-ro`; rotate by regenerating `/etc/om-brain/nagios-status.password` and matching htpasswd; restart om-brain.

## Synthetic fixtures

Objects/services whose names contain `fixture` / `OMBrain-Fixture` are marked `synthetic=true`, retained in the event ledger for audit, and excluded from production active CRITICAL/WARNING totals in `/status.nagios_monitoring`.

## Notification delivery status

`/status.nagios_monitoring.notification.status` is one of `unverified|verified|degraded|failed`. Update via env after a controlled test:

```bash
BRAIN_NAGIOS_NOTIFICATION_STATUS=degraded
BRAIN_NAGIOS_NOTIFICATION_LAST_TESTED_AT=...
BRAIN_NAGIOS_NOTIFICATION_DETAIL='...'
```

Do not treat configured contacts alone as proof of delivery.

## Coverage expansion (ops apply)

Service definitions for MariaDB, Keycloak, FreeIPA, NFS, OMBrain webhook, and disk checks:

`deploy/nagios/objects/ombrain-coverage.cfg`

Apply on ops, validate (`nagios4 -v`), reload. Requires SSH to `.40` and least-privilege DB monitor credentials for MariaDB.

## Misleading path (retired)

```
OMAI platformInventory collectors (ssh/tcp-probe from om-prod01)
  → platform_events (host.unreachable / host.recovered)
  → OMBrain eventAdapter poll
```

Gated off by `PLATFORM_INVENTORY_EMIT_HEALTH_EVENTS` (default false) and `BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true`.

## Nagios-backed path

```
Nagios Core on ops (.40)
  → (optional) authenticated local proxy on om-dev :18080
  → OMBrain nagiosAdapter
  → event_memory (source=nagios) + work_memory incidents
  → /status.nagios_monitoring
  → Command Console
```

## Incident correlation

- One `work_memory` incident per Nagios object (`host:…` / `service:…`).
- Bad observations open or update the same incident (no duplicates for repeated hard CRITICAL).
- Idempotent event keys prevent duplicate rows for the same fingerprint.
- Recovery closes only on verified Nagios OK/UP (`recovered_verified=true`).

## Enable on om-dev

```bash
# /etc/om-brain/om-brain.env
BRAIN_ENABLE_NAGIOS_ADAPTER=true
BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true
BRAIN_NAGIOS_STATUSJSON_URL=http://127.0.0.1:18080/nagios4/cgi-bin/statusjson.cgi
BRAIN_NAGIOS_STATUS_USER=ombrain-nagios-ro
BRAIN_NAGIOS_STATUS_PASSWORD_FILE=/etc/om-brain/nagios-status.password
BRAIN_NAGIOS_AUTH_REQUIRED=true
BRAIN_NAGIOS_STALE_MS=180000
```

## Rollback

1. Set `BRAIN_ENABLE_NAGIOS_ADAPTER=false` in `/etc/om-brain/om-brain.env`.
2. Optionally leave `BRAIN_SUPPRESS_INVENTORY_HEALTH_EVENTS=true`.
3. `sudo systemctl restart om-brain.service`.
4. Or restore prior release: `sudo /opt/om-brain/deploy/rollback.sh`.
5. To disable the local proxy only: remove nginx site `nagios-status-proxy` and point URL back to `.40:8080` (less preferred).

Do **not** re-enable `PLATFORM_INVENTORY_EMIT_HEALTH_EVENTS` without an explicit owner decision.

## Status bitmasks (Core 4.x statusjson)

| Object  | OK/UP | Warning | Critical/Down | Unreachable/Unknown |
|---------|-------|---------|---------------|---------------------|
| Host    | 2     | —       | 4             | 8                   |
| Service | 2     | 4       | 16            | 8                   |
