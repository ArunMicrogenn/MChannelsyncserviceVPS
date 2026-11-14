import crypto from 'node:crypto';
import { MCHANNEL_CONTRACT_VERSION } from '../shared/mchannel.ts';

export interface MChannelResponse<T = any> {
  status: number;
  data: T | null;
  error: string | null;
  requestId: string;
}

interface SimulatorState {
  properties: Map<string, any>;
  roomTypes: Map<string, any[]>;
  ratePlans: Map<string, any[]>;
  mappings: Map<string, any[]>;
  idempotencyCache: Map<string, any>;
  ariAvailability: Map<string, Map<string, any>>;
  ariRates: Map<string, Map<string, any>>;
  stopSales: Map<string, any[]>;
  bookings: Map<string, any[]>;
  syncLogs: Map<string, any[]>;
  checks: Map<string, any>;
}

const simState: SimulatorState = {
  properties: new Map(),
  roomTypes: new Map(),
  ratePlans: new Map(),
  mappings: new Map(),
  idempotencyCache: new Map(),
  ariAvailability: new Map(),
  ariRates: new Map(),
  stopSales: new Map(),
  bookings: new Map(),
  syncLogs: new Map(),
  checks: new Map(),
};

function addSimLog(propertyId: string, level: 'info' | 'warning' | 'error', kind: string, message: string, batchId: string | null = null, bookingId: string | null = null) {
  const logs = simState.syncLogs.get(propertyId) ?? [];
  logs.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    level,
    kind,
    message,
    channex_task_id: null,
    batch_id: batchId,
    booking_id: bookingId,
  });
  simState.syncLogs.set(propertyId, logs.slice(0, 200));
}

export function getSimulatorBookings(propertyId: string) {
  return simState.bookings.get(propertyId) ?? [];
}

export function upsertSimulatorBooking(propertyId: string, booking: any) {
  const list = simState.bookings.get(propertyId) ?? [];
  const idx = list.findIndex((b) => b.id === booking.id);
  const record = { ...booking, _acked: false, _updated_at: new Date().toISOString() };
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...record };
  } else {
    list.unshift(record);
  }
  simState.bookings.set(propertyId, list);
}

export function setSimulatorOwnership(propertyId: string, ariSource: 'pms' | 'mchannel', rateSource: 'pms' | 'mchannel') {
  const prop = simState.properties.get(propertyId);
  if (prop) {
    prop.ari_source = ariSource;
    prop.rate_source = rateSource;
    simState.properties.set(propertyId, prop);
  }
}

