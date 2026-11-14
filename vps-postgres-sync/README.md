# M-Channel VPS Standalone Sync Service (Node.js + PostgreSQL)

Standalone bidirectional synchronization daemon implementing **M-Channel PMS Integration API v1.3.0** directly against PostgreSQL:

1. **Inbound Bookings (`M-Channel -> PostgreSQL`)**:
   - Exposes `POST /api/v1/mchannel/webhook/:propertyId` with raw-body `HMAC-SHA256` signature verification and 300s timestamp skew protection.
   - Deduplicates webhook events on `event_id` in `webhook_events`.
   - Runs a periodic pull fallback (`GET /api/v1/properties/:id/bookings?only_unacked=true`) on startup and every `PULL_INTERVAL_MS` (default 60s).
   - Inserts bookings into `pms_bookings` inside an ACID transaction (`SELECT ... FOR UPDATE` on `pms_room_inventory`), enforces `revision_seq` ordering, updates `booked_rooms`, and immediately sends `POST /api/v1/bookings/:id/ack` (`imported`, `updated`, `cancelled`, or `failed` with `failure_reason`).

2. **Outbound Room Inventory (`PostgreSQL -> M-Channel`)**:
   - Any `INSERT` or `UPDATE` to `pms_room_inventory` from your PMS software triggers `trg_mchannel_inventory_change`, setting `needs_sync = TRUE` and firing `NOTIFY mchannel_inventory_changed`.
   - The daemon wakes up immediately via `LISTEN`, batches dirty rows into `ari_outbox` with a unique `idempotency_key`, enforces Section 6.3 (`ari_source`, `rate_source`, `rate_mode`), and pushes `POST /api/v1/properties/:id/ari`.
   - Retries `0` / `429` / `500` / `502` using the exact same `idempotency_key`; refuses `409` / `422` without retry.

## Option A: One-Command Automated VPS Install (Ubuntu / Debian)

```bash
cd vps-postgres-sync
WEBHOOK_PUBLIC_URL=https://sync.yourhotelpms.com bash install_vps.sh
```

This script installs PostgreSQL (if missing), creates the `mchannel_sync` role & `mchannel_pms_sync` database, generates `.env` with a fresh 32-byte `MCHANNEL_ENCRYPTION_KEY`, runs `npm install`, applies `sql/001_schema.sql`, and compiles `dist/index.js`.

## Option B: Manual PostgreSQL & Service Setup

```bash
# 1. Install PostgreSQL & create role + database
sudo apt-get update && sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
sudo -u postgres psql -f sql/000_create_database.sql

# 2. Configure environment
cd vps-postgres-sync
cp .env.example .env
# Edit .env: set PGPASSWORD, WEBHOOK_PUBLIC_URL, and generate 64-char MCHANNEL_ENCRYPTION_KEY:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Install dependencies, create 8 tables + NOTIFY trigger, pair hotel & build
npm install
npm run migrate
npm run pair -- --code MCH-7F3K-92QD --env staging --hotel-id H001 --hotel-name "Hotel Example"
npm run build

# 4. Run 24/7 with PM2 (or systemd)
pm2 start ecosystem.config.cjs
pm2 save
# Or systemd:
sudo cp mchannel-sync.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mchannel-sync
```
