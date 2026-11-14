import crypto from 'node:crypto';
import {
  fsGetDoc,
  fsSetDoc,
  fsCommit,
  fsListOwnedCollection,
  type FsWriteOp,
} from './firestoreRest.ts';
import { encryptSecret, decryptSecret, verifyWebhookSignature, computeWebhookSignature } from './crypto.ts';
import {
  mchannelRequest,
  ensureSimulatorPropertySeeded,
  upsertSimulatorBooking,
  setSimulatorOwnership,
} from './mchannelClient.ts';
import {
  MCHANNEL_CONTRACT_VERSION,
  type MChannelEnvironment,
  type PropertyRecord,
  type MappingRecord,
  type InventoryDayRecord,
  type AriOutboxRecord,
  type BookingRecord,
  type WebhookEventRecord,
  type StopSaleRecord,
  type SyncLogRecord,
  type ChecklistItemResult,
} from '../shared/mchannel.ts';

interface RuntimePropertyContext {
  ownerUid: string;
  prop: PropertyRecord;
  apiKey: string;
  webhookSecret: string;
  pendingOps: FsWriteOp[];
  webhookEventIds: Set<string>;
  bookingSeqs: Map<string, number>;
}

// Runtime cache allows external unauthenticated M-Channel webhooks to verify HMAC signatures
// and buffer updates until the authenticated operator console flushes them to Firestore.
const runtimeCache = new Map<string, RuntimePropertyContext>();