export function ensureSimulatorPropertySeeded(params: {
  propertyId: string;
  name: string;
  code: string;
  currency: string;
  timezone: string;
  ariSource: 'pms' | 'mchannel';
  rateSource: 'pms' | 'mchannel';
  mappings: Array<{
    pmsRoomTypeRef: string;
    pmsRatePlanRef: string | null;
    roomTypeId: string;
    ratePlanId: string | null;
    roomTypeName: string;
    ratePlanName: string;
    sellMode: string;
    rateMode: string;
    countOfRooms: number;
  }>;
}) {
  if (simState.properties.has(params.propertyId)) return;

  simState.properties.set(params.propertyId, {
    id: params.propertyId,
    code: params.code || 'SIM',
    name: params.name,
    currency: params.currency,
    timezone: params.timezone,
    status: 'live',
    ari_source: params.ariSource,
    rate_source: params.rateSource,
    channex_property_id: null,
    active_channels: [
      { ota_code: 'BDC', title: `Booking.com - ${params.name}`, is_active: true, connection_id: crypto.randomUUID() },
      { ota_code: 'GMT', title: `MakeMyTrip / Goibibo - ${params.name}`, is_active: true, connection_id: crypto.randomUUID() },
      { ota_code: 'AGO', title: `Agoda - ${params.name}`, is_active: true, connection_id: crypto.randomUUID() },
    ],
  });

  const rtSeen = new Set<string>();
  const rts: any[] = [];
  const rps: any[] = [];
  for (const m of params.mappings) {
    if (!rtSeen.has(m.roomTypeId)) {
      rtSeen.add(m.roomTypeId);
      rts.push({
        id: m.roomTypeId,
        code: m.pmsRoomTypeRef,
        title: m.roomTypeName || 'Standard Room',
        count_of_rooms: m.countOfRooms || 10,
        occ_adults: 3,
        occ_children: 1,
        occ_infants: 1,
        default_occupancy: 2,
        is_active: true,
      });
    }
    if (m.ratePlanId) {
      rps.push({
        id: m.ratePlanId,
        code: m.pmsRatePlanRef || 'EP',
        title: m.ratePlanName || 'Room Only',
        room_type_id: m.roomTypeId,
        sell_mode: m.sellMode || 'per_room',
        rate_mode: m.rateMode || 'manual',
        meal_type: 'room_only',
        currency: params.currency,
        parent_rate_plan_id: null,
        occupancies: [{ occupancy: 2, is_primary: true }],
        is_active: true,
      });
    }
  }
  simState.roomTypes.set(params.propertyId, rts);
  simState.ratePlans.set(params.propertyId, rps);
  simState.mappings.set(
    params.propertyId,
    params.mappings.map((m) => ({
      pms_room_type_ref: m.pmsRoomTypeRef,
      pms_rate_plan_ref: m.pmsRatePlanRef,
      room_type_id: m.roomTypeId,
      rate_plan_id: m.ratePlanId,
    }))
  );
  simState.checks.set(params.propertyId, {
    paired: true,
    mapping_saved: true,
    unmapped_room_types: 0,
    availability_received: true,
    rates_received: params.rateSource === 'pms',
    webhook_registered: true,
    property_live: true,
    last_booking_acked_at: null,
  });
}

