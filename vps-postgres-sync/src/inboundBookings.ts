import crypto from 'node:crypto';
import { pool, withTransaction, logSyncEvent } from './db.js';
import { decryptSecret, verifyWebhookSignature } from './crypto.js';
import { mchannelRequest } from './mchannel.js';

function expandStayNights(checkin: string, checkout: string): string[] {
  const nights: string[] = [];
  const cur = new Date(`${checkin}T00:00:00Z`);
  const end = new Date(`${checkout}T00:00:00Z`);
  let guard = 0;
  while (cur < end && guard < 90) {
    nights.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return nights;
}

export async function processBookingInPostgres(params: {
  propertyId: string;
  baseUrl: string;
  apiKey: string;
  booking: any;
}): Promise<{ skipped: boolean; ackResult: string; pmsBookingNo: string | null; failureReason: string | null }> {
  const { propertyId, baseUrl, apiKey, booking } = params;

  const outcome = await withTransaction(async (client) => {
    const existingRes = await client.query<{
      revision_seq: number;
      status: string;
      ack_result: string;
      pms_booking_id: string | null;
      pms_booking_no: string | null;
    }>(
      `SELECT revision_seq, status, ack_result, pms_booking_id, pms_booking_no
       FROM pms_bookings
       WHERE mchannel_booking_id = $1
       FOR UPDATE`,
      [booking.id]
    );

    const existing = existingRes.rows[0];
    if (existing && existing.revision_seq >= Number(booking.revision_seq ?? 0)) {
      return {
        skipped: true,
        ackResult: existing.ack_result,
        pmsBookingId: existing.pms_booking_id,
        pmsBookingNo: existing.pms_booking_no,
        failureReason: null,
      };
    }

    const firstRoom = Array.isArray(booking.rooms) && booking.rooms.length > 0 ? booking.rooms[0] : null;
    const pmsRoomRef: string | null = firstRoom?.pms_room_type_ref ?? null;
    const pmsRateRef: string | null = firstRoom?.pms_rate_plan_ref ?? null;
    const isUnmapped = Boolean(booking.is_unmapped) || !firstRoom?.room_type_id || !pmsRoomRef;

    let importOk = true;
    let failureReason: string | null = null;

    if (!isUnmapped && pmsRoomRef) {
      const checkin = firstRoom.checkin_date || booking.arrival_date;
      const checkout = firstRoom.checkout_date || booking.departure_date;
      const nights = expandStayNights(checkin, checkout);

      if (booking.status === 'new') {
        const lockedIds: number[] = [];
        for (const night of nights) {
          const invRes = await client.query<{ id: number; free_rooms: number }>(
            `SELECT id, free_rooms
             FROM pms_room_inventory
             WHERE property_id = $1 AND pms_room_type_ref = $2 AND stay_date = $3
             FOR UPDATE`,
            [propertyId, pmsRoomRef, night]
          );

          if (invRes.rows.length === 0) {
            importOk = false;
            failureReason = `No inventory row: ${pmsRoomRef} on ${night}`;
            break;
          }
          if (invRes.rows[0].free_rooms <= 0) {
            importOk = false;
            failureReason = `No availability: ${pmsRoomRef} on ${night}, requested 1, 0 free`;
            break;
          }
          lockedIds.push(invRes.rows[0].id);
        }

        if (importOk && lockedIds.length > 0) {
          // Updating booked_rooms triggers trg_mchannel_inventory_change -> pushes new free_rooms delta to M-Channel
          await client.query(
            `UPDATE pms_room_inventory
             SET booked_rooms = booked_rooms + 1
             WHERE id = ANY($1::bigint[])`,
            [lockedIds]
          );
        }
      } else if (
        booking.status === 'cancelled' &&
        existing &&
        existing.status !== 'cancelled' &&
        existing.ack_result !== 'failed'
      ) {
        await client.query(
          `UPDATE pms_room_inventory
           SET booked_rooms = GREATEST(booked_rooms - 1, 0)
           WHERE property_id = $1 AND pms_room_type_ref = $2 AND stay_date = ANY($3::date[])`,
          [propertyId, pmsRoomRef, nights]
        );
      }
    }

    const ackResult = !importOk
      ? 'failed'
      : booking.status === 'new'
      ? 'imported'
      : booking.status === 'cancelled'
      ? 'cancelled'
      : 'updated';

    const pmsBookingId = importOk
      ? existing?.pms_booking_id || String(Math.floor(10000 + Math.random() * 89999))
      : '0';
    const pmsBookingNo = importOk
      ? existing?.pms_booking_no || `BK${String(Math.floor(100000 + Math.random() * 899999))}/26-27`
      : null;

    const guestName = [booking.guest?.first_name, booking.guest?.last_name].filter(Boolean).join(' ') || 'OTA Guest';

    await client.query(
      `INSERT INTO pms_bookings (
        property_id, mchannel_booking_id, revision_id, revision_seq, status,
        ota_code, ota_name, ota_reservation_code, unique_id,
        arrival_date, departure_date, guest_name, guest_email,
        amount, currency, pms_room_type_ref, pms_rate_plan_ref,
        is_unmapped, ack_result, ack_failure_reason,
        pms_booking_id, pms_booking_no, raw_booking, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20,
        $21, $22, $23::jsonb, NOW()
      )
      ON CONFLICT (mchannel_booking_id) DO UPDATE SET
        revision_id = EXCLUDED.revision_id,
        revision_seq = EXCLUDED.revision_seq,
        status = EXCLUDED.status,
        arrival_date = EXCLUDED.arrival_date,
        departure_date = EXCLUDED.departure_date,
        guest_name = EXCLUDED.guest_name,
        guest_email = EXCLUDED.guest_email,
        amount = EXCLUDED.amount,
        pms_room_type_ref = EXCLUDED.pms_room_type_ref,
        pms_rate_plan_ref = EXCLUDED.pms_rate_plan_ref,
        is_unmapped = EXCLUDED.is_unmapped,
        ack_result = EXCLUDED.ack_result,
        ack_failure_reason = EXCLUDED.ack_failure_reason,
        pms_booking_id = EXCLUDED.pms_booking_id,
        pms_booking_no = EXCLUDED.pms_booking_no,
        raw_booking = EXCLUDED.raw_booking,
        updated_at = NOW()
      WHERE pms_bookings.revision_seq < EXCLUDED.revision_seq`,
      [
        propertyId,
        booking.id,
        booking.revision_id,
        Number(booking.revision_seq ?? 1),
        booking.status,
        booking.ota_code ?? 'OTA',
        booking.ota_name ?? booking.ota_code ?? 'OTA',
        booking.ota_reservation_code ?? booking.id,
        booking.unique_id ?? `${booking.ota_code ?? 'OTA'}-${booking.ota_reservation_code ?? booking.id}`,
        booking.arrival_date,
        booking.departure_date,
        guestName,
        booking.guest?.email ?? null,
        String(booking.amount ?? '0.00'),
        booking.currency ?? 'INR',
        pmsRoomRef,
        pmsRateRef,
        isUnmapped,
        ackResult,
        failureReason,
        pmsBookingId,
        pmsBookingNo,
        JSON.stringify(booking),
      ]
    );

    return { skipped: false, ackResult, pmsBookingId, pmsBookingNo, failureReason };
  });

  if (outcome.skipped) {
    return {
      skipped: true,
      ackResult: outcome.ackResult,
      pmsBookingNo: outcome.pmsBookingNo,
      failureReason: null,
    };
  }

  // Acknowledge booking to M-Channel after PostgreSQL COMMIT (Section 8.1)
  const ackBody: Record<string, any> = {
    revision_id: booking.revision_id,
    pms_booking_id: outcome.pmsBookingId,
    pms_booking_no: outcome.pmsBookingNo,
    result: outcome.ackResult,
  };
  if (outcome.ackResult === 'failed' && outcome.failureReason) {
    ackBody.failure_reason = outcome.failureReason.slice(0, 500);
  }

  const ackRes = await mchannelRequest({
    baseUrl,
    apiKey,
    method: 'POST',
    path: `/api/v1/bookings/${booking.id}/ack`,
    body: ackBody,
  });

  if (ackRes.status >= 200 && ackRes.status < 300) {
    await pool.query(
      `UPDATE pms_bookings SET acked_at = $1 WHERE mchannel_booking_id = $2`,
      [ackRes.data?.data?.acked_at ?? new Date().toISOString(), booking.id]
    );
  }

  await logSyncEvent(
    propertyId,
    outcome.ackResult === 'failed' ? 'error' : 'info',
    'booking_sync',
    outcome.ackResult === 'failed'
      ? `Booking ${booking.id} failed import: ${outcome.failureReason}`
      : `Booking ${booking.id} (${booking.status}) saved to PostgreSQL as ${outcome.pmsBookingNo} and acked (${outcome.ackResult})`,
    { bookingId: booking.id, requestId: ackRes.requestId }
  );

  return {
    skipped: false,
    ackResult: outcome.ackResult,
    pmsBookingNo: outcome.pmsBookingNo,
    failureReason: outcome.failureReason,
  };
}

export async function handleWebhookRequest(params: {
  propertyIdHint?: string;
  rawBody: Buffer;
  timestamp: string;
  signature: string;
  eventId: string;
}): Promise<{ httpStatus: number; body: Record<string, any> }> {
  let parsed: any;
  try {
    parsed = JSON.parse(params.rawBody.toString('utf8'));
  } catch {
    return { httpStatus: 400, body: { ok: false, error: 'Invalid JSON body' } };
  }

  const propertyId = params.propertyIdHint || parsed?.property_id;
  if (!propertyId) {
    return { httpStatus: 400, body: { ok: false, error: 'Missing property_id' } };
  }

  const propRes = await pool.query<{
    mchannel_property_id: string;
    base_url: string;
    api_key_enc: string;
    webhook_secret_enc: string;
  }>(
    `SELECT mchannel_property_id, base_url, api_key_enc, webhook_secret_enc
     FROM mchannel_properties
     WHERE mchannel_property_id = $1`,
    [propertyId]
  );

  const prop = propRes.rows[0];
  if (!prop) {
    return { httpStatus: 404, body: { ok: false, error: 'Unknown property' } };
  }

  const webhookSecret = decryptSecret(prop.webhook_secret_enc);
  const apiKey = decryptSecret(prop.api_key_enc);

  const sigCheck = verifyWebhookSignature(webhookSecret, params.timestamp, params.signature, params.rawBody);
  const eventId = params.eventId || parsed?.event_id || crypto.randomUUID();
  const eventType = String(parsed?.event || 'unknown');

  if (!sigCheck.valid) {
    await logSyncEvent(propertyId, 'error', 'webhook_rejected', `Rejected invalid HMAC signature or expired timestamp (skew=${sigCheck.skewSeconds}s)`);
    return { httpStatus: 401, body: { ok: false, error: 'Invalid signature or expired timestamp' } };
  }

  // Deduplicate event_id atomically using PostgreSQL primary key
  const insertEvt = await pool.query(
    `INSERT INTO webhook_events (event_id, property_id, event_type, signature_valid, http_status, timestamp_skew_seconds)
     VALUES ($1, $2, $3, TRUE, 200, $4)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, propertyId, eventType, sigCheck.skewSeconds]
  );

  if (insertEvt.rowCount === 0) {
    return { httpStatus: 200, body: { ok: true, deduplicated: true } };
  }

  if (eventType === 'booking.created' || eventType === 'booking.modified' || eventType === 'booking.cancelled') {
    const b = parsed?.data?.booking;
    if (!b?.id) {
      return { httpStatus: 422, body: { ok: false, error: 'Missing booking.id' } };
    }
    const out = await processBookingInPostgres({
      propertyId,
      baseUrl: prop.base_url,
      apiKey,
      booking: b,
    });
    const msg = out.ackResult === 'failed' ? `failed: ${out.failureReason}` : `${out.ackResult} ${out.pmsBookingNo ?? b.id}`;
    return { httpStatus: 200, body: { ok: true, message: msg.slice(0, 450) } };
  }

  if (eventType === 'ari.rejected' || eventType === 'channel.disconnected' || eventType === 'mapping.required') {
    await logSyncEvent(propertyId, eventType === 'mapping.required' ? 'warning' : 'error', eventType, JSON.stringify(parsed?.data ?? {}));
  }

  return { httpStatus: 200, body: { ok: true } };
}

export async function pollMissedBookings() {
  const propsRes = await pool.query<{
    mchannel_property_id: string;
    base_url: string;
    api_key_enc: string;
    last_bookings_pulled_at: Date;
  }>(
    `SELECT mchannel_property_id, base_url, api_key_enc, last_bookings_pulled_at
     FROM mchannel_properties
     WHERE status IN ('live', 'syncing')`
  );

  for (const prop of propsRes.rows) {
    const apiKey = decryptSecret(prop.api_key_enc);
    const sinceIso = prop.last_bookings_pulled_at.toISOString();
    let cursor: string | null = null;
    let totalProcessed = 0;

    do {
      const qs = new URLSearchParams({
        since: sinceIso,
        only_unacked: 'true',
        limit: '50',
      });
      if (cursor) qs.set('cursor', cursor);

      const res = await mchannelRequest({
        baseUrl: prop.base_url,
        apiKey,
        method: 'GET',
        path: `/api/v1/properties/${prop.mchannel_property_id}/bookings?${qs.toString()}`,
      });

      if (res.status < 200 || res.status >= 300) {
        await logSyncEvent(
          prop.mchannel_property_id,
          'error',
          'pull_fallback_error',
          `GET /bookings failed HTTP ${res.status}: ${res.data?.error?.message || res.error}`,
          { requestId: res.requestId }
        );
        break;
      }

      const items: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
      for (const b of items) {
        const out = await processBookingInPostgres({
          propertyId: prop.mchannel_property_id,
          baseUrl: prop.base_url,
          apiKey,
          booking: b,
        });
        if (!out.skipped) totalProcessed++;
      }

      cursor = res.data?.next_cursor ?? null;
    } while (cursor);

    await pool.query(
      `UPDATE mchannel_properties SET last_bookings_pulled_at = NOW(), updated_at = NOW()
       WHERE mchannel_property_id = $1`,
      [prop.mchannel_property_id]
    );

    if (totalProcessed > 0) {
      console.log(`[pull-bookings] Property ${prop.mchannel_property_id}: synced ${totalProcessed} unacked booking(s) into PostgreSQL`);
    }
  }
}