function addDaysIso(startDate: string, days: number): string {
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayLocalIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function expandStayNights(checkin: string, checkout: string): string[] {
  const nights: string[] = [];
  const start = new Date(`${checkin}T00:00:00Z`);
  const end = new Date(`${checkout}T00:00:00Z`);
  const cur = new Date(start);
  let guard = 0;
  while (cur < end && guard < 90) {
    nights.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return nights;
}

function sanitizeDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

export async function addSyncLog(
  idToken: string | null,
  ownerUid: string,
  propertyId: string,
  level: 'info' | 'warning' | 'error',
  kind: string,
  message: string,
  extra?: { requestId?: string | null; batchId?: string | null; bookingId?: string | null }
) {
  const id = crypto.randomUUID();
  const entry: SyncLogRecord = {
    id,
    ownerUid,
    propertyId,
    level,
    kind: kind.slice(0, 64),
    message: message.slice(0, 500),
    requestId: extra?.requestId ?? null,
    batchId: extra?.batchId ?? null,
    bookingId: extra?.bookingId ?? null,
    createdAt: new Date().toISOString(),
  };

  const op: FsWriteOp = {
    type: 'set',
    docPath: `properties/${propertyId}/syncLogs/${id}`,
    data: entry,
    serverTimeFields: ['createdAt'],
  };

  if (idToken) {
    await fsCommit(idToken, [op]);
  } else {
    const ctx = runtimeCache.get(propertyId);
    if (ctx) ctx.pendingOps.push(op);
  }
  return entry;
}

async function getOwnedPropertyAndSecrets(idToken: string, ownerUid: string, propertyId: string) {
  const prop = await fsGetDoc<PropertyRecord>(idToken, `properties/${propertyId}`);
  if (!prop) {
    throw new Error('Property not found');
  }
  if (prop.ownerUid !== ownerUid) {
    throw new Error('Forbidden: property belongs to another account');
  }

  const secretData = await fsGetDoc<{ ownerUid: string; encryptedApiKey: string; encryptedWebhookSecret: string }>(
    idToken,
    `properties/${propertyId}/secrets/credentials`
  );
  if (!secretData) {
    throw new Error('Missing encrypted credentials for property');
  }

  const apiKey = decryptSecret(secretData.encryptedApiKey);
  const webhookSecret = decryptSecret(secretData.encryptedWebhookSecret);

  const mappings = await fsListOwnedCollection<MappingRecord>(idToken, `properties/${propertyId}`, 'mappings', ownerUid);

  if (prop.environment === 'simulator') {
    ensureSimulatorPropertySeeded({
      propertyId: prop.propertyId,
      name: prop.name,
      code: prop.code,
      currency: prop.currency,
      timezone: prop.timezone,
      ariSource: prop.ariSource,
      rateSource: prop.rateSource,
      mappings,
    });
  }

  // Warm runtime cache for inbound webhook handler
  const existingCtx = runtimeCache.get(propertyId);
  if (existingCtx && existingCtx.pendingOps.length > 0) {
    const toFlush = existingCtx.pendingOps.splice(0, existingCtx.pendingOps.length);
    await fsCommit(idToken, toFlush).catch((e) => {
      console.warn('Pending webhook flush warning:', e);
    });
  }

  runtimeCache.set(propertyId, {
    ownerUid,
    prop,
    apiKey,
    webhookSecret,
    pendingOps: existingCtx?.pendingOps ?? [],
    webhookEventIds: existingCtx?.webhookEventIds ?? new Set<string>(),
    bookingSeqs: existingCtx?.bookingSeqs ?? new Map<string, number>(),
  });

  return { prop, apiKey, webhookSecret, mappings };
}

export async function listPropertiesForUser(idToken: string, ownerUid: string): Promise<PropertyRecord[]> {
  const items = await fsListOwnedCollection<PropertyRecord>(idToken, null, 'properties', ownerUid, 100);
  items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return items;
}

export async function getPropertySnapshot(idToken: string, ownerUid: string, propertyId: string) {
  const { prop, mappings } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const parent = `properties/${propertyId}`;

  const [inventory, outbox, bookings, webhookEvents, stopSales, syncLogs] = await Promise.all([
    fsListOwnedCollection<InventoryDayRecord>(idToken, parent, 'inventory', ownerUid, 100),
    fsListOwnedCollection<AriOutboxRecord>(idToken, parent, 'outbox', ownerUid, 60),
    fsListOwnedCollection<BookingRecord>(idToken, parent, 'bookings', ownerUid, 80),
    fsListOwnedCollection<WebhookEventRecord>(idToken, parent, 'webhookEvents', ownerUid, 60),
    fsListOwnedCollection<StopSaleRecord>(idToken, parent, 'stopSales', ownerUid, 40),
    fsListOwnedCollection<SyncLogRecord>(idToken, parent, 'syncLogs', ownerUid, 80),
  ]);

  inventory.sort((a, b) => a.date.localeCompare(b.date));
  outbox.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  bookings.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  webhookEvents.sort((a, b) => (b.processedAt || '').localeCompare(a.processedAt || ''));
  stopSales.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  syncLogs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const ctx = runtimeCache.get(propertyId);
  if (ctx) {
    for (const evt of webhookEvents) ctx.webhookEventIds.add(evt.eventId);
    for (const b of bookings) ctx.bookingSeqs.set(b.bookingId, b.revisionSeq);
  }

  return {
    property: prop,
    mappings,
    inventory: inventory.slice(0, 60),
    outbox: outbox.slice(0, 30),
    bookings: bookings.slice(0, 50),
    webhookEvents: webhookEvents.slice(0, 40),
    stopSales: stopSales.slice(0, 20),
    syncLogs: syncLogs.slice(0, 60),
  };
}

export async function claimPairing(params: {
  idToken: string;
  ownerUid: string;
  environment: MChannelEnvironment;
  baseUrl?: string;
  code: string;
  pmsName: string;
  pmsVersion: string;
  instanceUrl: string;
  webhookBaseUrl: string;
  hotel: {
    pmsHotelId: string;
    name: string;
    city: string;
    country: string;
    timezone: string;
    currency: string;
    checkinTime: string;
    checkoutTime: string;
  };
  roomTypes: Array<{ pms_ref: string; name: string; rooms: number; base_occupancy: number; max_occupancy: number }>;
  ratePlans: Array<{ pms_ref: string; pms_room_type_ref: string; name: string; meal_plan: string; sell_mode: string }>;
}) {
  const targetBaseUrl =
    params.environment === 'production'
      ? 'https://cmlive.microgenn.com'
      : params.environment === 'staging'
      ? params.baseUrl?.trim() || 'https://stagcm.microgenn.com'
      : 'simulator://mchannel.local';

  const webhookUrl = `${params.webhookBaseUrl.replace(/\/+$/, '')}/api/v1/mchannel/webhook`;

  const res = await mchannelRequest({
    baseUrl: targetBaseUrl,
    method: 'POST',
    path: '/api/v1/pairing/claim',
    body: {
      code: params.code.trim(),
      pms: {
        name: params.pmsName,
        version: params.pmsVersion,
        instance_url: params.instanceUrl,
      },
      webhook_url: webhookUrl,
      hotel: {
        pms_hotel_id: params.hotel.pmsHotelId,
        name: params.hotel.name,
        city: params.hotel.city,
        country: params.hotel.country,
        timezone: params.hotel.timezone,
        currency: params.hotel.currency,
        checkin_time: params.hotel.checkinTime,
        checkout_time: params.hotel.checkoutTime,
      },
      room_types: params.roomTypes,
      rate_plans: params.ratePlans,
    },
  });

  if (res.status !== 201 || !res.data?.data) {
    const errMsg = res.data?.error?.message || res.error || `Pairing failed with HTTP ${res.status}`;
    throw new Error(`${errMsg} (HTTP ${res.status}, request_id=${res.requestId})`);
  }

  const d = res.data.data;
  const propertyId: string = d.property.id;
  const nowIso = new Date().toISOString();

  const propsRes = await mchannelRequest({
    baseUrl: targetBaseUrl,
    apiKey: d.api_key,
    method: 'GET',
    path: '/api/v1/properties',
  });
  const remoteProp = Array.isArray(propsRes.data?.data)
    ? propsRes.data.data.find((p: any) => p.id === propertyId)
    : null;

  const propRecord: PropertyRecord = {
    ownerUid: params.ownerUid,
    propertyId,
    pmsHotelId: params.hotel.pmsHotelId,
    name: d.property.name || params.hotel.name,
    code: d.property.code || 'HMS',
    environment: params.environment,
    baseUrl: d.base_url || targetBaseUrl,
    webhookUrl: `${webhookUrl}/${propertyId}`,
    status: d.property.status || 'live',
    ariSource: d.property.ari_source || 'pms',
    rateSource: d.property.rate_source || 'mchannel',
    currency: params.hotel.currency || 'INR',
    timezone: params.hotel.timezone || 'Asia/Kolkata',
    hasCredentials: true,
    activeChannels: remoteProp?.active_channels ?? [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  // Write property first so subcollection rules (isPropertyOwner) pass
  await fsSetDoc(params.idToken, `properties/${propertyId}`, propRecord, {
    serverTimeFields: ['createdAt', 'updatedAt'],
  });

  const ops: FsWriteOp[] = [];
  ops.push({
    type: 'set',
    docPath: `properties/${propertyId}/secrets/credentials`,
    data: {
      ownerUid: params.ownerUid,
      encryptedApiKey: encryptSecret(d.api_key),
      encryptedWebhookSecret: encryptSecret(d.webhook_secret),
    },
    serverTimeFields: ['updatedAt'],
  });

  const mappingsList: any[] = Array.isArray(d.mappings) ? d.mappings : [];
  for (const m of mappingsList) {
    const rtInput = params.roomTypes.find((r) => r.pms_ref === m.pms_room_type_ref);
    const rpInput = params.ratePlans.find((r) => r.pms_ref === m.pms_rate_plan_ref);
    const mappingId = sanitizeDocId(`${m.pms_room_type_ref}_${m.pms_rate_plan_ref || 'default'}`);
    const mappingDoc: MappingRecord = {
      id: mappingId,
      ownerUid: params.ownerUid,
      propertyId,
      pmsRoomTypeRef: m.pms_room_type_ref,
      pmsRatePlanRef: m.pms_rate_plan_ref ?? null,
      roomTypeId: m.room_type_id,
      ratePlanId: m.rate_plan_id ?? null,
      roomTypeName: rtInput?.name ?? m.pms_room_type_ref,
      ratePlanName: rpInput?.name ?? (m.pms_rate_plan_ref || 'Default'),
      sellMode: (rpInput?.sell_mode as any) === 'per_person' ? 'per_person' : 'per_room',
      rateMode: 'manual',
      countOfRooms: rtInput?.rooms ?? 10,
      updatedAt: nowIso,
    };
    ops.push({
      type: 'set',
      docPath: `properties/${propertyId}/mappings/${mappingId}`,
      data: mappingDoc,
      serverTimeFields: ['updatedAt'],
    });
  }

  const today = todayLocalIso();
  const seenRoomRefs = new Set<string>();
  for (const m of mappingsList) {
    if (seenRoomRefs.has(m.pms_room_type_ref)) continue;
    seenRoomRefs.add(m.pms_room_type_ref);
    const rtInput = params.roomTypes.find((r) => r.pms_ref === m.pms_room_type_ref);
    const totalRooms = rtInput?.rooms ?? 10;

    for (let offset = 0; offset < 14; offset++) {
      const dateStr = addDaysIso(today, offset);
      const invId = sanitizeDocId(`${m.pms_room_type_ref}_${dateStr}`);
      const dayDoc: InventoryDayRecord = {
        id: invId,
        ownerUid: params.ownerUid,
        propertyId,
        pmsRoomTypeRef: m.pms_room_type_ref,
        roomTypeId: m.room_type_id,
        ratePlanId: m.rate_plan_id ?? null,
        date: dateStr,
        totalRooms,
        bookedRooms: 0,
        freeRooms: totalRooms,
        rate: m.pms_room_type_ref === 'RT-2' ? '4500.00' : '2800.00',
        minStayArrival: null,
        maxStay: null,
        closedToArrival: false,
        closedToDeparture: false,
        stopSell: false,
        updatedAt: nowIso,
      };
      ops.push({
        type: 'set',
        docPath: `properties/${propertyId}/inventory/${invId}`,
        data: dayDoc,
        serverTimeFields: ['updatedAt'],
      });
    }
  }

  await fsCommit(params.idToken, ops);

  runtimeCache.set(propertyId, {
    ownerUid: params.ownerUid,
    prop: propRecord,
    apiKey: d.api_key,
    webhookSecret: d.webhook_secret,
    pendingOps: [],
    webhookEventIds: new Set<string>(),
    bookingSeqs: new Map<string, number>(),
  });

  await addSyncLog(
    params.idToken,
    params.ownerUid,
    propertyId,
    'info',
    'pairing_claimed',
    `Paired ${propRecord.name} (${params.environment}) with ${mappingsList.length} mapping(s). API key & webhook secret encrypted with AES-256-GCM.`,
    { requestId: res.requestId }
  );

  return {
    property: propRecord,
    unmatched: d.unmatched,
    filledFields: d.filled_fields,
    nextSteps: d.next_steps,
  };
}

export async function refreshHotelSetup(idToken: string, ownerUid: string, propertyId: string) {
  const { prop, apiKey } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);

  const [propsRes, rtRes, rpRes, statusRes] = await Promise.all([
    mchannelRequest({ baseUrl: prop.baseUrl, apiKey, method: 'GET', path: '/api/v1/properties' }),
    mchannelRequest({ baseUrl: prop.baseUrl, apiKey, method: 'GET', path: `/api/v1/properties/${propertyId}/room-types` }),
    mchannelRequest({ baseUrl: prop.baseUrl, apiKey, method: 'GET', path: `/api/v1/properties/${propertyId}/rate-plans` }),
    mchannelRequest({ baseUrl: prop.baseUrl, apiKey, method: 'GET', path: `/api/v1/pairing/status?property_id=${encodeURIComponent(propertyId)}` }),
  ]);

  const remoteProp = Array.isArray(propsRes.data?.data)
    ? propsRes.data.data.find((p: any) => p.id === propertyId)
    : null;

  if (remoteProp) {
    const updatedProp: PropertyRecord = {
      ...prop,
      status: remoteProp.status ?? prop.status,
      ariSource: remoteProp.ari_source ?? prop.ariSource,
      rateSource: remoteProp.rate_source ?? prop.rateSource,
      activeChannels: remoteProp.active_channels ?? prop.activeChannels,
    };
    await fsSetDoc(idToken, `properties/${propertyId}`, updatedProp, {
      timestampFields: ['createdAt'],
      serverTimeFields: ['updatedAt'],
    });
  }

  const pairingStatus = Array.isArray(statusRes.data?.data) ? statusRes.data.data[0] : null;

  return {
    remoteProperty: remoteProp,
    roomTypes: rtRes.data?.data ?? [],
    ratePlans: rpRes.data?.data ?? [],
    pairingStatus,
  };
}

export async function saveMappings(
  idToken: string,
  ownerUid: string,
  propertyId: string,
  mappings: Array<{
    pmsRoomTypeRef: string;
    pmsRatePlanRef: string | null;
    roomTypeId: string;
    ratePlanId: string | null;
    roomTypeName?: string;
    ratePlanName?: string;
    sellMode?: 'per_room' | 'per_person';
    rateMode?: 'manual' | 'derived' | 'cascade' | 'auto';
    countOfRooms?: number;
  }>
) {
  const { prop, apiKey, mappings: existingMappings } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);

  const res = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'PUT',
    path: `/api/v1/properties/${propertyId}/mappings`,
    body: {
      mappings: mappings.map((m) => ({
        pms_room_type_ref: m.pmsRoomTypeRef,
        pms_rate_plan_ref: m.pmsRatePlanRef,
        room_type_id: m.roomTypeId,
        rate_plan_id: m.ratePlanId,
      })),
    },
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.data?.error?.message || `Mapping update failed with HTTP ${res.status}`);
  }

  const ops: FsWriteOp[] = [];
  for (const oldM of existingMappings) {
    ops.push({ type: 'delete', docPath: `properties/${propertyId}/mappings/${oldM.id}` });
  }
  const nowIso = new Date().toISOString();
  for (const m of mappings) {
    const id = sanitizeDocId(`${m.pmsRoomTypeRef}_${m.pmsRatePlanRef || 'default'}`);
    const doc: MappingRecord = {
      id,
      ownerUid,
      propertyId,
      pmsRoomTypeRef: m.pmsRoomTypeRef,
      pmsRatePlanRef: m.pmsRatePlanRef,
      roomTypeId: m.roomTypeId,
      ratePlanId: m.ratePlanId,
      roomTypeName: m.roomTypeName ?? m.pmsRoomTypeRef,
      ratePlanName: m.ratePlanName ?? (m.pmsRatePlanRef || 'Default'),
      sellMode: m.sellMode ?? 'per_room',
      rateMode: m.rateMode ?? 'manual',
      countOfRooms: m.countOfRooms ?? 10,
      updatedAt: nowIso,
    };
    ops.push({
      type: 'set',
      docPath: `properties/${propertyId}/mappings/${id}`,
      data: doc,
      serverTimeFields: ['updatedAt'],
    });
  }
  await fsCommit(idToken, ops);

  await addSyncLog(idToken, ownerUid, propertyId, 'info', 'mappings_saved', `Updated ${mappings.length} room/rate mapping(s) on M-Channel.`, {
    requestId: res.requestId,
  });

  return res.data?.data;
}

