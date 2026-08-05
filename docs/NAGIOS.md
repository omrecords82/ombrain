# Nagios as fleet monitoring source of truth

**Host:** `ops` / `192.168.1.40`  
**UI:** `http://192.168.1.40:8080/nagios4/`  
**JSON CGI:**  
- Preferred OMBrain path (authenticated local proxy on om-dev): `http://127.0.0.1:18080/nagios4/cgi-bin/statusjson.cgi`  
- Direct ops URL (Basic auth required — identity `ombrain-nagios-ro`): `http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi`  
- UI (`/nagios4/`) remains LAN IP allowlisted; only `statusjson.cgi` / `objectjson.cgi` require Basic auth.

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

Ops-side Apache auth (applied on `.40` as `nagios4-statusjson-auth.conf`):

`deploy/nagios/proxy/ops-apache-statusjson-auth.conf`  
Password file on ops: `/etc/nagios4/passwd.ombrain-ro` (same secret as om-dev `/etc/om-brain/nagios-status.password`).

The local nginx proxy forwards `Authorization` upstream so OMBrain → proxy → ops stays authenticated end-to-end.

Credential ownership: om-brain service identity `ombrain-nagios-ro`; rotate by regenerating the password on om-dev **and** rewriting ops `passwd.ombrain-ro`, then restart om-brain / reload nginx+apache.

## Synthetic fixtures

Objects/services whose names contain `fixture` / `OMBrain-Fixture` are marked `synthetic=true`, retained in the event ledger for audit, and excluded from production active CRITICAL/WARNING totals in `/status.nagios_monitoring`.

## Notification delivery status

`/status.nagios_monitoring.notification` exposes evidence dimensions (never invent success):

| Field | Meaning |
|---|---|
| `command_execution` | Nagios decided to notify and ran the notification command |
| `local_sink` | Local audit receipt log accepted the event |
| `external_transport` | SMTP/msmtp (or other transport) accepted the message |
| `operator_receipt` | An operational human/system recipient confirmed receipt |
| `overall_status` | Aggregate readiness (`status` is a backward-compatible alias) |
| `last_tested_at` | ISO timestamp of the last controlled test |
| `test_reference` | Marker correlating the test (e.g. `OMBRAIN-SMTP-…`) |

Allowed values: `verified|degraded|failed|unconfigured|unverified`.

**Overall `verified` requires `operator_receipt=verified` and `external_transport=verified`.**  
Local receipt-log success alone is **`degraded`**, never `verified`.

```bash
BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION=verified
BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK=verified
BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT=verified
BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT=unverified   # set verified only after inbox confirmation
BRAIN_NAGIOS_NOTIFICATION_LAST_TESTED_AT=...
BRAIN_NAGIOS_NOTIFICATION_TEST_REFERENCE=OMBRAIN-...
BRAIN_NAGIOS_NOTIFICATION_DETAIL='...'
# Deprecated: BRAIN_NAGIOS_NOTIFICATION_STATUS — if set to verified without granular
# fields, OMBrain treats it as local-path success and clamps overall to degraded.
```

Do not treat configured contacts alone as proof of delivery.

### Ops notification path

- Local audit sink: `notify-*-by-receipt` → `/var/log/nagios4/notification-receipt.log`.
- External transport: `msmtp` system account (`/etc/msmtprc`) when mail notify commands are enabled; transport acceptance ≠ operator receipt.
- `cmd.cgi` requires Digest auth (`nagiosadmin` in `/etc/nagios4/htdigest.users`; password file `/etc/nagios4/cmd-cgi.password`). CSRF stays fail-closed: GET form for `NagFormId` cookie + POST `nagFormId`.
- CGI `use_authentication=1` with `default_user_name=guest` (read-only). `ombrain-nagios-ro` is authorized for host/service reads so statusjson keeps working.
- Safe tests: `SEND_CUSTOM_SVC_NOTIFICATION` via `nagios.cmd`, or authenticated CSRF `cmd.cgi` custom notification.

### cmd.cgi security boundary

| Control | Expected state |
|---|---|
| Authentication | Digest `Require valid-user` on `cmd.cgi` |
| CSRF | `cgi_cookie_fail_open=0` (fail-closed) |
| Encryption | HTTP on LAN `:8080` — Digest over cleartext LAN; restrict to private networks or add TLS |
| Network | Apache `Require ip` private ranges for CGI UI |
| Password files | `htdigest.users` / `cmd-cgi.password` mode `640` root:www-data |
| Public exposure | Must remain non-public (no Internet publish) |

## Host naming

Nagios host objects use inventory names (`om-dev`, `om-prod01`, `keycloak`, …).  
Definitions live in `deploy/nagios/objects/omai-ping.cfg` and `om-services.cfg`.  
Unmapped IPs `.233` / `.234` keep `host-192-168-1-*` until declared in `inventory/hosts.json`.

OMBrain resolves IPs via `resolveNagiosHostIp` (pattern `host-A-B-C-D` **or** inventory name lookup).

## Coverage expansion (ops apply)

Service definitions for MariaDB TCP, Keycloak HTTP, FreeIPA HTTPS, Samba/CIFS TCP, OMBrain webhook:

`deploy/nagios/objects/ombrain-coverage.cfg` (+ host/service defs above)

Validate with `sudo /usr/sbin/nagios4 -v /etc/nagios4/nagios.cfg` then `sudo systemctl reload nagios4`.

Notes:
- MariaDB (`om-dbp01` / `.241`) uses authenticated `check_mysql` via ops-private `/etc/nagios4/mysql-monitor.cnf` (user `nagios_monitor@192.168.1.40`). Prefer minimum privileges (USAGE-equivalent connect; retain `PROCESS` only if the plugin requires it). Do not commit the password; `$USER3$`/`$USER4$` also hold the same identity in `resource.cfg` (mode `640` root:nagios).
- om-sh1 (`.79`) is the backup QNAP (Samba/CIFS only; no NFS). Coverage checks TCP `:445` and `:139`.
- fileserver01 (`.232`) hosts the shared **plans** CIFS share. Server-side: TCP `:445` + authenticated `check-plans-smb.sh` (creds in `/etc/nagios4/smb-plans.cred`). Client-side: om-dev `Plans CIFS Mount` via constrained SSH resource check. NFS `:2049` is not a plans dependency (connection refused).
- om-dev host resources use `deploy/nagios/objects/omdev-resources.cfg` + ForceCommand SSH (`id_omdev_checks`). Allowlisted checks only — not fleet-wide in this batch.
- Webhook `/health` allowlists ops `.40` (plus localhost and OMStudio `.242`).
- NRPE is not required for the om-dev constrained pattern.

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
- After Nagios host rename or service object removal, old object keys will not receive a recovery transition. Close superseded/removed open incidents with operator hygiene (does not invent SoT recovery):

```bash
sudo -u om-brain cp /var/lib/om-brain/brain.db \
  /var/lib/om-brain/brain.db.pre-incident-hygiene-$(date -u +%Y%m%dT%H%M%SZ)
sudo -u om-brain node /opt/om-brain/scripts/reconcile-stale-nagios-incidents.js --dry-run
sudo -u om-brain node /opt/om-brain/scripts/reconcile-stale-nagios-incidents.js --apply-defaults
```

Keep real current problems on the renamed hosts and other live WARNING/CRITICAL objects.

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