function handleSimulatorRequest(
  method: string,
  path: string,
  body: Record<string, any> | null,
  requestId: string
): MChannelResponse {
  const [pathname, queryStr] = path.split('?');
  const query = new URLSearchParams(queryStr ?? '');

  // 1. POST /api/v1/pairing/claim
  if (method === 'POST' && pathname === '/api/v1/pairing/claim') {
    const code = String(body?.code ?? '').trim();
    if (!code || code.length < 6 || code.length > 32) {
      return {
        status: 422,
        requestId,
        error: null,
        data: {
          contract_version: MCHANNEL_CONTRACT_VERSION,
          error: { code: 'validation_error', message: 'Validation failed', details: { code: ['Code must be 6 to 32 chars'] }, request_id: requestId },
        },
      };
    }
    if (code.toUpperCase().includes('EXPIRED')) {
      return {
        status: 410,
        requestId,
        error: null,
        data: { contract_version: MCHANNEL_CONTRACT_VERSION, error: { code: 'code_expired', message: 'Pairing code expired', request_id: requestId } },
      };
    }

    const propId = crypto.randomUUID();
    const hotelName = body?.hotel?.name || 'Hotel Example';
    const currency = body?.hotel?.currency || 'INR';
    const timezone = body?.hotel?.timezone || 'Asia/Kolkata';
    const hotelCode = hotelName.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, 'H');

    const inputRoomTypes = Array.isArray(body?.room_types) && body.room_types.length
      ? body.room_types
      : [
          { pms_ref: 'RT-1', name: 'Standard Room', rooms: 10, base_occupancy: 2, max_occupancy: 3 },
          { pms_ref: 'RT-2', name: 'Deluxe Suite', rooms: 6, base_occupancy: 2, max_occupancy: 4 },
        ];

    const inputRatePlans = Array.isArray(body?.rate_plans) && body.rate_plans.length
      ? body.rate_plans
      : [
          { pms_ref: 'RT-1|EP', pms_room_type_ref: 'RT-1', name: 'Room Only', meal_plan: 'room_only', sell_mode: 'per_room' },
          { pms_ref: 'RT-2|CP', pms_room_type_ref: 'RT-2', name: 'Breakfast Included', meal_plan: 'breakfast', sell_mode: 'per_room' },
        ];

    const rtMap = new Map<string, string>();
    const simRts = inputRoomTypes.map((rt: any) => {
      const id = crypto.randomUUID();
      rtMap.set(rt.pms_ref, id);
      return {
        id,
        code: rt.pms_ref,
        title: rt.name,
        count_of_rooms: Number(rt.rooms ?? 10),
        occ_adults: Number(rt.max_occupancy ?? 3),
        occ_children: 1,
        occ_infants: 1,
        default_occupancy: Number(rt.base_occupancy ?? 2),
        is_active: true,
      };
    });

    const simRps: any[] = [];
    const mappings: any[] = [];
    for (const rp of inputRatePlans) {
      const rtId = rtMap.get(rp.pms_room_type_ref);
      if (!rtId) continue;
      const rpId = crypto.randomUUID();
      simRps.push({
        id: rpId,
        code: rp.pms_ref,
        title: rp.name,
        room_type_id: rtId,
        sell_mode: rp.sell_mode || 'per_room',
        rate_mode: 'manual',
        meal_type: rp.meal_plan || 'room_only',
        currency,
        parent_rate_plan_id: null,
        occupancies: [{ occupancy: 2, is_primary: true }],
        is_active: true,
      });
      mappings.push({
        pms_room_type_ref: rp.pms_room_type_ref,
        pms_rate_plan_ref: rp.pms_ref,
        room_type_id: rtId,
        rate_plan_id: rpId,
      });
    }

    simState.properties.set(propId, {
      id: propId,
      code: hotelCode,
      name: hotelName,
      currency,
      timezone,
      status: 'live',
      ari_source: 'pms',
      rate_source: 'mchannel',
      channex_property_id: null,
      active_channels: [
        { ota_code: 'BDC', title: `Booking.com - ${hotelName}`, is_active: true, connection_id: crypto.randomUUID() },
        { ota_code: 'GMT', title: `MakeMyTrip / Goibibo - ${hotelName}`, is_active: true, connection_id: crypto.randomUUID() },
        { ota_code: 'AGO', title: `Agoda - ${hotelName}`, is_active: true, connection_id: crypto.randomUUID() },
      ],
    });
    simState.roomTypes.set(propId, simRts);
    simState.ratePlans.set(propId, simRps);
    simState.mappings.set(propId, mappings);
    simState.checks.set(propId, {
      paired: true,
      mapping_saved: true,
      unmapped_room_types: 0,
      availability_received: false,
      rates_received: false,
      webhook_registered: Boolean(body?.webhook_url),
      property_live: true,
      last_booking_acked_at: null,
    });

    addSimLog(propId, 'info', 'pairing', `Hotel ${hotelName} paired via code ${code}`);

    return {
      status: 201,
      requestId,
      error: null,
      data: {
        contract_version: MCHANNEL_CONTRACT_VERSION,
        data: {
          api_key: `mck_sim_${crypto.randomBytes(16).toString('hex')}`,
          webhook_secret: `whsec_sim_${crypto.randomBytes(16).toString('hex')}`,
          base_url: 'simulator://mchannel.local',
          property: {
            id: propId,
            name: hotelName,
            code: hotelCode,
            status: 'live',
            ari_source: 'pms',
            rate_source: 'mchannel',
          },
          mode: 'new',
          mappings,
          unmatched: { pms_room_types: [], pms_rate_plans: [], room_types: [], rate_plans: [] },
          filled_fields: ['city', 'timezone', 'currency'],
          next_steps: ['Push availability for the next 365 days'],
        },
      },
    };
  }

  // 2. GET /api/v1/pairing/status
  if (method === 'GET' && pathname === '/api/v1/pairing/status') {
    const pid = query.get('property_id');
    const items: any[] = [];
    for (const [id, prop] of simState.properties.entries()) {
      if (pid && pid !== id) continue;
      items.push({
        property_id: id,
        name: prop.name,
        status: prop.status,
        checks: simState.checks.get(id) ?? {
          paired: true,
          mapping_saved: true,
          unmapped_room_types: 0,
          availability_received: true,
          rates_received: prop.rate_source === 'pms',
          webhook_registered: true,
          property_live: prop.status === 'live',
          last_booking_acked_at: null,
        },
      });
    }
    return { status: 200, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: items } };
  }

  // 3. GET /api/v1/properties
  if (method === 'GET' && pathname === '/api/v1/properties') {
    return {
      status: 200,
      requestId,
      error: null,
      data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: Array.from(simState.properties.values()) },
    };
  }

  // Property subroutes
  const propMatch = pathname.match(/^\/api\/v1\/properties\/([^/]+)(\/.*)?$/);
  if (propMatch) {
    const propId = propMatch[1];
    const sub = propMatch[2] ?? '';
    const prop = simState.properties.get(propId);
    if (!prop) {
      return {
        status: 404,
        requestId,
        error: null,
        data: { contract_version: MCHANNEL_CONTRACT_VERSION, error: { code: 'not_found', message: 'Unknown hotel', request_id: requestId } },
      };
    }

    if (method === 'GET' && sub === '/room-types') {
      return { status: 200, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: simState.roomTypes.get(propId) ?? [] } };
    }

    if (method === 'GET' && sub === '/rate-plans') {
      return { status: 200, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: simState.ratePlans.get(propId) ?? [] } };
    }

    if (method === 'PUT' && sub === '/mappings') {
      const mappings = Array.isArray(body?.mappings) ? body.mappings : [];
      simState.mappings.set(propId, mappings);
      const checks = simState.checks.get(propId) ?? {};
      checks.mapping_saved = mappings.length > 0;
      simState.checks.set(propId, checks);
      addSimLog(propId, 'info', 'mapping_update', `Saved ${mappings.length} room/rate mapping(s)`);
      return {
        status: 200,
        requestId,
        error: null,
        data: {
          contract_version: MCHANNEL_CONTRACT_VERSION,
          data: { saved: mappings.length, unmapped_room_types: [], unmapped_rate_plans: [] },
        },
      };
    }

    if (method === 'POST' && sub === '/ari') {
      const idemKey = String(body?.idempotency_key ?? '');
      if (idemKey.length < 8 || idemKey.length > 100) {
        return {
          status: 422,
          requestId,
          error: null,
          data: {
            contract_version: MCHANNEL_CONTRACT_VERSION,
            error: { code: 'validation_error', message: 'Validation failed', details: { idempotency_key: ['Must be 8 to 100 characters'] }, request_id: requestId },
          },
        };
      }

      const cacheKey = `${propId}:${idemKey}`;
      if (simState.idempotencyCache.has(cacheKey)) {
        return { status: 202, requestId, error: null, data: simState.idempotencyCache.get(cacheKey) };
      }

      const availability = Array.isArray(body?.availability) ? body.availability : [];
      const restrictions = Array.isArray(body?.restrictions) ? body.restrictions : [];

      // Ownership conflict checks per section 6.3
      if (availability.length > 0 && prop.ari_source !== 'pms') {
        return {
          status: 409,
          requestId,
          error: null,
          data: {
            contract_version: MCHANNEL_CONTRACT_VERSION,
            error: { code: 'conflict', message: 'Availability is managed in M-Channel (ari_source = mchannel)', request_id: requestId },
          },
        };
      }

      const hasRateChange = restrictions.some((r: any) => r.rate !== undefined || (Array.isArray(r.rates) && r.rates.length > 0));
      if (hasRateChange && prop.rate_source !== 'pms') {
        return {
          status: 409,
          requestId,
          error: null,
          data: {
            contract_version: MCHANNEL_CONTRACT_VERSION,
            error: { code: 'conflict', message: 'Prices are managed in M-Channel (rate_source = mchannel). Do not retry.', request_id: requestId },
          },
        };
      }

      // Store availability in simulator calendar
      const availMap = simState.ariAvailability.get(propId) ?? new Map<string, any>();
      const mappings = simState.mappings.get(propId) ?? [];
      const nowIso = new Date().toISOString();

      let acceptedItems = 0;
      for (const item of availability) {
        acceptedItems++;
        const ref = mappings.find((m) => m.room_type_id === item.room_type_id)?.pms_room_type_ref ?? 'RT';
        const dates = expandDates(item.date, item.date_from, item.date_to);
        for (const d of dates) {
          availMap.set(`${item.room_type_id}:${d}`, {
            room_type_id: item.room_type_id,
            pms_room_type_ref: ref,
            date: d,
            availability: item.availability,
            updated_at: nowIso,
          });
        }
      }
      simState.ariAvailability.set(propId, availMap);

      const ratesMap = simState.ariRates.get(propId) ?? new Map<string, any>();
      for (const item of restrictions) {
        acceptedItems++;
        const ref = mappings.find((m) => m.rate_plan_id === item.rate_plan_id)?.pms_rate_plan_ref ?? 'RP';
        const dates = expandDates(item.date, item.date_from, item.date_to, item.days);
        for (const d of dates) {
          const existing = ratesMap.get(`${item.rate_plan_id}:${d}`) ?? {
            rate_plan_id: item.rate_plan_id,
            pms_rate_plan_ref: ref,
            date: d,
            occupancy: 0,
            rate: '2800.00',
            min_stay_arrival: null,
            min_stay_through: null,
            max_stay: null,
            closed_to_arrival: null,
            closed_to_departure: null,
            stop_sell: null,
          };
          ratesMap.set(`${item.rate_plan_id}:${d}`, {
            ...existing,
            rate: item.rate ?? existing.rate,
            min_stay_arrival: item.min_stay_arrival ?? existing.min_stay_arrival,
            min_stay_through: item.min_stay_through ?? existing.min_stay_through,
            max_stay: item.max_stay ?? existing.max_stay,
            closed_to_arrival: item.closed_to_arrival ?? existing.closed_to_arrival,
            closed_to_departure: item.closed_to_departure ?? existing.closed_to_departure,
            stop_sell: item.stop_sell ?? existing.stop_sell,
            updated_at: nowIso,
          });
        }
      }
      simState.ariRates.set(propId, ratesMap);

      const checks = simState.checks.get(propId) ?? {};
      if (availability.length > 0) checks.availability_received = true;
      if (hasRateChange) checks.rates_received = true;
      simState.checks.set(propId, checks);

      const batchId = crypto.randomUUID();
      const responsePayload = {
        contract_version: MCHANNEL_CONTRACT_VERSION,
        data: { batch_id: batchId, accepted_items: acceptedItems, queued_at: nowIso },
      };
      simState.idempotencyCache.set(cacheKey, responsePayload);
      addSimLog(propId, 'info', 'ari_push', `ARI batch queued: ${availability.length} availability, ${restrictions.length} restrictions (${body?.sync_type ?? 'delta'})`, batchId);

      return { status: 202, requestId, error: null, data: responsePayload };
    }

    if (method === 'GET' && sub === '/ari') {
      const dateFrom = query.get('date_from') || '2026-01-01';
      const dateTo = query.get('date_to') || '2028-12-31';
      const changedSince = query.get('changed_since');
      const avail = Array.from((simState.ariAvailability.get(propId) ?? new Map()).values()).filter(
        (a) => a.date >= dateFrom && a.date <= dateTo && (!changedSince || a.updated_at > changedSince)
      );
      const rates = Array.from((simState.ariRates.get(propId) ?? new Map()).values()).filter(
        (r) => r.date >= dateFrom && r.date <= dateTo && (!changedSince || r.updated_at > changedSince)
      );
      return {
        status: 200,
        requestId,
        error: null,
        data: {
          contract_version: MCHANNEL_CONTRACT_VERSION,
          data: {
            property_id: propId,
            ari_source: prop.ari_source,
            rate_source: prop.rate_source,
            currency: prop.currency,
            availability: avail.slice(0, 400),
            rates: rates.slice(0, 400),
          },
        },
      };
    }

    if (method === 'GET' && sub === '/stop-sales') {
      return { status: 200, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: simState.stopSales.get(propId) ?? [] } };
    }

    if (method === 'POST' && sub === '/stop-sales') {
      const item = {
        id: crypto.randomUUID(),
        property_id: propId,
        room_type_id: body?.room_type_id ?? null,
        pms_room_type_ref: body?.pms_room_type_ref ?? null,
        date_from: body?.date_from,
        date_to: body?.date_to,
        otas: body?.otas ?? 'all',
        reason: body?.reason ?? '',
        status: 'active',
        created_at: new Date().toISOString(),
      };
      const list = simState.stopSales.get(propId) ?? [];
      list.unshift(item);
      simState.stopSales.set(propId, list);
      addSimLog(propId, 'warning', 'stop_sale', `Stop sale created (${item.date_from} to ${item.date_to})`);
      return { status: 201, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: item } };
    }

    const reopenMatch = sub.match(/^\/stop-sales\/([^/]+)\/reopen$/);
    if (method === 'POST' && reopenMatch) {
      const stopSaleId = reopenMatch[1];
      const list = simState.stopSales.get(propId) ?? [];
      const target = list.find((s) => s.id === stopSaleId);
      if (!target) {
        return { status: 404, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, error: { code: 'not_found', message: 'Stop sale not found', request_id: requestId } } };
      }
      target.status = 'reopened';
      addSimLog(propId, 'info', 'stop_sale', `Stop sale ${stopSaleId} reopened`);
      return { status: 200, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: target } };
    }

    if (method === 'GET' && sub === '/bookings') {
      const since = query.get('since') || '1970-01-01T00:00:00Z';
      const onlyUnacked = query.get('only_unacked') === 'true';
      const statusFilter = query.get('status');
      const limit = Math.min(Number(query.get('limit') || 50), 100);

      let list = simState.bookings.get(propId) ?? [];
      list = list.filter((b) => {
        if ((b._updated_at || b.received_at) < since) return false;
        if (onlyUnacked && b._acked) return false;
        if (statusFilter && b.status !== statusFilter) return false;
        return true;
      });
      return {
        status: 200,
        requestId,
        error: null,
        data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: list.slice(0, limit), next_cursor: null },
      };
    }

    if (method === 'GET' && sub === '/health') {
      const list = simState.bookings.get(propId) ?? [];
      const unacked = list.filter((b) => !b._acked).length;
      return {
        status: 200,
        requestId,
        error: null,
        data: {
          contract_version: MCHANNEL_CONTRACT_VERSION,
          data: {
            property_id: propId,
            status: prop.status,
            outbox_pending: 0,
            last_push_at: new Date().toISOString(),
            last_push_ok: true,
            unacked_bookings: unacked,
            channels: prop.active_channels.map((c: any) => ({ ...c, last_error: null })),
          },
        },
      };
    }

    if (method === 'GET' && sub === '/sync-log') {
      return {
        status: 200,
        requestId,
        error: null,
        data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: simState.syncLogs.get(propId) ?? [], next_cursor: null },
      };
    }
  }

  // Booking ack / no-show / cancel-request
  const bookingAckMatch = pathname.match(/^\/api\/v1\/bookings\/([^/]+)\/(ack|no-show|cancel-request)$/);
  if (method === 'POST' && bookingAckMatch) {
    const bookingId = bookingAckMatch[1];
    const action = bookingAckMatch[2];
    const nowIso = new Date().toISOString();

    for (const [propId, bookings] of simState.bookings.entries()) {
      const b = bookings.find((item) => item.id === bookingId);
      if (b) {
        if (action === 'ack') {
          b._acked = true;
          b._ack_result = body?.result;
          const checks = simState.checks.get(propId) ?? {};
          checks.last_booking_acked_at = nowIso;
          simState.checks.set(propId, checks);
          addSimLog(propId, body?.result === 'failed' ? 'error' : 'info', 'booking_ack', `Booking ${bookingId} acked: ${body?.result}`, null, bookingId);
          return {
            status: 200,
            requestId,
            error: null,
            data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: { booking_id: bookingId, revision_id: body?.revision_id, acked_at: nowIso } },
          };
        }
        if (action === 'no-show') {
          addSimLog(propId, 'warning', 'ota_no_show', `Reported no-show for booking ${bookingId}`, null, bookingId);
          return { status: 200, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: { booking_id: bookingId, reported: true } } };
        }
        if (action === 'cancel-request') {
          addSimLog(propId, 'warning', 'ota_cancel_request', `Requested invalid-card cancellation for booking ${bookingId}`, null, bookingId);
          return { status: 200, requestId, error: null, data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: { booking_id: bookingId, requested: true } } };
        }
      }
    }

    // Even if simulator didn't hold booking in RAM yet (e.g. cold restart), accept valid ack cleanly
    if (action === 'ack') {
      return {
        status: 200,
        requestId,
        error: null,
        data: { contract_version: MCHANNEL_CONTRACT_VERSION, data: { booking_id: bookingId, revision_id: body?.revision_id, acked_at: nowIso } },
      };
    }

    return {
      status: 404,
      requestId,
      error: null,
      data: { contract_version: MCHANNEL_CONTRACT_VERSION, error: { code: 'not_found', message: 'Unknown booking', request_id: requestId } },
    };
  }

  return {
    status: 404,
    requestId,
    error: null,
    data: { contract_version: MCHANNEL_CONTRACT_VERSION, error: { code: 'not_found', message: `Unknown path: ${path}`, request_id: requestId } },
  };
}

