#!/usr/bin/env bash
#
# provision-brain-ingest.sh — Fork A §7 dedicated read-only service account + JWT.
#
# Creates brain-ingest@orthodoxmetrics.com (role brain_ingest), mints a long-lived
# JWT, and optionally updates /etc/om-brain/om-brain.env on auth01.
#
# Run on OMAI host (.239) with DB + JWT env loaded:
#   set -a && source /var/www/omai/.env.omai && set +a
#   sudo -E om-brain/deploy/provision-brain-ingest.sh
#
# Options:
#   --update-auth01   SSH to auth01 and patch BRAIN_OPS_JWT (requires passwordless sudo there)
#   --dry-run         Print actions without writing
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER_DIR="${REPO_ROOT}/_runtime/server"

BRAIN_EMAIL="brain-ingest@orthodoxmetrics.com"
BRAIN_FIRST="Brain"
BRAIN_LAST="Ingest"
JWT_TTL_SECONDS="${BRAIN_JWT_TTL_SECONDS:-7776000}"  # 90 days
DRY_RUN=0
UPDATE_AUTH01=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --update-auth01) UPDATE_AUTH01=1 ;;
  esac
done

: "${DB_HOST:?DB_HOST required}"
: "${DB_USER:?DB_USER required}"
: "${DB_PASSWORD:?DB_PASSWORD required}"
: "${JWT_ACCESS_SECRET:?JWT_ACCESS_SECRET required}"

echo "[brain-ingest] applying SQL migrations"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[brain-ingest] dry-run: would apply brain_ingest role + build_run_id column"
else
  mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" orthodoxmetrics_db \
    < "${SERVER_DIR}/database/migrations/20260618_brain_ingest_role.sql"
  mysql -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" omai_db \
    < "${SERVER_DIR}/src/db/migrations/20260618_omd1354_deploy_runs_build_run_id.sql"
fi

echo "[brain-ingest] provisioning user + JWT via Node"
export BRAIN_EMAIL JWT_TTL_SECONDS EXPORT_UPDATE_AUTH01="$UPDATE_AUTH01" EXPORT_DRY_RUN="$DRY_RUN"
cd "${SERVER_DIR}"
node <<'NODE'
'use strict';
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const email = process.env.BRAIN_EMAIL || 'brain-ingest@orthodoxmetrics.com';
const ttl = parseInt(process.env.JWT_TTL_SECONDS || '7776000', 10);
const dryRun = process.env.EXPORT_DRY_RUN === '1';

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'orthodoxmetrics_db',
    connectionLimit: 2,
  });

  const [existing] = await pool.query(
    'SELECT id, email, role FROM users WHERE email = ? LIMIT 1',
    [email]
  );

  let userId;
  if (existing.length) {
    userId = existing[0].id;
    if (existing[0].role !== 'brain_ingest') {
      if (dryRun) {
        console.log(`[brain-ingest] dry-run: would set role brain_ingest for user ${userId}`);
      } else {
        await pool.query(
          "UPDATE users SET role = 'brain_ingest', is_active = 1 WHERE id = ?",
          [userId]
        );
      }
    }
  } else {
    const password = crypto.randomBytes(24).toString('base64url');
    const hash = await bcrypt.hash(password, 12);
    if (dryRun) {
      console.log('[brain-ingest] dry-run: would INSERT brain_ingest user');
      userId = 0;
    } else {
      const [res] = await pool.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, created_at)
         VALUES (?, ?, ?, ?, 'brain_ingest', 1, NOW())`,
        [email, hash, 'Brain', 'Ingest']
      );
      userId = res.insertId;
      console.log(`[brain-ingest] created user id=${userId} (password not stored — JWT-only)`);
    }
  }

  const tokenPayload = { userId, email, role: 'brain_ingest', churchId: null };
  const token = jwt.sign(tokenPayload, process.env.JWT_ACCESS_SECRET, { expiresIn: ttl });
  const redacted = token.slice(0, 12) + '…' + token.slice(-8);
  console.log(JSON.stringify({
    user_id: userId,
    email,
    role: 'brain_ingest',
    jwt_preview: redacted,
    expires_in_days: Math.round(ttl / 86400),
  }));

  if (dryRun) {
    await pool.end();
    return;
  }

  const outFile = '/tmp/brain-ingest-jwt.env';
  require('fs').writeFileSync(outFile, `BRAIN_OPS_JWT=${token}\n`, { mode: 0o600 });
  console.log(`[brain-ingest] wrote ${outFile} (mode 600)`);

  if (process.env.EXPORT_UPDATE_AUTH01 === '1') {
    const { execSync } = require('child_process');
    const jwtLine = require('fs').readFileSync(outFile, 'utf8').trim();
    execSync(
      `ssh -o BatchMode=yes next@192.168.1.254 'sudo bash -c \"` +
      `if grep -q ^BRAIN_OPS_JWT= /etc/om-brain/om-brain.env; then ` +
      `sed -i \\\"s|^BRAIN_OPS_JWT=.*|${jwtLine}|\\\" /etc/om-brain/om-brain.env; ` +
      `else echo \\\"${jwtLine}\\\" >> /etc/om-brain/om-brain.env; fi && ` +
      `systemctl restart om-brain.service\"'`,
      { stdio: 'inherit' }
    );
    console.log('[brain-ingest] updated auth01 /etc/om-brain/om-brain.env and restarted om-brain');
  }

  await pool.end();
}

main().catch((e) => {
  console.error('[brain-ingest] FAILED:', e.message);
  process.exit(1);
});
NODE

echo "[brain-ingest] done."
