import 'dotenv/config';
import { pool, withTransaction, logSyncEvent } from './db.js';
import { encryptSecret } from './crypto.js';
import { mchannelRequest } from './mchannel.js';
import { pushFull365DaysForProperty } from './outboundAri.js';

function getArg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${name}`);
}

async function main() {
  const code = getArg('code');
  const env = getArg('env', 'staging') as 'staging' | 'production';
  const pmsHotelId = getArg('hotel-id', 'H001');
  const hotelName = getArg('hotel-name', 'Hotel Example');
  const city = getArg('city', 'Coimbatore');
  const country = getArg('country', 'IN');
  const timezone = getArg('timezone', 'Asia/Kolkata');
  const currency = getArg('currency', 'INR');
  const webhookPublicUrl = (process.env.WEBHOOK_PUBLIC_URL || 'https://sync.yourhotelpms.com').replace(/\/+$/, '');

  const baseUrl = env === 'production' ? 'https://cmlive.microgenn.com' : 'https://stagcm.microgenn.com';
  console.log(`[pair] Claiming code ${code} on ${baseUrl} ...`);

  const roomTypes = [
    { pms_ref: 'RT-1', name: 'Standard Room', rooms: 10, base_occupancy: 2, max_occupancy: 3 },
  ];
  const ratePlans = [
    { pms_ref: 'RT-1|EP', pms_room_type_ref: 'RT-1', name: 'Room Only', meal_plan: 'room_only', sell_mode: 'per_room' },
  ];

  const res = await mchannelRequest({
    baseUrl,
    method: 'POST',
    path: '/api/v1/pairing/claim',
    body: {
      code,
      pms: { name: 'NodePostgresSync', version: '1.3.0', instance_url: webhookPublicUrl },
      webhook_url: `${webhookPublicUrl}/api/v1/mchannel/webhook`,
      hotel: {
        pms_hotel_id: pmsHotelId,
        name: hotelName,
        city,
        country,
        timezone,
        currency,
        checkin_time: '12:00',
        checkout_time: '11:00',
      },
      room_types: roomTypes,
      rate_plans: ratePlans,
    },
  });

  if (res.status !== 201 || !res.data?.data) {
    console.error('[pair] Claim failed:', res.status, res.data || res.error);
    process.exit(1);
  }

  const d = res.data.data;
  const propertyId: string = d.property.id;
  const apiKeyEnc = encryptSecret(d.api_key);
  const webhookSecretEnc = encryptSecret(d.webhook_secret);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO mchannel_properties (
        mchannel_property_id, pms_hotel_id, name, code, environment, base_url,
        webhook_url, status, ari_source, rate_source, currency, timezone,
        api_key_enc, webhook_secret_enc
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (mchannel_property_id) DO UPDATE SET
        api_key_enc = EXCLUDED.api_key_enc,
        webhook_secret_enc = EXCLUDED.webhook_secret_enc,
        status = EXCLUDED.status,
        ari_source = EXCLUDED.ari_source,
        rate_source = EXCLUDED.rate_source,
        updated_at = NOW()`,
      [
        propertyId,
        pmsHotelId,
        d.property.name || hotelName,
        d.property.code || 'HTL',
        env,
        d.base_url || baseUrl,
        `${webhookPublicUrl}/api/v1/mchannel/webhook/${propertyId}`,
        d.property.status || 'live',
        d.property.ari_source || 'pms',
        d.property.rate_source || 'mchannel',
        currency,
        timezone,
        apiKeyEnc,
        webhookSecretEnc,
      ]
    );

    const mappings: any[] = Array.isArray(d.mappings) ? d.mappings : [];
    for (const m of mappings) {
      await client.query(
        `INSERT INTO mchannel_mappings (
          property_id, pms_room_type_ref, pms_rate_plan_ref, room_type_id, rate_plan_id,
          room_type_name, rate_plan_name, count_of_rooms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (property_id, pms_room_type_ref, pms_rate_plan_ref) DO UPDATE SET
          room_type_id = EXCLUDED.room_type_id,
          rate_plan_id = EXCLUDED.rate_plan_id,
          updated_at = NOW()`,
        [propertyId, m.pms_room_type_ref, m.pms_rate_plan_ref, m.room_type_id, m.rate_plan_id, 'Standard Room', 'Room Only', 10]
      );

      // Seed 365 days in pms_room_inventory so PMS and OTA availability stays aligned
      await client.query(
        `INSERT INTO pms_room_inventory (
          property_id, pms_room_type_ref, room_type_id, rate_plan_id, stay_date,
          total_rooms, booked_rooms, rate, needs_sync
        )
        SELECT $1, $2, $3, $4, d::date, 10, 0, 2800.00, FALSE
        FROM generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '364 days', INTERVAL '1 day') AS d
        ON CONFLICT (property_id, pms_room_type_ref, stay_date) DO NOTHING`,
        [propertyId, m.pms_room_type_ref, m.room_type_id, m.rate_plan_id]
      );
    }
  });

  await logSyncEvent(propertyId, 'info', 'pairing_claimed', `Paired hotel ${hotelName} via CLI`);
  console.log(`[pair] Stored encrypted credentials and 365-day inventory for ${propertyId}`);

  await pushFull365DaysForProperty(propertyId);
  console.log('[pair] Initial 365-day full ARI batch queued and dispatched.');
  await pool.end();
}

main().catch((err) => {
  console.error('[pair] Error:', err);
  process.exit(1);
});