function expandDates(single?: string, from?: string, to?: string, daysFilter?: string[]): string[] {
  if (single) return [single];
  if (!from || !to) return [];
  const res: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const dayCodes = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
  let cur = new Date(start);
  let guard = 0;
  while (cur <= end && guard < 400) {
    const code = dayCodes[cur.getUTCDay()];
    if (!daysFilter || daysFilter.length === 0 || daysFilter.includes(code)) {
      res.push(cur.toISOString().slice(0, 10));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return res;
}

export async function mchannelRequest<T = any>(params: {
  baseUrl: string;
  apiKey?: string | null;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, any> | null;
}): Promise<MChannelResponse<T>> {
  const requestId = crypto.randomUUID();
  const payload = params.body ? { contract_version: MCHANNEL_CONTRACT_VERSION, ...params.body } : null;

  if (params.baseUrl.startsWith('simulator://')) {
    return handleSimulatorRequest(params.method, params.path, payload, requestId);
  }

  const cleanBase = params.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-Id': requestId,
  };
  if (params.apiKey) {
    headers['X-MChannel-Key'] = params.apiKey;
  }
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(`${cleanBase}${params.path}`, {
      method: params.method,
      headers,
      body: payload !== null ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(30000),
    });

    const rawText = await res.text();
    let parsed: any = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = { raw: rawText.slice(0, 500) };
    }

    return {
      status: res.status,
      data: parsed,
      error: null,
      requestId,
    };
  } catch (err: any) {
    return {
      status: 0,
      data: null,
      error: err?.message || 'Network error',
      requestId,
    };
  }
}
