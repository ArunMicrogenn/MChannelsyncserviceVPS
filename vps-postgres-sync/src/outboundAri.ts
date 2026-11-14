import crypto from 'node:crypto';
import { pool, withTransaction, logSyncEvent } from './db.js';
import { decryptSecret } from './crypto.js';
import { mchannelRequest } from './mchannel.js';

export async function enqueueDirtyInventory(propertyFilter?: string) {
  const propsRes = await pool.query<{
    mchannel_property_id: string;
    code: string;
    ari_source: 'pms' | 'mchannel';
    rate_source: 'pms' | 'mchannel';
  }>(
    `SELECT mchannel_property_id, code, ari_source, rate_source
     FROM mchannel_properties
     WHERE status IN ('live', 'syncing')
       AND ($1::uuid IS NULL OR mchannel_property_id = $1::uuid)`,
    [propertyFilter ?? null]
  );

  for (const prop of propsRes.rows) {
    await withTransaction(async (client) => {
      const dirtyRes = await client.query<{
        id: number;
        room_type_id: string;
        rate_plan_id: string | null;
        stay_date: string;
        free_rooms: number;
        rate: string | null;
        min_stay_arrival: number | null;
        max_stay: number | null;
        closed_to_arrival: boolean;
        closed_to_departure: boolean;
        stop_sell: boolean;
      }>(
        `SELECT id, room_type_id, rate_plan_id, to_char(stay_date, 'YYYY-MM-DD') AS stay_date,
                free_rooms, rate::text, min_stay_arrival, max_stay,
                closed_to_arrival, closed_to_departure, stop_sell
         FROM pms_room_inventory
         WHERE property_id = $1
           AND needs_sync = TRUE
           AND stay_date >= CURRENT_DATE
         ORDER BY stay_date ASC
         LIMIT 500
         FOR UPDATE SKIP LOCKED`,
        [prop.mchannel_property_id]
      );

      if (dirtyRes.rows.length === 0) return;

      const mappingRes = await client.query<{ rate_plan_id: string; rate_mode: string }>(
        `SELECT rate_plan_id, rate_mode FROM mchannel_mappings WHERE property_id = $1 AND rate_plan_id IS NOT NULL`,
        [prop.mchannel_property_id]
      );
      const rateModeByPlan = new Map(mappingRes.rows.map((r) => [r.rate_plan_id, r.rate_mode]));

      const availability: any[] = [];
      const restrictions: any[] = [];
      const rowIds: number[] = [];

      for (const row of dirtyRes.rows) {
        rowIds.push(row.id);

        if (prop.ari_source === 'pms') {
          availability.push({
            room_type_id: row.room_type_id,
            date: row.stay_date,
            availability: row.free_rooms,
          });
        }

        if (row.rate_plan_id) {
          const rest: Record<string, any> = {
            rate_plan_id: row.rate_plan_id,
            date: row.stay_date,
          };
          const rateMode = rateModeByPlan.get(row.rate_plan_id) ?? 'manual';
          if (prop.rate_source === 'pms' && rateMode === 'manual' && row.rate !== null) {
            rest.rate = Number(row.rate).toFixed(2);
          }
          if (prop.ari_source === 'pms') {
            if (row.min_stay_arrival !== null) rest.min_stay_arrival = row.min_stay_arrival;
            if (row.max_stay !== null) rest.max_stay = row.max_stay;
            if (row.closed_to_arrival) rest.closed_to_arrival = true;
            if (row.closed_to_departure) rest.closed_to_departure = true;
            if (row.stop_sell) rest.stop_sell = true;
          }
          if (Object.keys(rest).length > 2) {
            restrictions.push(rest);
          }
        }
      }

      // Clear needs_sync inside the same transaction
      await client.query(
        `UPDATE pms_room_inventory SET needs_sync = FALSE WHERE id = ANY($1::bigint[])`,
        [rowIds]
      );

      if (availability.length === 0 && restrictions.length === 0) return;

      const idempotencyKey = `pms-${(prop.code || 'htl').toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const payload = {
        idempotency_key: idempotencyKey,
        sync_type: 'delta',
        availability,
        restrictions,
      };

      await client.query(
        `INSERT INTO ari_outbox (property_id, idempotency_key, sync_type, payload, status)
         VALUES ($1, $2, 'delta', $3::jsonb, 'queued')`,
        [prop.mchannel_property_id, idempotencyKey, JSON.stringify(payload)]
      );
    });
  }
}

export async function flushAriOutbox() {
  const batchesRes = await pool.query<{
    id: number;
    property_id: string;
    idempotency_key: string;
    sync_type: string;
    payload: any;
    attempts: number;
    base_url: string;
    api_key_enc: string;
  }>(
    `SELECT o.id, o.property_id, o.idempotency_key, o.sync_type, o.payload, o.attempts,
            p.base_url, p.api_key_enc
     FROM ari_outbox o
     JOIN mchannel_properties p ON p.mchannel_property_id = o.property_id
     WHERE o.status IN ('queued', 'retry_scheduled')
       AND (o.next_retry_at IS NULL OR o.next_retry_at <= NOW())
     ORDER BY o.created_at ASC
     LIMIT 20`
  );

  for (const batch of batchesRes.rows) {
    const apiKey = decryptSecret(batch.api_key_enc);
    const res = await mchannelRequest({
      baseUrl: batch.base_url,
      apiKey,
      method: 'POST',
      path: `/api/v1/properties/${batch.property_id}/ari`,
      body: batch.payload,
    });

    const nextAttempts = batch.attempts + 1;

    if (res.status === 202) {
      const batchId = res.data?.data?.batch_id ?? null;
      const acceptedItems = Number(res.data?.data?.accepted_items ?? 0);
      await pool.query(
        `UPDATE ari_outbox
         SET status = 'accepted', http_status = 202, batch_id = $1, accepted_items = $2,
             attempts = $3, last_error = NULL, next_retry_at = NULL, updated_at = NOW()
         WHERE id = $4`,
        [batchId, acceptedItems, nextAttempts, batch.id]
      );
      await logSyncEvent(
        batch.property_id,
        'info',
        'ari_push',
        `Pushed ${batch.sync_type} ARI batch (${acceptedItems} items, batch_id=${batchId})`,
        { requestId: res.requestId, batchId }
      );
      console.log(`[ari-outbox] Property ${batch.property_id}: 202 accepted (${acceptedItems} items, batch=${batchId})`);
      continue;
    }

    const isRetryable = res.status === 0 || res.status === 429 || res.status >= 500;
    const errMsg = res.data?.error?.message || res.error || `HTTP ${res.status}`;

    if (isRetryable && nextAttempts < 12) {
      const retryAfter = Number(res.data?.error?.retry_after_seconds ?? Math.min(600, 30 * Math.pow(2, nextAttempts - 1)));
      await pool.query(
        `UPDATE ari_outbox
         SET status = 'retry_scheduled', http_status = $1, attempts = $2,
             next_retry_at = NOW() + ($3 || ' seconds')::interval,
             last_error = $4, updated_at = NOW()
         WHERE id = $5`,
        [res.status, nextAttempts, String(retryAfter), errMsg, batch.id]
      );
      await logSyncEvent(
        batch.property_id,
        'warning',
        'ari_retry_scheduled',
        `ARI batch ${batch.idempotency_key} returned HTTP ${res.status}; retrying in ${retryAfter}s (${errMsg})`,
        { requestId: res.requestId }
      );
    } else {
      await pool.query(
        `UPDATE ari_outbox
         SET status = 'refused', http_status = $1, attempts = $2,
             last_error = $3, next_retry_at = NULL, updated_at = NOW()
         WHERE id = $4`,
        [res.status, nextAttempts, errMsg, batch.id]
      );
      await logSyncEvent(
        batch.property_id,
        'error',
        'ari_refused',
        `ARI batch ${batch.idempotency_key} refused HTTP ${res.status} without retry: ${errMsg}`,
        { requestId: res.requestId }
      );
    }
  }
}

export async function pushFull365DaysForProperty(propertyId: string) {
  const propRes = await pool.query<{
    mchannel_property_id: string;
    code: string;
    ari_source: 'pms' | 'mchannel';
    rate_source: 'pms' | 'mchannel';
  }>(
    `SELECT mchannel_property_id, code, ari_source, rate_source
     FROM mchannel_properties WHERE mchannel_property_id = $1`,
    [propertyId]
  );
  const prop = propRes.rows[0];
  if (!prop) throw new Error(`Property ${propertyId} not found`);

  const mappings = await pool.query<{
    room_type_id: string;
    rate_plan_id: string | null;
    rate_mode: string;
    count_of_rooms: number;
  }>(
    `SELECT room_type_id, rate_plan_id, rate_mode, count_of_rooms
     FROM mchannel_mappings WHERE property_id = $1`,
    [propertyId]
  );

  const today = new Date().toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + 364 * 86400000).toISOString().slice(0, 10);

  const seenRooms = new Set<string>();
  const availability: any[] = [];
  const restrictions: any[] = [];

  for (const m of mappings.rows) {
    if (prop.ari_source === 'pms' && !seenRooms.has(m.room_type_id)) {
      seenRooms.add(m.room_type_id);
      availability.push({
        room_type_id: m.room_type_id,
        date_from: today,
        date_to: endDate,
        availability: m.count_of_rooms || 10,
      });
    }
    if (prop.rate_source === 'pms' && m.rate_plan_id && m.rate_mode === 'manual') {
      restrictions.push({
        rate_plan_id: m.rate_plan_id,
        date_from: today,
        date_to: endDate,
        rate: '2800.00',
      });
    }
  }

  const idempotencyKey = `pms-full-${(prop.code || 'htl').toLowerCase()}-${Date.now()}`;
  const payload = { idempotency_key: idempotencyKey, sync_type: 'full', availability, restrictions };

  await pool.query(
    `INSERT INTO ari_outbox (property_id, idempotency_key, sync_type, payload, status)
     VALUES ($1, $2, 'full', $3::jsonb, 'queued')`,
    [propertyId, idempotencyKey, JSON.stringify(payload)]
  );
  await flushAriOutbox();
}
