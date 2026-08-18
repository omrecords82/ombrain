# OMBrain Command Console

Dedicated operator UI for om-brain, hosted on om-dev (192.168.1.254).

## Architecture

- **UI + API proxy:** `om-brain-console` on `127.0.0.1:8392`
- **LAN edge:** nginx `http://192.168.1.254:8392` (192.168.1.0/24 only)
- **Upstream:** local om-brain `http://127.0.0.1:8390` (not via OMAI)

OMAI retains a link only — the full console no longer runs on .239.

## Auth model

1. **Primary:** nginx subnet allowlist (`192.168.1.0/24` + loopback)
2. **Optional:** `CONSOLE_AUTH_TOKEN` in `/etc/om-brain/console.env`
   - When set, all `/api/brain/*` and SPA routes require `Authorization: Bearer <token>` or `X-Console-Token`
   - When unset, LAN trust applies (internal network only)

No public internet exposure. Browser never calls `127.0.0.1:8390` directly.

## Deploy

```bash
cd /var/www/omai/om-brain-console
bash deploy/deploy-to-254.sh
```

## Verify

```bash
curl -s http://192.168.1.254:8392/health
systemctl status om-brain-console
journalctl -u om-brain-console -n 30 --no-pager
```

## Development

```bash
npm install
npm install --prefix web
npm run dev   # server :8392 + vite :5173 with proxy
```
