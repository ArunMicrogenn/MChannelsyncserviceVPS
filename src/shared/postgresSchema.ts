export const POSTGRES_DDL_SQL = `-- M-Channel PMS Integration API (mchannel-v1, v1.3.0)
-- Production PostgreSQL Schema for Node.js Sync Service

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Paired Hotels & Encrypted Credentials (Section 2, 3.1, 4, 5, 6.3)
CREATE TABLE IF NOT EXISTS mchannel_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mchannel_property_id UUID NOT NULL UNIQUE,
  pms_hotel_id VARCHAR(100) NOT NULL,
  name VARCHAR(160) NOT NULL,
  code VARCHAR(32) NOT NULL DEFAULT '',
  environment VARCHAR(16) NOT NULL CHECK (environment IN ('staging', 'production', 'simulator')),
  base_url VARCHAR(255) NOT NULL,
  webhook_url VARCHAR(500) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('draft', 'syncing', 'live', 'paused')),
  ari_source VARCHAR(16) NOT NULL CHECK (ari_source IN ('pms', 'mchannel')),
  rate_source VARCHAR(16) NOT NULL CHECK (rate_source IN ('pms', 'mchannel')),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  api_key_enc TEXT NOT NULL,          -- AES-256-GCM ciphertext (never stored plaintext)
  webhook_secret_enc TEXT NOT NULL,   -- AES-256-GCM ciphertext (never stored plaintext)
  active_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Room Type & Rate Plan Mappings (Section 4, 5.2, 5.3, 5.4)
CREATE TABLE IF NOT EXISTS mchannel_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES mchannel_properties(mchannel_property_id) ON DELETE CASCADE,
  pms_room_type_ref VARCHAR(100) NOT NULL,
  pms_rate_plan_ref VARCHAR(100),
  room_type_id UUID NOT NULL,
  rate_plan_id UUID,
  room_type_name VARCHAR(160) NOT NULL DEFAULT '',
  rate_plan_name VARCHAR(160) NOT NULL DEFAULT '',
  sell_mode VARCHAR(16) NOT NULL DEFAULT 'per_room' CHECK (sell_mode IN ('per_room', 'per_person')),
  rate_mode VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (rate_mode IN ('manual', 'derived', 'cascade', 'auto')),
  count_of_rooms INTEGER NOT NULL DEFAULT 0 CHECK (count_of_rooms >= 0 AND count_of_rooms <= 5000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, pms_room_type_ref, pms_rate_plan_ref)
);

-- 3. Local PMS Room Availability & Rate Calendar (Section 6.1, 6.2)
CREATE TABLE IF NOT EXISTS pms_room_inventory (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES mchannel_properties(mchannel_property_id) ON DELETE CASCADE,
  pms_room_type_ref VARCHAR(100) NOT NULL,
  room_type_id UUID NOT NULL,
  rate_plan_id UUID,
  stay_date DATE NOT NULL,
  total_rooms INTEGER NOT NULL CHECK (total_rooms >= 0),
  booked_rooms INTEGER NOT NULL DEFAULT 0 CHECK (booked_rooms >= 0),
  free_rooms INTEGER GENERATED ALWAYS AS (GREATEST(total_rooms - booked_rooms, 0)) STORED,
  rate NUMERIC(12, 2),                -- Stored as exact decimal, serialized as string "2800.00"
  min_stay_arrival INTEGER CHECK (min_stay_arrival IS NULL OR min_stay_arrival >= 1),
  max_stay INTEGER CHECK (max_stay IS NULL OR max_stay >= 0),
  closed_to_arrival BOOLEAN NOT NULL DEFAULT FALSE,
  closed_to_departure BOOLEAN NOT NULL DEFAULT FALSE,
  stop_sell BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, pms_room_type_ref, stay_date)
);

-- 4. Idempotent ARI Outbox & Retry Queue (Section 3.5, 6)
CREATE TABLE IF NOT EXISTS ari_outbox (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES mchannel_properties(mchannel_property_id) ON DELETE CASCADE,
  idempotency_key VARCHAR(100) NOT NULL UNIQUE,
  sync_type VARCHAR(10) NOT NULL CHECK (sync_type IN ('delta', 'full')),
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'accepted', 'retry_scheduled', 'refused')),
  http_status INTEGER,
  batch_id UUID,
  accepted_items INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ari_outbox_retry ON ari_outbox (status, next_retry_at)
  WHERE status IN ('queued', 'retry_scheduled');

-- 5. Inbound Webhook Deduplication Store (Section 7.1, 7.2)
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES mchannel_properties(mchannel_property_id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  http_status INTEGER NOT NULL,
  timestamp_skew_seconds INTEGER NOT NULL DEFAULT 0,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. OTA Bookings, Revision Ordering & Acknowledgements (Section 7.3, 8.1, 8.2)
CREATE TABLE IF NOT EXISTS pms_bookings (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES mchannel_properties(mchannel_property_id) ON DELETE CASCADE,
  mchannel_booking_id UUID NOT NULL UNIQUE,
  revision_id UUID NOT NULL,
  revision_seq INTEGER NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('new', 'modified', 'cancelled')),
  ota_code VARCHAR(16) NOT NULL,
  ota_name VARCHAR(100) NOT NULL,
  ota_reservation_code VARCHAR(100) NOT NULL,
  unique_id VARCHAR(120) NOT NULL,
  arrival_date DATE NOT NULL,
  departure_date DATE NOT NULL,
  guest_name VARCHAR(160) NOT NULL DEFAULT '',
  guest_email VARCHAR(255),
  amount NUMERIC(12, 2) NOT NULL,
  currency CHAR(3) NOT NULL,
  pms_room_type_ref VARCHAR(100),
  pms_rate_plan_ref VARCHAR(100),
  is_unmapped BOOLEAN NOT NULL DEFAULT FALSE,
  ack_result VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (ack_result IN ('pending', 'imported', 'updated', 'cancelled', 'failed')),
  ack_failure_reason VARCHAR(500),
  pms_booking_id VARCHAR(100),
  pms_booking_no VARCHAR(100),
  acked_at TIMESTAMPTZ,
  raw_booking JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pms_bookings_unacked ON pms_bookings (property_id, ack_result)
  WHERE ack_result = 'pending';

-- 7. Stop Sales (Section 6.4)
CREATE TABLE IF NOT EXISTS mchannel_stop_sales (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES mchannel_properties(mchannel_property_id) ON DELETE CASCADE,
  stop_sale_id UUID NOT NULL UNIQUE,
  pms_room_type_ref VARCHAR(100),
  room_type_id UUID,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  otas TEXT NOT NULL DEFAULT 'all',
  reason VARCHAR(250) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL CHECK (status IN ('active', 'reopened')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Sync Audit Log (Section 9)
CREATE TABLE IF NOT EXISTS mchannel_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES mchannel_properties(mchannel_property_id) ON DELETE CASCADE,
  level VARCHAR(16) NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  kind VARCHAR(64) NOT NULL,
  message VARCHAR(500) NOT NULL,
  request_id VARCHAR(128),
  batch_id UUID,
  booking_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_property_time ON mchannel_sync_logs (property_id, created_at DESC);
`;
