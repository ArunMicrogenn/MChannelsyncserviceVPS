#!/usr/bin/env bash
set -euo pipefail

# M-Channel VPS Sync Installer (Ubuntu / Debian)
# Usage: bash install_vps.sh

DB_NAME="${PGDATABASE:-mchannel_pms_sync}"
DB_USER="${PGUSER:-mchannel_sync}"
DB_PASS="${PGPASSWORD:-$(node -e 'console.log(require("crypto").randomBytes(18).toString("hex"))' 2>/dev/null || openssl rand -hex 18)}"
ENC_KEY="${MCHANNEL_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
WEBHOOK_URL="${WEBHOOK_PUBLIC_URL:-https://sync.yourhotelpms.com}"

echo "=================================================="
echo " M-Channel -> PostgreSQL VPS Sync Service Setup"
echo "=================================================="

# 1. Verify / Install PostgreSQL
if ! command -v psql >/dev/null 2>&1; then
  echo "[1/5] Installing PostgreSQL..."
  sudo apt-get update -y
  sudo apt-get install -y postgresql postgresql-contrib
  sudo systemctl enable --now postgresql
else
  echo "[1/5] PostgreSQL already installed: $(psql --version)"
fi

# 2. Create PostgreSQL user & database idempotently
echo "[2/5] Creating PostgreSQL role '$DB_USER' and database '$DB_NAME'..."
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE $DB_USER WITH PASSWORD '$DB_PASS';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
fi

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
GRANT ALL ON SCHEMA public TO $DB_USER;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
SQL

# 3. Write .env
echo "[3/5] Generating .env configuration..."
cat > .env <<ENV
PORT=4000
WEBHOOK_PUBLIC_URL=$WEBHOOK_URL

PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=$DB_NAME
PGUSER=$DB_USER
PGPASSWORD=$DB_PASS
PGSSL=false

MCHANNEL_ENCRYPTION_KEY=$ENC_KEY

OUTBOX_INTERVAL_MS=5000
PULL_INTERVAL_MS=60000
ENV

# 4. Install dependencies, apply DDL schema, and compile TypeScript
echo "[4/5] Installing npm packages & applying PostgreSQL schema (sql/001_schema.sql)..."
npm install
npm run migrate
npm run build

# 5. Finish
echo "[5/5] Installation complete!"
echo ""
echo "Next steps:"
echo "  1) Update WEBHOOK_PUBLIC_URL in .env to your HTTPS domain (e.g. https://sync.yourdomain.com)"
echo "  2) Pair your hotel with your 30-min one-time M-Channel code:"
echo "     npm run pair -- --code MCH-XXXX-XXXX --env staging --hotel-id H001 --hotel-name \"My Hotel\""
echo "  3) Start the background sync daemon:"
echo "     pm2 start ecosystem.config.cjs && pm2 save"
echo "     # or systemd: sudo cp mchannel-sync.service /etc/systemd/system/ && sudo systemctl enable --now mchannel-sync"
