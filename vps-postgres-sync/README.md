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

## Quick VPS Setup

```bash
cd vps-postgres-sync
cp .env.example .env
# Edit .env with your PostgreSQL credentials, MCHANNEL_ENCRYPTION_KEY, and public HTTPS domain

npm install
npm run migrate
npm run pair -- --code MCH-7F3K-92QD --env staging --hotel-id H001 --hotel-name "Hotel Example"
npm run build

# Run with PM2 (or install mchannel-sync.service in /etc/systemd/system/)
pm2 start ecosystem.config.cjs
pm2 save
```