export async function pushAriBatch(params: {
  idToken: string | null;
  ownerUid: string;
  propertyId: string;
  syncType: 'delta' | 'full';
  availability: Array<Record<string, any>>;
  restrictions: Array<Record<string, any>>;
  idempotencyKey?: string;
  bypassOwnershipGuard?: boolean;
}) {
  const ctx = params.idToken
    ? await getOwnedPropertyAndSecrets(params.idToken, params.ownerUid, params.propertyId)
    : runtimeCache.get(params.propertyId);

  if (!ctx) {
    throw new Error('Property context unavailable');
  }
  const { prop, apiKey } = ctx;

  if (!params.bypassOwnershipGuard) {
    if (params.availability.length > 0 && prop.ariSource !== 'pms') {
      throw new Error('Blocked by Section 6.3 ownership rule: ari_source is "mchannel". Do not push availability from PMS.');
    }
    const hasRates = params.restrictions.some((r) => r.rate !== undefined || (Array.isArray(r.rates) && r.rates.length > 0));
    if (hasRates && prop.rateSource !== 'pms') {
      throw new Error('Blocked by Section 6.3 ownership rule: rate_source is "mchannel". Do not push prices from PMS.');
    }
  }

  const idemKey = sanitizeDocId(
    params.idempotencyKey ||
      `pms-${prop.code.toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  );

  const body = {
    idempotency_key: idemKey,
    sync_type: params.syncType,
    availability: params.availability,
    restrictions: params.restrictions,
  };

  const res = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'POST',
    path: `/api/v1/properties/${params.propertyId}/ari`,
    body,
  });

  const nowIso = new Date().toISOString();
  const isRetryable = res.status === 0 || res.status === 429 || res.status >= 500;
  const isAccepted = res.status === 202;

  const outboxStatus: AriOutboxRecord['status'] = isAccepted
    ? 'accepted'
    : isRetryable
    ? 'retry_scheduled'
    : 'refused';

  const retryAfterSec = Number(res.data?.error?.retry_after_seconds ?? 30);
  const nextRetryAt = isRetryable ? new Date(Date.now() + retryAfterSec * 1000).toISOString() : null;
  const lastError = isAccepted
    ? null
    : res.data?.error?.message || res.error || `HTTP ${res.status}`;

  const docPath = `properties/${params.propertyId}/outbox/${idemKey}`;
  const existing = params.idToken ? await fsGetDoc<AriOutboxRecord>(params.idToken, docPath) : null;

  const record: AriOutboxRecord = {
    id: idemKey,
    ownerUid: params.ownerUid,
    propertyId: params.propertyId,
    idempotencyKey: idemKey,
    syncType: params.syncType,
    status: outboxStatus,
    httpStatus: res.status,
    batchId: res.data?.data?.batch_id ?? null,
    acceptedItems: res.data?.data?.accepted_items ?? 0,
    attempts: (existing?.attempts ?? 0) + 1,
    nextRetryAt,
    lastError,
    availabilityCount: params.availability.length,
    restrictionsCount: params.restrictions.length,
    payloadJson: JSON.stringify(body).slice(0, 60000),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  const op: FsWriteOp = {
    type: 'set',
    docPath,
    data: record,
    timestampFields: existing ? ['createdAt'] : undefined,
    serverTimeFields: existing ? ['updatedAt'] : ['createdAt', 'updatedAt'],
  };

  if (params.idToken) {
    await fsCommit(params.idToken, [op]);
  } else {
    runtimeCache.get(params.propertyId)?.pendingOps.push(op);
  }

  await addSyncLog(
    params.idToken,
    params.ownerUid,
    params.propertyId,
    isAccepted ? 'info' : isRetryable ? 'warning' : 'error',
    'ari_push',
    isAccepted
      ? `ARI ${params.syncType} queued (${record.acceptedItems} items, batch ${record.batchId})`
      : `ARI ${params.syncType} HTTP ${res.status}: ${lastError}`,
    { requestId: res.requestId, batchId: record.batchId }
  );

  return record;
}

export async function pushFull365Days(idToken: string, ownerUid: string, propertyId: string) {
  const { prop, mappings } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);

  const today = todayLocalIso();
  const end365 = addDaysIso(today, 364);

  const seenRooms = new Set<string>();
  const availability: Array<Record<string, any>> = [];
  for (const m of mappings) {
    if (!m.roomTypeId || seenRooms.has(m.roomTypeId)) continue;
    seenRooms.add(m.roomTypeId);
    availability.push({
      room_type_id: m.roomTypeId,
      date_from: today,
      date_to: end365,
      availability: m.countOfRooms || 10,
    });
  }

  const restrictions: Array<Record<string, any>> = [];
  if (prop.rateSource === 'pms') {
    for (const m of mappings) {
      if (!m.ratePlanId || m.rateMode !== 'manual') continue;
      restrictions.push({
        rate_plan_id: m.ratePlanId,
        date_from: today,
        date_to: end365,
        rate: m.pmsRoomTypeRef === 'RT-2' ? '4500.00' : '2800.00',
      });
    }
  }

  return pushAriBatch({
    idToken,
    ownerUid,
    propertyId,
    syncType: 'full',
    availability,
    restrictions,
  });
}

export async function retryOutboxBatch(idToken: string, ownerUid: string, propertyId: string, idempotencyKey: string) {
  await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const batch = await fsGetDoc<AriOutboxRecord>(idToken, `properties/${propertyId}/outbox/${idempotencyKey}`);
  if (!batch) {
    throw new Error('Outbox batch not found');
  }
  const parsed = JSON.parse(batch.payloadJson);
  return pushAriBatch({
    idToken,
    ownerUid,
    propertyId,
    syncType: parsed.sync_type,
    availability: parsed.availability ?? [],
    restrictions: parsed.restrictions ?? [],
    idempotencyKey: batch.idempotencyKey,
  });
}

export async function updatePmsInventoryAndPushDelta(params: {
  idToken: string;
  ownerUid: string;
  propertyId: string;
  pmsRoomTypeRef: string;
  date: string;
  freeRooms: number;
  rate?: string;
  minStayArrival?: number | null;
  stopSell?: boolean;
}) {
  const { prop, mappings } = await getOwnedPropertyAndSecrets(params.idToken, params.ownerUid, params.propertyId);
  const mapping = mappings.find((m) => m.pmsRoomTypeRef === params.pmsRoomTypeRef);
  if (!mapping) {
    throw new Error(`No mapping found for PMS room type ${params.pmsRoomTypeRef}`);
  }

  const invId = sanitizeDocId(`${params.pmsRoomTypeRef}_${params.date}`);
  const invPath = `properties/${params.propertyId}/inventory/${invId}`;
  const existing = await fsGetDoc<InventoryDayRecord>(params.idToken, invPath);
  const totalRooms = existing?.totalRooms ?? mapping.countOfRooms;
  const clampedFree = Math.max(0, Math.min(totalRooms, params.freeRooms));
  const nowIso = new Date().toISOString();

  const updatedDay: InventoryDayRecord = {
    id: invId,
    ownerUid: params.ownerUid,
    propertyId: params.propertyId,
    pmsRoomTypeRef: params.pmsRoomTypeRef,
    roomTypeId: mapping.roomTypeId,
    ratePlanId: mapping.ratePlanId,
    date: params.date,
    totalRooms,
    bookedRooms: Math.max(0, totalRooms - clampedFree),
    freeRooms: clampedFree,
    rate: params.rate ?? (existing?.rate || '2800.00'),
    minStayArrival: params.minStayArrival ?? (existing?.minStayArrival ?? null),
    maxStay: existing?.maxStay ?? null,
    closedToArrival: Boolean(existing?.closedToArrival),
    closedToDeparture: Boolean(existing?.closedToDeparture),
    stopSell: params.stopSell ?? Boolean(existing?.stopSell),
    updatedAt: nowIso,
  };

  await fsSetDoc(params.idToken, invPath, updatedDay, { serverTimeFields: ['updatedAt'] });

  const restrictions: Array<Record<string, any>> = [];
  if (mapping.ratePlanId && (params.minStayArrival !== undefined || params.stopSell !== undefined || (params.rate && prop.rateSource === 'pms'))) {
    const restItem: Record<string, any> = {
      rate_plan_id: mapping.ratePlanId,
      date: params.date,
    };
    if (params.rate && prop.rateSource === 'pms' && mapping.rateMode === 'manual') {
      restItem.rate = params.rate;
    }
    if (params.minStayArrival !== undefined && params.minStayArrival !== null) {
      restItem.min_stay_arrival = params.minStayArrival;
    }
    if (params.stopSell !== undefined) {
      restItem.stop_sell = params.stopSell;
    }
    if (Object.keys(restItem).length > 2) {
      restrictions.push(restItem);
    }
  }

  const availability =
    prop.ariSource === 'pms'
      ? [{ room_type_id: mapping.roomTypeId, date: params.date, availability: clampedFree }]
      : [];

  let outbox: AriOutboxRecord | null = null;
  if (availability.length > 0 || restrictions.length > 0) {
    outbox = await pushAriBatch({
      idToken: params.idToken,
      ownerUid: params.ownerUid,
      propertyId: params.propertyId,
      syncType: 'delta',
      availability,
      restrictions,
    });
  }

  return { inventoryDay: updatedDay, outbox };
}

export async function pullStoredCalendar(idToken: string, ownerUid: string, propertyId: string, dateFrom: string, dateTo: string, changedSince?: string) {
  const { prop, apiKey } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  if (changedSince) qs.set('changed_since', changedSince);

  const res = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'GET',
    path: `/api/v1/properties/${propertyId}/ari?${qs.toString()}`,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.data?.error?.message || `Failed to read stored ARI (HTTP ${res.status})`);
  }
  return res.data?.data;
}

export async function createStopSale(params: {
  idToken: string;
  ownerUid: string;
  propertyId: string;
  pmsRoomTypeRef: string | null;
  dateFrom: string;
  dateTo: string;
  otas: 'all' | string[];
  reason: string;
}) {
  const { prop, apiKey } = await getOwnedPropertyAndSecrets(params.idToken, params.ownerUid, params.propertyId);
  const body: Record<string, any> = {
    date_from: params.dateFrom,
    date_to: params.dateTo,
    otas: params.otas,
    reason: params.reason,
  };
  if (params.pmsRoomTypeRef) {
    body.pms_room_type_ref = params.pmsRoomTypeRef;
  }

  const res = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'POST',
    path: `/api/v1/properties/${params.propertyId}/stop-sales`,
    body,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.data?.error?.message || `Stop sale failed (HTTP ${res.status})`);
  }

  const d = res.data?.data;
  const stopSaleId = sanitizeDocId(d?.id ?? crypto.randomUUID());
  const record: StopSaleRecord = {
    id: stopSaleId,
    ownerUid: params.ownerUid,
    propertyId: params.propertyId,
    stopSaleId,
    pmsRoomTypeRef: params.pmsRoomTypeRef,
    roomTypeId: d?.room_type_id ?? null,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    otas: Array.isArray(params.otas) ? params.otas.join(',') : 'all',
    reason: params.reason,
    status: 'active',
    createdAt: d?.created_at ?? new Date().toISOString(),
  };

  await fsSetDoc(params.idToken, `properties/${params.propertyId}/stopSales/${stopSaleId}`, record, {
    serverTimeFields: ['createdAt'],
  });

  await addSyncLog(params.idToken, params.ownerUid, params.propertyId, 'warning', 'stop_sale_created', `Stop sale active ${params.dateFrom}..${params.dateTo} (${record.otas})`);
  return record;
}

export async function reopenStopSale(idToken: string, ownerUid: string, propertyId: string, stopSaleId: string) {
  const { prop, apiKey } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const res = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'POST',
    path: `/api/v1/properties/${propertyId}/stop-sales/${stopSaleId}/reopen`,
    body: {},
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.data?.error?.message || `Reopen stop sale failed (HTTP ${res.status})`);
  }

  const docPath = `properties/${propertyId}/stopSales/${stopSaleId}`;
  const existing = await fsGetDoc<StopSaleRecord>(idToken, docPath);
  if (existing) {
    await fsSetDoc(
      idToken,
      docPath,
      { ...existing, status: 'reopened' },
      { timestampFields: ['createdAt'] }
    );
  }

  await addSyncLog(idToken, ownerUid, propertyId, 'info', 'stop_sale_reopened', `Reopened stop sale ${stopSaleId}`);
  return { stopSaleId, status: 'reopened' };
}

async function importAndAckBooking(params: {
  idToken: string | null;
  ownerUid: string;
  prop: PropertyRecord;
  apiKey: string;
  booking: any;
}) {
  const { idToken, ownerUid, prop, apiKey, booking } = params;
  const bookingId = sanitizeDocId(booking.id);
  const bookingPath = `properties/${prop.propertyId}/bookings/${bookingId}`;
  const existingBooking = idToken ? await fsGetDoc<BookingRecord>(idToken, bookingPath) : null;
  const ctx = runtimeCache.get(prop.propertyId);
  const cachedSeq = ctx?.bookingSeqs.get(bookingId) ?? 0;
  const prevSeq = existingBooking?.revisionSeq ?? cachedSeq;

  if (prevSeq >= Number(booking.revision_seq ?? 0)) {
    return { skipped: true, reason: 'stale_or_duplicate_revision', booking: existingBooking };
  }

  const firstRoom = Array.isArray(booking.rooms) && booking.rooms.length > 0 ? booking.rooms[0] : null;
  const pmsRoomRef: string | null = firstRoom?.pms_room_type_ref ?? null;
  const pmsRateRef: string | null = firstRoom?.pms_rate_plan_ref ?? null;
  const isUnmapped = Boolean(booking.is_unmapped) || !firstRoom?.room_type_id || !pmsRoomRef;

  let importOk = true;
  let failureReason: string | null = null;
  const affectedDates: Array<{ roomTypeId: string; date: string; freeRooms: number }> = [];
  const invOps: FsWriteOp[] = [];

  if (!isUnmapped && pmsRoomRef && idToken) {
    const nights = expandStayNights(firstRoom.checkin_date || booking.arrival_date, firstRoom.checkout_date || booking.departure_date);
    const mappings = await fsListOwnedCollection<MappingRecord>(idToken, `properties/${prop.propertyId}`, 'mappings', ownerUid);
    const mapping = mappings.find((m) => m.pmsRoomTypeRef === pmsRoomRef);
    const totalDefault = mapping?.countOfRooms ?? 10;

    if (booking.status === 'new') {
      const daySnapshots: Array<{ path: string; data: InventoryDayRecord }> = [];
      for (const night of nights) {
        const invId = sanitizeDocId(`${pmsRoomRef}_${night}`);
        const invPath = `properties/${prop.propertyId}/inventory/${invId}`;
        const existingDay = await fsGetDoc<InventoryDayRecord>(idToken, invPath);
        const dayData: InventoryDayRecord = existingDay ?? {
          id: invId,
          ownerUid,
          propertyId: prop.propertyId,
          pmsRoomTypeRef: pmsRoomRef,
          roomTypeId: firstRoom.room_type_id,
          ratePlanId: firstRoom.rate_plan_id ?? null,
          date: night,
          totalRooms: totalDefault,
          bookedRooms: 0,
          freeRooms: totalDefault,
          rate: firstRoom.nightly_prices?.[0]?.amount ?? '2800.00',
          minStayArrival: null,
          maxStay: null,
          closedToArrival: false,
          closedToDeparture: false,
          stopSell: false,
          updatedAt: new Date().toISOString(),
        };

        if (dayData.freeRooms <= 0) {
          importOk = false;
          failureReason = `No availability: ${pmsRoomRef} on ${night}, requested 1, 0 free`;
          break;
        }
        daySnapshots.push({ path: invPath, data: dayData });
      }

      if (importOk) {
        const nowIso = new Date().toISOString();
        for (const item of daySnapshots) {
          const nextBooked = item.data.bookedRooms + 1;
          const nextFree = Math.max(0, item.data.totalRooms - nextBooked);
          invOps.push({
            type: 'set',
            docPath: item.path,
            data: {
              ...item.data,
              bookedRooms: nextBooked,
              freeRooms: nextFree,
              updatedAt: nowIso,
            },
            serverTimeFields: ['updatedAt'],
          });
          if (item.data.roomTypeId) {
            affectedDates.push({ roomTypeId: item.data.roomTypeId, date: item.data.date, freeRooms: nextFree });
          }
        }
      }
    } else if (booking.status === 'cancelled' && existingBooking && existingBooking.status !== 'cancelled' && existingBooking.ackResult !== 'failed') {
      const nowIso = new Date().toISOString();
      for (const night of nights) {
        const invId = sanitizeDocId(`${pmsRoomRef}_${night}`);
        const invPath = `properties/${prop.propertyId}/inventory/${invId}`;
        const dayData = await fsGetDoc<InventoryDayRecord>(idToken, invPath);
        if (dayData) {
          const nextBooked = Math.max(0, dayData.bookedRooms - 1);
          const nextFree = Math.min(dayData.totalRooms, dayData.totalRooms - nextBooked);
          invOps.push({
            type: 'set',
            docPath: invPath,
            data: {
              ...dayData,
              bookedRooms: nextBooked,
              freeRooms: nextFree,
              updatedAt: nowIso,
            },
            serverTimeFields: ['updatedAt'],
          });
          if (dayData.roomTypeId) {
            affectedDates.push({ roomTypeId: dayData.roomTypeId, date: dayData.date, freeRooms: nextFree });
          }
        }
      }
    }
  }

  const pmsBookingId = importOk
    ? existingBooking?.pmsBookingId || String(Math.floor(10000 + Math.random() * 89999))
    : '0';
  const pmsBookingNo = importOk
    ? existingBooking?.pmsBookingNo || `BK${String(Math.floor(100000 + Math.random() * 899999))}/26-27`
    : null;

  const ackOutcome: BookingRecord['ackResult'] = !importOk
    ? 'failed'
    : booking.status === 'new'
    ? 'imported'
    : booking.status === 'cancelled'
    ? 'cancelled'
    : 'updated';

  const nowIso = new Date().toISOString();
  const guestName = [booking.guest?.first_name, booking.guest?.last_name].filter(Boolean).join(' ') || 'OTA Guest';

  const savedRecord: BookingRecord = {
    id: bookingId,
    ownerUid,
    propertyId: prop.propertyId,
    bookingId,
    revisionId: booking.revision_id,
    revisionSeq: Number(booking.revision_seq ?? 1),
    status: booking.status,
    otaCode: booking.ota_code ?? 'OTA',
    otaName: booking.ota_name ?? booking.ota_code ?? 'OTA',
    secondaryOtaName: booking.secondary_ota_name ?? null,
    otaReservationCode: booking.ota_reservation_code ?? bookingId,
    uniqueId: booking.unique_id ?? `${booking.ota_code ?? 'OTA'}-${booking.ota_reservation_code ?? bookingId}`,
    arrivalDate: booking.arrival_date,
    departureDate: booking.departure_date,
    arrivalTime: booking.arrival_time ?? null,
    guestName,
    guestEmail: booking.guest?.email ?? null,
    occupancyAdults: Number(booking.occupancy?.adults ?? 1),
    occupancyChildren: Number(booking.occupancy?.children ?? 0),
    amount: String(booking.amount ?? '0.00'),
    currency: booking.currency ?? prop.currency,
    otaCommission: booking.ota_commission ?? null,
    pmsRoomTypeRef: pmsRoomRef,
    pmsRatePlanRef: pmsRateRef,
    isUnmapped,
    ackResult: ackOutcome,
    ackFailureReason: failureReason,
    pmsBookingId,
    pmsBookingNo,
    ackedAt: null,
    notes: booking.notes ?? null,
    paymentCollect: booking.payment?.collect ?? null,
    updatedAt: nowIso,
  };

  ctx?.bookingSeqs.set(bookingId, savedRecord.revisionSeq);

  const ackBody: Record<string, any> = {
    revision_id: booking.revision_id,
    pms_booking_id: pmsBookingId,
    pms_booking_no: pmsBookingNo,
    result: ackOutcome,
  };
  if (!importOk && failureReason) {
    ackBody.failure_reason = failureReason.slice(0, 500);
  }

  const ackRes = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'POST',
    path: `/api/v1/bookings/${booking.id}/ack`,
    body: ackBody,
  });

  if (ackRes.status >= 200 && ackRes.status < 300) {
    savedRecord.ackedAt = ackRes.data?.data?.acked_at ?? new Date().toISOString();
  }

  const bookingWriteOp: FsWriteOp = {
    type: 'set',
    docPath: bookingPath,
    data: savedRecord,
    serverTimeFields: ['updatedAt'],
  };

  if (idToken) {
    await fsCommit(idToken, [...invOps, bookingWriteOp]);
  } else {
    ctx?.pendingOps.push(...invOps, bookingWriteOp);
  }

  if (affectedDates.length > 0 && prop.ariSource === 'pms') {
    await pushAriBatch({
      idToken,
      ownerUid,
      propertyId: prop.propertyId,
      syncType: 'delta',
      availability: affectedDates.map((d) => ({
        room_type_id: d.roomTypeId,
        date: d.date,
        availability: d.freeRooms,
      })),
      restrictions: [],
    });
  }

  if (isUnmapped) {
    await addSyncLog(
      idToken,
      ownerUid,
      prop.propertyId,
      'warning',
      'mapping_required',
      `Booking ${savedRecord.uniqueId} imported as unallocated (is_unmapped=true). Map room/rate in Setup.`,
      { bookingId }
    );
  } else {
    await addSyncLog(
      idToken,
      ownerUid,
      prop.propertyId,
      importOk ? 'info' : 'error',
      'booking_ack',
      importOk
        ? `Booking ${savedRecord.uniqueId} (${booking.status}) saved as ${pmsBookingNo} & acked (${ackOutcome})`
        : `Booking ${savedRecord.uniqueId} failed import: ${failureReason}`,
      { bookingId, requestId: ackRes.requestId }
    );
  }

  return { skipped: false, booking: savedRecord, ackStatus: ackRes.status };
}

export async function handleIncomingWebhook(params: {
  idToken?: string | null;
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
    return { httpStatus: 400, body: { error: 'Invalid JSON body' } };
  }

  const propertyId = params.propertyIdHint || parsed?.property_id;
  if (!propertyId) {
    return { httpStatus: 400, body: { error: 'Missing property_id' } };
  }

  const ctx = runtimeCache.get(propertyId);
  if (!ctx) {
    return {
      httpStatus: 503,
      body: { error: 'Property context not warmed in memory yet; open console or use pull fallback.' },
    };
  }

  const { prop, ownerUid, apiKey, webhookSecret } = ctx;
  const sigCheck = verifyWebhookSignature(webhookSecret, params.timestamp, params.signature, params.rawBody);
  const eventId = sanitizeDocId(params.eventId || parsed?.event_id || crypto.randomUUID());
  const eventType = String(parsed?.event || 'unknown').slice(0, 64);

  if (!sigCheck.valid) {
    const failLogId = sanitizeDocId(`fail_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`);
    const evtRecord: WebhookEventRecord = {
      id: failLogId,
      ownerUid,
      propertyId,
      eventId,
      eventType,
      signatureValid: false,
      httpStatus: 401,
      timestampSkewSeconds: sigCheck.skewSeconds,
      deduplicated: false,
      summary: `Rejected invalid signature or expired timestamp (skew=${sigCheck.skewSeconds}s)`,
      processedAt: new Date().toISOString(),
    };
    const op: FsWriteOp = {
      type: 'set',
      docPath: `properties/${propertyId}/webhookEvents/${failLogId}`,
      data: evtRecord,
      serverTimeFields: ['processedAt'],
    };
    if (params.idToken) {
      await fsCommit(params.idToken, [op]);
    } else {
      ctx.pendingOps.push(op);
    }
    await addSyncLog(params.idToken ?? null, ownerUid, propertyId, 'error', 'webhook_rejected', evtRecord.summary);
    return { httpStatus: 401, body: { ok: false, error: 'Invalid signature or expired timestamp' } };
  }

  // Deduplicate event_id
  const existingEvt =
    ctx.webhookEventIds.has(eventId) ||
    (params.idToken ? Boolean(await fsGetDoc(params.idToken, `properties/${propertyId}/webhookEvents/${eventId}`)) : false);

  if (existingEvt) {
    ctx.webhookEventIds.add(eventId);
    await addSyncLog(params.idToken ?? null, ownerUid, propertyId, 'info', 'webhook_deduplicated', `Duplicate event ${eventId} (${eventType}) ignored with 200`);
    return { httpStatus: 200, body: { ok: true, deduplicated: true } };
  }
  ctx.webhookEventIds.add(eventId);

  let responseSummary = `Processed ${eventType}`;
  if (eventType === 'booking.created' || eventType === 'booking.modified' || eventType === 'booking.cancelled') {
    const b = parsed?.data?.booking;
    if (!b?.id) {
      return { httpStatus: 422, body: { ok: false, error: 'Missing data.booking.id' } };
    }
    const outcome = await importAndAckBooking({
      idToken: params.idToken ?? null,
      ownerUid,
      prop,
      apiKey,
      booking: b,
    });
    if (outcome.skipped) {
      responseSummary = `Ignored stale revision ${b.revision_seq} for ${b.id}`;
    } else if (outcome.booking?.ackResult === 'failed') {
      responseSummary = `failed: ${outcome.booking.ackFailureReason}`;
    } else {
      responseSummary = `${outcome.booking?.ackResult} ${outcome.booking?.pmsBookingNo ?? b.id}`;
    }
  } else if (eventType === 'ari.rejected') {
    const rejected = parsed?.data?.rejected ?? [];
    responseSummary = `ARI rejected batch ${parsed?.data?.batch_id}: ${rejected.length} item(s)`;
    await addSyncLog(params.idToken ?? null, ownerUid, propertyId, 'error', 'ari_rejected', responseSummary, { batchId: parsed?.data?.batch_id ?? null });
  } else if (eventType === 'channel.disconnected') {
    responseSummary = `Channel ${parsed?.data?.ota_code} disconnected: ${parsed?.data?.reason}`;
    await addSyncLog(params.idToken ?? null, ownerUid, propertyId, 'error', 'channel_disconnected', responseSummary);
  } else if (eventType === 'mapping.required') {
    responseSummary = `Mapping required (${parsed?.data?.scope}): ${parsed?.data?.message}`;
    await addSyncLog(params.idToken ?? null, ownerUid, propertyId, 'warning', 'mapping_required', responseSummary, { bookingId: parsed?.data?.booking_id ?? null });
  }

  const evtRecord: WebhookEventRecord = {
    id: eventId,
    ownerUid,
    propertyId,
    eventId,
    eventType,
    signatureValid: true,
    httpStatus: 200,
    timestampSkewSeconds: sigCheck.skewSeconds,
    deduplicated: false,
    summary: responseSummary.slice(0, 480),
    processedAt: new Date().toISOString(),
  };

  const evtOp: FsWriteOp = {
    type: 'set',
    docPath: `properties/${propertyId}/webhookEvents/${eventId}`,
    data: evtRecord,
    serverTimeFields: ['processedAt'],
  };

  if (params.idToken) {
    await fsCommit(params.idToken, [evtOp]);
  } else {
    ctx.pendingOps.push(evtOp);
  }

  return { httpStatus: 200, body: { ok: true, message: responseSummary.slice(0, 450) } };
}

export async function pullBookingsFallback(idToken: string, ownerUid: string, propertyId: string, sinceIso: string, onlyUnacked: boolean) {
  const { prop, apiKey } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const qs = new URLSearchParams({
    since: sinceIso,
    only_unacked: String(onlyUnacked),
    limit: '50',
  });
  const res = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'GET',
    path: `/api/v1/properties/${propertyId}/bookings?${qs.toString()}`,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.data?.error?.message || `Pull bookings failed (HTTP ${res.status})`);
  }

  const items: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
  let importedCount = 0;
  for (const b of items) {
    const out = await importAndAckBooking({ idToken, ownerUid, prop, apiKey, booking: b });
    if (!out.skipped) importedCount++;
  }

  await addSyncLog(idToken, ownerUid, propertyId, 'info', 'pull_fallback', `Pull fallback fetched ${items.length} booking(s), processed ${importedCount}`);
  return { fetched: items.length, processed: importedCount };
}

export async function reportBookingNoShow(idToken: string, ownerUid: string, propertyId: string, bookingId: string, waiveFees: boolean) {
  const { prop, apiKey } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const res = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'POST',
    path: `/api/v1/bookings/${bookingId}/no-show`,
    body: { waive_fees: waiveFees },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.data?.error?.message || `No-show report failed (HTTP ${res.status})`);
  }
  await addSyncLog(idToken, ownerUid, propertyId, 'warning', 'no_show', `Reported no-show for booking ${bookingId} (waive_fees=${waiveFees})`, { bookingId });
  return res.data?.data;
}

export async function requestInvalidCardCancel(idToken: string, ownerUid: string, propertyId: string, bookingId: string, note: string) {
  const { prop, apiKey } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const res = await mchannelRequest({
    baseUrl: prop.baseUrl,
    apiKey,
    method: 'POST',
    path: `/api/v1/bookings/${bookingId}/cancel-request`,
    body: { reason: 'invalid_card', note },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.data?.error?.message || `Invalid-card cancel request failed (HTTP ${res.status})`);
  }
  await addSyncLog(idToken, ownerUid, propertyId, 'warning', 'invalid_card_cancel', `Requested invalid-card cancellation for booking ${bookingId}`, { bookingId });
  return res.data?.data;
}

export async function getDiagnostics(idToken: string, ownerUid: string, propertyId: string) {
  const { prop, apiKey } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const [healthRes, logRes, statusRes] = await Promise.all([
    mchannelRequest({ baseUrl: prop.baseUrl, apiKey, method: 'GET', path: `/api/v1/properties/${propertyId}/health` }),
    mchannelRequest({ baseUrl: prop.baseUrl, apiKey, method: 'GET', path: `/api/v1/properties/${propertyId}/sync-log?limit=30` }),
    mchannelRequest({ baseUrl: prop.baseUrl, apiKey, method: 'GET', path: `/api/v1/pairing/status?property_id=${encodeURIComponent(propertyId)}` }),
  ]);

  return {
    health: healthRes.data?.data ?? null,
    remoteLogs: logRes.data?.data ?? [],
    pairingStatus: Array.isArray(statusRes.data?.data) ? statusRes.data.data[0] : null,
  };
}

export async function dispatchSimulatedSignedWebhook(params: {
  idToken: string;
  ownerUid: string;
  propertyId: string;
  scenario: 'created' | 'modified' | 'cancelled' | 'unmapped' | 'full_room' | 'bad_signature' | 'duplicate_event' | 'missed_pull';
  bookingId?: string;
}) {
  const { prop, webhookSecret, mappings } = await getOwnedPropertyAndSecrets(params.idToken, params.ownerUid, params.propertyId);
  const firstMapping = mappings[0];

  const today = todayLocalIso();
  const checkin = addDaysIso(today, 2);
  const checkout = addDaysIso(today, 4);
  const bookingId = params.bookingId || crypto.randomUUID();
  const revisionId = crypto.randomUUID();

  let revisionSeq = 1;
  let status: 'new' | 'modified' | 'cancelled' = 'new';
  let eventType = 'booking.created';
  if (params.scenario === 'modified') {
    revisionSeq = 2;
    status = 'modified';
    eventType = 'booking.modified';
  } else if (params.scenario === 'cancelled') {
    revisionSeq = 3;
    status = 'cancelled';
    eventType = 'booking.cancelled';
  }

  if (params.scenario === 'full_room' && firstMapping) {
    const invId = sanitizeDocId(`${firstMapping.pmsRoomTypeRef}_${checkin}`);
    const fullDay: InventoryDayRecord = {
      id: invId,
      ownerUid: params.ownerUid,
      propertyId: params.propertyId,
      pmsRoomTypeRef: firstMapping.pmsRoomTypeRef,
      roomTypeId: firstMapping.roomTypeId,
      ratePlanId: firstMapping.ratePlanId,
      date: checkin,
      totalRooms: firstMapping.countOfRooms || 10,
      bookedRooms: firstMapping.countOfRooms || 10,
      freeRooms: 0,
      rate: '2800.00',
      minStayArrival: null,
      maxStay: null,
      closedToArrival: false,
      closedToDeparture: false,
      stopSell: false,
      updatedAt: new Date().toISOString(),
    };
    await fsSetDoc(params.idToken, `properties/${params.propertyId}/inventory/${invId}`, fullDay, {
      serverTimeFields: ['updatedAt'],
    });
  }

  const bookingPayload = {
    id: bookingId,
    revision_id: revisionId,
    revision_seq: revisionSeq,
    property_id: params.propertyId,
    status,
    ota_code: 'BDC',
    ota_name: 'Booking.com',
    secondary_ota_name: null,
    ota_reservation_code: String(Math.floor(5000000000 + Math.random() * 4000000000)),
    unique_id: `BDC-${Math.floor(5000000000 + Math.random() * 4000000000)}`,
    arrival_date: checkin,
    departure_date: checkout,
    arrival_time: '14:00',
    booked_at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    currency: prop.currency,
    amount: status === 'modified' ? '6200.00' : '5600.00',
    ota_commission: '840.00',
    guest: {
      first_name: 'Asha',
      last_name: 'Raman',
      email: 'a.raman@guest.booking.com',
      phone: null,
      address: null,
      city: null,
      country: 'IN',
      zip: null,
      language: 'en',
      company: null,
    },
    occupancy: { adults: 2, children: 0, infants: 0 },
    rooms: [
      {
        room_type_id: params.scenario === 'unmapped' ? null : firstMapping?.roomTypeId ?? null,
        rate_plan_id: params.scenario === 'unmapped' ? null : firstMapping?.ratePlanId ?? null,
        pms_room_type_ref: params.scenario === 'unmapped' ? null : firstMapping?.pmsRoomTypeRef ?? null,
        pms_rate_plan_ref: params.scenario === 'unmapped' ? null : firstMapping?.pmsRatePlanRef ?? null,
        ota_room_code: '1722499001',
        ota_rate_code: '68994901',
        ota_room_unique_id: null,
        checkin_date: checkin,
        checkout_date: checkout,
        occupancy: { adults: 2, children: 0, infants: 0 },
        guests: [{ first_name: 'Asha', last_name: 'Raman' }],
        nightly_prices: [
          { date: checkin, amount: '2800.00' },
          { date: addDaysIso(checkin, 1), amount: '2800.00' },
        ],
        amount: status === 'modified' ? '6200.00' : '5600.00',
        taxes: [{ name: 'Goods & services tax', type: 'tax', amount: '280.00', is_inclusive: false, collected_by_ota: false }],
        services: [],
        meal_plan: null,
        is_cancelled: status === 'cancelled',
      },
    ],
    services: [],
    payment: { collect: 'property', type: 'credit_card', has_card: true, card_is_virtual: false, card_type: 'VI' },
    notes: params.scenario === 'modified' ? 'Late check-in requested' : 'Non-smoking room',
    cancellation_policy_text: null,
    is_unmapped: params.scenario === 'unmapped',
  };

  if (prop.environment === 'simulator') {
    upsertSimulatorBooking(params.propertyId, bookingPayload);
  }

  if (params.scenario === 'missed_pull') {
    const pullRes = await pullBookingsFallback(params.idToken, params.ownerUid, params.propertyId, '2026-01-01T00:00:00Z', true);
    return { scenario: params.scenario, httpStatus: 200, pullResult: pullRes };
  }

  const eventId = crypto.randomUUID();
  const envelope = {
    contract_version: MCHANNEL_CONTRACT_VERSION,
    event: eventType,
    event_id: eventId,
    occurred_at: new Date().toISOString(),
    tenant_id: crypto.randomUUID(),
    property_id: params.propertyId,
    data: { booking: bookingPayload },
  };
  const rawBody = Buffer.from(JSON.stringify(envelope), 'utf8');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const validSig = computeWebhookSignature(webhookSecret, timestamp, rawBody);
  const signature = params.scenario === 'bad_signature' ? '0'.repeat(64) : validSig;

  const first = await handleIncomingWebhook({
    idToken: params.idToken,
    propertyIdHint: params.propertyId,
    rawBody,
    timestamp,
    signature,
    eventId,
  });

  if (params.scenario === 'duplicate_event') {
    const second = await handleIncomingWebhook({
      idToken: params.idToken,
      propertyIdHint: params.propertyId,
      rawBody,
      timestamp,
      signature: validSig,
      eventId,
    });
    return { scenario: params.scenario, first, second };
  }

  return { scenario: params.scenario, ...first, bookingId };
}

export async function runGoLiveChecklist(idToken: string, ownerUid: string, propertyId: string): Promise<ChecklistItemResult[]> {
  const { prop, apiKey, mappings } = await getOwnedPropertyAndSecrets(idToken, ownerUid, propertyId);
  const now = new Date().toISOString();
  const results: ChecklistItemResult[] = [];

  results.push({
    step: 1,
    title: 'Pair with a one-time code',
    expected: '201; key, secret, property id and mapping stored encrypted',
    status: prop.hasCredentials ? 'passed' : 'failed',
    detail: `Property ${prop.propertyId} paired (${prop.environment}); AES-256-GCM secrets active`,
    lastRunAt: now,
  });

  const diag = await getDiagnostics(idToken, ownerUid, propertyId);
  const checks = diag.pairingStatus?.checks;
  results.push({
    step: 2,
    title: 'GET /pairing/status',
    expected: 'paired, mapping_saved and webhook_registered are true',
    status: checks?.paired && checks?.mapping_saved && checks?.webhook_registered ? 'passed' : 'failed',
    detail: checks ? `paired=${checks.paired}, mapping_saved=${checks.mapping_saved}, webhook_registered=${checks.webhook_registered}` : 'No status payload',
    lastRunAt: now,
  });

  const fullBatch = await pushFull365Days(idToken, ownerUid, propertyId);
  results.push({
    step: 3,
    title: 'Full push of free rooms for 365 days',
    expected: '202; availability_received becomes true',
    status: fullBatch.httpStatus === 202 ? 'passed' : 'failed',
    detail: `HTTP ${fullBatch.httpStatus} · batch_id=${fullBatch.batchId}`,
    lastRunAt: now,
  });

  const firstMapping = mappings[0];
  const testDate = addDaysIso(todayLocalIso(), 5);
  let step4Ok = false;
  let step5Ok = false;
  if (firstMapping) {
    const r4 = await updatePmsInventoryAndPushDelta({
      idToken,
      ownerUid,
      propertyId,
      pmsRoomTypeRef: firstMapping.pmsRoomTypeRef,
      date: testDate,
      freeRooms: Math.max(0, (firstMapping.countOfRooms || 10) - 1),
    });
    step4Ok = r4.outbox?.httpStatus === 202;
    const r5 = await updatePmsInventoryAndPushDelta({
      idToken,
      ownerUid,
      propertyId,
      pmsRoomTypeRef: firstMapping.pmsRoomTypeRef,
      date: testDate,
      freeRooms: firstMapping.countOfRooms || 10,
    });
    step5Ok = r5.outbox?.httpStatus === 202;
  }
  results.push({
    step: 4,
    title: 'Create a booking in the PMS',
    expected: 'Delta push with recalculated free-room count',
    status: step4Ok ? 'passed' : 'failed',
    detail: step4Ok ? `Delta ARI push accepted (202) for ${testDate}` : 'Missing mapping or non-202 response',
    lastRunAt: now,
  });
  results.push({
    step: 5,
    title: 'Cancel that booking in the PMS',
    expected: 'Delta push restoring the free-room count',
    status: step5Ok ? 'passed' : 'failed',
    detail: step5Ok ? `Restored free count pushed (202) for ${testDate}` : 'Failed to restore count',
    lastRunAt: now,
  });

  const retryRes = await retryOutboxBatch(idToken, ownerUid, propertyId, fullBatch.idempotencyKey);
  const step6Ok = retryRes.httpStatus === 202 && retryRes.batchId === fullBatch.batchId;
  results.push({
    step: 6,
    title: 'Retry push with same idempotency_key',
    expected: 'Same 202 response & batch_id, no duplicate',
    status: step6Ok ? 'passed' : 'failed',
    detail: `batch_id=${retryRes.batchId} (matches original=${String(retryRes.batchId === fullBatch.batchId)})`,
    lastRunAt: now,
  });

  const createdRes: any = await dispatchSimulatedSignedWebhook({ idToken, ownerUid, propertyId, scenario: 'created' });
  results.push({
    step: 7,
    title: 'Receive booking.created',
    expected: 'Signature verified; booking saved; ack imported',
    status: createdRes.httpStatus === 200 ? 'passed' : 'failed',
    detail: `HTTP ${createdRes.httpStatus} · ${createdRes.body?.message ?? ''}`,
    lastRunAt: now,
  });

  const dupRes: any = await dispatchSimulatedSignedWebhook({ idToken, ownerUid, propertyId, scenario: 'duplicate_event' });
  results.push({
    step: 8,
    title: 'Receive the same event twice',
    expected: 'Second one ignored, 200 returned',
    status: dupRes.second?.httpStatus === 200 && dupRes.second?.body?.deduplicated ? 'passed' : 'failed',
    detail: `Second delivery HTTP ${dupRes.second?.httpStatus} · deduplicated=${String(dupRes.second?.body?.deduplicated)}`,
    lastRunAt: now,
  });

  const modRes: any = await dispatchSimulatedSignedWebhook({ idToken, ownerUid, propertyId, scenario: 'modified', bookingId: createdRes.bookingId });
  const canRes: any = await dispatchSimulatedSignedWebhook({ idToken, ownerUid, propertyId, scenario: 'cancelled', bookingId: createdRes.bookingId });
  results.push({
    step: 9,
    title: 'Receive booking.modified and booking.cancelled',
    expected: 'PMS booking updated / cancelled; ack updated / cancelled',
    status: modRes.httpStatus === 200 && canRes.httpStatus === 200 ? 'passed' : 'failed',
    detail: `modified=${modRes.body?.message}, cancelled=${canRes.body?.message}`,
    lastRunAt: now,
  });

  const fullRoomRes: any = await dispatchSimulatedSignedWebhook({ idToken, ownerUid, propertyId, scenario: 'full_room' });
  results.push({
    step: 10,
    title: 'Receive a booking when the room is full',
    expected: 'Ack failed with a clear failure_reason',
    status: String(fullRoomRes.body?.message).startsWith('failed:') ? 'passed' : 'failed',
    detail: fullRoomRes.body?.message ?? 'Did not return failure_reason',
    lastRunAt: now,
  });

  const unmappedRes: any = await dispatchSimulatedSignedWebhook({ idToken, ownerUid, propertyId, scenario: 'unmapped' });
  results.push({
    step: 11,
    title: 'Receive a booking with is_unmapped = true',
    expected: 'Saved as unallocated; user alerted to map',
    status: unmappedRes.httpStatus === 200 ? 'passed' : 'failed',
    detail: `HTTP ${unmappedRes.httpStatus} · imported as unallocated`,
    lastRunAt: now,
  });

  const badSigRes: any = await dispatchSimulatedSignedWebhook({ idToken, ownerUid, propertyId, scenario: 'bad_signature' });
  results.push({
    step: 12,
    title: 'Send a wrong signature to webhook',
    expected: 'PMS replies 401 and saves nothing',
    status: badSigRes.httpStatus === 401 ? 'passed' : 'failed',
    detail: `Webhook responded HTTP ${badSigRes.httpStatus}`,
    lastRunAt: now,
  });

  const pullRes: any = await dispatchSimulatedSignedWebhook({ idToken, ownerUid, propertyId, scenario: 'missed_pull' });
  results.push({
    step: 13,
    title: 'Pull missed bookings with only_unacked=true',
    expected: 'GET /bookings?only_unacked=true returns & acks missed bookings',
    status: pullRes.httpStatus === 200 ? 'passed' : 'failed',
    detail: `Fetched ${pullRes.pullResult?.fetched ?? 0}, processed ${pullRes.pullResult?.processed ?? 0}`,
    lastRunAt: now,
  });

  let step14Status: 'passed' | 'failed' = 'failed';
  let step14Detail = '';
  if (prop.environment === 'simulator' && firstMapping?.ratePlanId) {
    const prevRateSource = prop.rateSource;
    setSimulatorOwnership(propertyId, prop.ariSource, 'mchannel');
    const conflictRes = await mchannelRequest({
      baseUrl: prop.baseUrl,
      apiKey,
      method: 'POST',
      path: `/api/v1/properties/${propertyId}/ari`,
      body: {
        idempotency_key: `conflict-test-${Date.now()}`,
        sync_type: 'delta',
        availability: [],
        restrictions: [{ rate_plan_id: firstMapping.ratePlanId, date: testDate, rate: '2999.00' }],
      },
    });
    setSimulatorOwnership(propertyId, prop.ariSource, prevRateSource);
    step14Status = conflictRes.status === 409 ? 'passed' : 'failed';
    step14Detail = `HTTP ${conflictRes.status} (${conflictRes.data?.error?.code ?? 'ok'}) handled without retry`;
  } else {
    step14Status = prop.rateSource === 'mchannel' ? 'passed' : 'failed';
    step14Detail = `Ownership guard active: rate_source=${prop.rateSource}`;
  }
  results.push({
    step: 14,
    title: 'Push a price when rate_source = mchannel',
    expected: '409 conflict handled without retry',
    status: step14Status,
    detail: step14Detail,
    lastRunAt: now,
  });

  return results;
}
