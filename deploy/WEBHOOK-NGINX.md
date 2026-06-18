# om-brain webhook nginx — Fork A §4

Exposes om-brain governance webhook ingest to OMStudio (`.242`) without binding
om-brain HTTP on a public interface.

## Topology

```
OMStudio (.242)  --POST-->  auth01:8391 (nginx, IP allow-list)
                              |
                              v
                         127.0.0.1:8390 (om-brain.service)
```

| Path | Method | Upstream |
|------|--------|----------|
| `/health` | GET | `127.0.0.1:8390/health` |
| `/governance/approvals/:id/ingest-status` | POST | `127.0.0.1:8390` (same path) |

Only `192.168.1.242` is allowed. All other sources receive `403`.

## Install (auth01)

After `deploy/deploy.sh` has om-brain running on `:8390`:

```bash
sudo om-brain/deploy/install-webhook-nginx.sh
# or, from deployed tree:
sudo /opt/om-brain/deploy/install-webhook-nginx.sh
```

The script copies `om-brain-webhook.conf` to `/etc/nginx/sites-available/`,
symlinks into `sites-enabled`, runs `nginx -t`, reloads nginx, and curls
`http://127.0.0.1:8391/health`.

## Verify

```bash
# On auth01 — must succeed
curl -s http://127.0.0.1:8391/health | jq .

# Simulated ingest (dry-run governance mode)
curl -s -X POST http://127.0.0.1:8391/governance/approvals/1/ingest-status \
  -H 'Content-Type: application/json' \
  -d '{"decision":"approved","source":"dryrun_sim"}' | jq .

# From .242 — blocked until OMStudio Section 12 wires the outbound webhook
curl -s -o /dev/null -w "%{http_code}\n" http://192.168.1.254:8391/health
```

## Blocked until Manus (Section 12)

- OMStudio must POST approval decisions to  
  `http://192.168.1.254:8391/governance/approvals/:id/ingest-status`
- Do **not** flip `OMSTUDIO_TRANSPORT=http` until the live contract is confirmed.
- Firewall between `.242` and `.254:8391` must permit the webhook (nginx allow
  list is necessary but not sufficient if pfSense blocks the port).

## Logs

- `/var/log/nginx/om-brain-webhook.access.log`
- `/var/log/nginx/om-brain-webhook.error.log`

## Teardown

```bash
sudo rm -f /etc/nginx/sites-enabled/om-brain-webhook
sudo nginx -t && sudo systemctl reload nginx
```
