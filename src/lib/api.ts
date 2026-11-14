import { auth } from './firebase';
import type {
  PropertyRecord,
  MappingRecord,
  InventoryDayRecord,
  AriOutboxRecord,
  BookingRecord,
  WebhookEventRecord,
  StopSaleRecord,
  SyncLogRecord,
  ChecklistItemResult,
  MChannelEnvironment,
} from '../shared/mchannel';

export interface PropertySnapshot {
  property: PropertyRecord;
  mappings: MappingRecord[];
  inventory: InventoryDayRecord[];
  outbox: AriOutboxRecord[];
  bookings: BookingRecord[];
  webhookEvents: WebhookEventRecord[];
  stopSales: StopSaleRecord[];
  syncLogs: SyncLogRecord[];
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Not authenticated');
  }
  const token = await user.getIdToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const syncApi = {
  listProperties: () => apiFetch<{ properties: PropertyRecord[] }>('/api/sync/properties'),

  claimPairing: (payload: {
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
  }) =>
    apiFetch<{ property: PropertyRecord; nextSteps: string[] }>('/api/sync/pairing/claim', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getSnapshot: (propertyId: string) =>
    apiFetch<PropertySnapshot>(`/api/sync/properties/${propertyId}/snapshot`),

  refreshSetup: (propertyId: string) =>
    apiFetch<{ remoteProperty: any; roomTypes: any[]; ratePlans: any[]; pairingStatus: any }>(
      `/api/sync/properties/${propertyId}/refresh`,
      { method: 'POST' }
    ),

  saveMappings: (propertyId: string, mappings: any[]) =>
    apiFetch(`/api/sync/properties/${propertyId}/mappings`, {
      method: 'PUT',
      body: JSON.stringify({ mappings }),
    }),

  pushFull365: (propertyId: string) =>
    apiFetch<{ outbox: AriOutboxRecord }>(`/api/sync/properties/${propertyId}/ari/full-365`, {
      method: 'POST',
    }),

  pushAriBatch: (
    propertyId: string,
    payload: {
      syncType: 'delta' | 'full';
      availability: any[];
      restrictions: any[];
      bypassOwnershipGuard?: boolean;
    }
  ) =>
    apiFetch<{ outbox: AriOutboxRecord }>(`/api/sync/properties/${propertyId}/ari/push`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateInventoryDay: (
    propertyId: string,
    payload: {
      pmsRoomTypeRef: string;
      date: string;
      freeRooms: number;
      rate?: string;
      minStayArrival?: number | null;
      stopSell?: boolean;
    }
  ) =>
    apiFetch<{ inventoryDay: InventoryDayRecord; outbox: AriOutboxRecord | null }>(
      `/api/sync/properties/${propertyId}/inventory/update`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  retryOutbox: (propertyId: string, idempotencyKey: string) =>
    apiFetch<{ outbox: AriOutboxRecord }>(
      `/api/sync/properties/${propertyId}/outbox/${encodeURIComponent(idempotencyKey)}/retry`,
      { method: 'POST' }
    ),

  readRemoteAri: (propertyId: string, dateFrom: string, dateTo: string, changedSince?: string) => {
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (changedSince) qs.set('changed_since', changedSince);
    return apiFetch<{ calendar: any }>(`/api/sync/properties/${propertyId}/ari/remote?${qs.toString()}`);
  },

  createStopSale: (
    propertyId: string,
    payload: { pmsRoomTypeRef: string | null; dateFrom: string; dateTo: string; otas: 'all' | string[]; reason: string }
  ) =>
    apiFetch<{ stopSale: StopSaleRecord }>(`/api/sync/properties/${propertyId}/stop-sales`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  reopenStopSale: (propertyId: string, stopSaleId: string) =>
    apiFetch(`/api/sync/properties/${propertyId}/stop-sales/${stopSaleId}/reopen`, {
      method: 'POST',
    }),

  pullBookings: (propertyId: string, since: string, onlyUnacked: boolean) =>
    apiFetch<{ fetched: number; processed: number }>(`/api/sync/properties/${propertyId}/bookings/pull`, {
      method: 'POST',
      body: JSON.stringify({ since, onlyUnacked }),
    }),

  reportNoShow: (propertyId: string, bookingId: string, waiveFees: boolean) =>
    apiFetch(`/api/sync/properties/${propertyId}/bookings/${bookingId}/no-show`, {
      method: 'POST',
      body: JSON.stringify({ waiveFees }),
    }),

  requestInvalidCardCancel: (propertyId: string, bookingId: string, note: string) =>
    apiFetch(`/api/sync/properties/${propertyId}/bookings/${bookingId}/cancel-request`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  getDiagnostics: (propertyId: string) =>
    apiFetch<{ health: any; remoteLogs: any[]; pairingStatus: any }>(
      `/api/sync/properties/${propertyId}/diagnostics`
    ),

  simulateWebhook: (
    propertyId: string,
    scenario: 'created' | 'modified' | 'cancelled' | 'unmapped' | 'full_room' | 'bad_signature' | 'duplicate_event' | 'missed_pull',
    bookingId?: string
  ) =>
    apiFetch<any>(`/api/sync/properties/${propertyId}/webhooks/simulate`, {
      method: 'POST',
      body: JSON.stringify({ scenario, bookingId }),
    }),

  runChecklist: (propertyId: string) =>
    apiFetch<{ results: ChecklistItemResult[] }>(`/api/sync/properties/${propertyId}/checklist/run`, {
      method: 'POST',
    }),

  getVpsBundle: () =>
    apiFetch<{ files: Array<{ path: string; content: string }> }>('/api/sync/vps-bundle'),
};
