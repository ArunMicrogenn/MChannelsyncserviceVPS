export const MCHANNEL_CONTRACT_VERSION = '1.3.0';

export type MChannelEnvironment = 'staging' | 'production' | 'simulator';
export type PropertyStatus = 'draft' | 'syncing' | 'live' | 'paused';
export type OwnershipSource = 'pms' | 'mchannel';
export type SellMode = 'per_room' | 'per_person';
export type RateMode = 'manual' | 'derived' | 'cascade' | 'auto';
export type SyncType = 'delta' | 'full';
export type AckResult = 'pending' | 'imported' | 'updated' | 'cancelled' | 'failed';

export interface ActiveChannel {
  ota_code: string;
  title: string;
  is_active: boolean;
  connection_id: string;
  last_error?: string | null;
}

export interface PropertyRecord {
  ownerUid: string;
  propertyId: string;
  pmsHotelId: string;
  name: string;
  code: string;
  environment: MChannelEnvironment;
  baseUrl: string;
  webhookUrl: string;
  status: PropertyStatus;
  ariSource: OwnershipSource;
  rateSource: OwnershipSource;
  currency: string;
  timezone: string;
  hasCredentials: boolean;
  activeChannels: ActiveChannel[];
  createdAt: string;
  updatedAt: string;
}

export interface MappingRecord {
  id: string;
  ownerUid: string;
  propertyId: string;
  pmsRoomTypeRef: string;
  pmsRatePlanRef: string | null;
  roomTypeId: string;
  ratePlanId: string | null;
  roomTypeName: string;
  ratePlanName: string;
  sellMode: SellMode;
  rateMode: RateMode;
  countOfRooms: number;
  updatedAt: string;
}

export interface InventoryDayRecord {
  id: string;
  ownerUid: string;
  propertyId: string;
  pmsRoomTypeRef: string;
  roomTypeId: string;
  ratePlanId: string | null;
  date: string;
  totalRooms: number;
  bookedRooms: number;
  freeRooms: number;
  rate: string;
  minStayArrival: number | null;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
  updatedAt: string;
}

export interface AriOutboxRecord {
  id: string;
  ownerUid: string;
  propertyId: string;
  idempotencyKey: string;
  syncType: SyncType;
  status: 'queued' | 'accepted' | 'retry_scheduled' | 'refused';
  httpStatus: number;
  batchId: string | null;
  acceptedItems: number;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  availabilityCount: number;
  restrictionsCount: number;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookingRecord {
  id: string;
  ownerUid: string;
  propertyId: string;
  bookingId: string;
  revisionId: string;
  revisionSeq: number;
  status: 'new' | 'modified' | 'cancelled';
  otaCode: string;
  otaName: string;
  secondaryOtaName: string | null;
  otaReservationCode: string;
  uniqueId: string;
  arrivalDate: string;
  departureDate: string;
  arrivalTime: string | null;
  guestName: string;
  guestEmail: string | null;
  occupancyAdults: number;
  occupancyChildren: number;
  amount: string;
  currency: string;
  otaCommission: string | null;
  pmsRoomTypeRef: string | null;
  pmsRatePlanRef: string | null;
  isUnmapped: boolean;
  ackResult: AckResult;
  ackFailureReason: string | null;
  pmsBookingId: string | null;
  pmsBookingNo: string | null;
  ackedAt: string | null;
  notes: string | null;
  paymentCollect: string | null;
  updatedAt: string;
}

export interface WebhookEventRecord {
  id: string;
  ownerUid: string;
  propertyId: string;
  eventId: string;
  eventType: string;
  signatureValid: boolean;
  httpStatus: number;
  timestampSkewSeconds: number;
  deduplicated: boolean;
  summary: string;
  processedAt: string;
}

export interface StopSaleRecord {
  id: string;
  ownerUid: string;
  propertyId: string;
  stopSaleId: string;
  pmsRoomTypeRef: string | null;
  roomTypeId: string | null;
  dateFrom: string;
  dateTo: string;
  otas: string;
  reason: string;
  status: 'active' | 'reopened';
  createdAt: string;
}

export interface SyncLogRecord {
  id: string;
  ownerUid: string;
  propertyId: string;
  level: 'info' | 'warning' | 'error';
  kind: string;
  message: string;
  requestId: string | null;
  batchId: string | null;
  bookingId: string | null;
  createdAt: string;
}

export interface PairingChecks {
  paired: boolean;
  mapping_saved: boolean;
  unmapped_room_types: number;
  availability_received: boolean;
  rates_received: boolean;
  webhook_registered: boolean;
  property_live: boolean;
  last_booking_acked_at: string | null;
}

export interface ChecklistItemResult {
  step: number;
  title: string;
  expected: string;
  status: 'pending' | 'passed' | 'failed';
  detail: string;
  lastRunAt: string | null;
}
