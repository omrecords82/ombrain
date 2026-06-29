# getbrain — LAN bootstrap for the `ombrain` CLI

`getbrain` lets anyone on the internal network install and configure the
`ombrain` CLI from a single URL, without copying files by hand.

From a WSL or Linux workstation on **192.168.1.0/24**:

1. Open **`http://orthodoxmetrics.com/getbrain/`**
2. Enter the **shared bootstrap PIN**
3. Copy the one-line command it shows and run it:
   ```bash
   curl -fsSL "http://orthodoxmetrics.com/getbrain/bootstrap.sh?token=…" | sudo bash
   ```
4. Done — `ombrain` is installed and pre-pointed at the Brain:
   ```bash
   ombrain server status
   ombrain pascha 2026
   ombrain ask "what is theosis"
   ```

No internet, no SMS, no email gateway. The installed CLI talks to the Brain
over the LAN using the master/backup + port-pool registry
(`/etc/om-brain/ombrain.servers.json`, master `192.168.1.254`, pool `60000-62000`).

---

## Security model

`getbrain` grants Brain access, so it is gated two ways:

1. **Subnet allowlist** — only client IPs in `GETBRAIN_ALLOW_CIDR`
   (default `192.168.1.0/24`) reach anything but a localhost health check. The
   nginx edge enforces the same subnet restriction.
2. **Shared PIN** — `POST /getbrain/install` checks `GETBRAIN_PIN`
   (constant-time compare). Wrong PINs are rate-limited per IP
   (`GETBRAIN_MAX_ATTEMPTS` per 15 min).

On a correct PIN the service issues a **short-lived, single-use, IP-bound token**
(`GETBRAIN_TOKEN_TTL_MS`, default 10 min). The token authorizes fetching
`bootstrap.sh`, which itself carries a fresh token to fetch the two installer
assets (`ombrain.js`, `install-ombrain.sh`). Tokens are in-memory and expire.

> The assets themselves are non-secret installer files; the PIN + subnet
> allowlist + short-lived tokens exist to keep casual/unauthorized installs out,
> not to protect file contents.

**Rotate the PIN** by editing `/etc/om-brain/getbrain.env` and
`systemctl restart getbrain`.

---

## Install on om-prod01 (.239)

```bash
cd /var/www/omai
sudo bash om-brain/getbrain/install-getbrain.sh --pin 'choose-a-strong-pin'
# then include the nginx snippet in the orthodoxmetrics.com server block:
#   include /etc/nginx/snippets/getbrain.conf;
sudo nginx -t && sudo systemctl reload nginx

# verify
curl -s http://127.0.0.1:8395/getbrain/health
```

The installer writes the systemd unit, seeds `/etc/om-brain/getbrain.env`
(if absent), and drops `/etc/nginx/snippets/getbrain.conf`. Re-running after a
deploy is safe (keeps the existing env/PIN).

### Files

| File | Purpose |
|------|---------|
| `server.js` | The zero-dependency bootstrap HTTP service |
| `getbrain.env.example` | Config template (PIN, allowlist, Brain endpoint) |
| `getbrain.service` | systemd unit |
| `getbrain-nginx.conf` | nginx `location /getbrain/` (subnet-restricted) |
| `install-getbrain.sh` | Idempotent installer for .239 |

---

## How the endpoint paths map

The service strips a leading `/getbrain` so it works behind the nginx
`location /getbrain/` proxy:

| Public URL | Method | Purpose |
|-----------|--------|---------|
| `/getbrain/` | GET | PIN form |
| `/getbrain/install` | POST | Verify PIN → issue token → show one-liner |
| `/getbrain/bootstrap.sh?token=` | GET | The `curl \| bash` script (token, single-use) |
| `/getbrain/ombrain.js?token=` | GET | CLI asset (token-gated) |
| `/getbrain/install-ombrain.sh?token=` | GET | Installer asset (token-gated) |
| `/getbrain/health` | GET | Health (localhost/subnet) |

---

## Server-side prerequisite (Brain LAN exposure)

For the installed `ombrain` to actually reach the Brain, the Brain must be
reachable on the LAN at the configured host/pool. Today the Brain binds
`127.0.0.1`. Expose it to the subnet (e.g. nginx on `192.168.1.254` proxying the
port pool, allow-listed to `192.168.1.0/24`) — see the handoff notes. `getbrain`
installs and configures the client either way; reachability is a separate
server-side step.
