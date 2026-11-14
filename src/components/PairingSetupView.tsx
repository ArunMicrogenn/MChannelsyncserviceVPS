import React, { useState } from 'react';
import { Check, KeyRound, Link2, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { syncApi, type PropertySnapshot } from '../lib/api';
import type { MChannelEnvironment, MappingRecord } from '../shared/mchannel';

interface PairingSetupViewProps {
  snapshot: PropertySnapshot | null;
  onPaired: (propertyId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const inputCls =
  'w-full px-3 py-2 text-sm bg-[#040C16] border border-[#16384C] rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-400';

export const PairingSetupView: React.FC<PairingSetupViewProps> = ({
  snapshot,
  onPaired,
  onRefresh,
}) => {
  const [environment, setEnvironment] = useState<MChannelEnvironment>('simulator');
  const [baseUrl, setBaseUrl] = useState('https://stagcm.microgenn.com');
  const [code, setCode] = useState('MCH-7F3K-92QD');
  const [pmsName, setPmsName] = useState('NodePMS');
  const [pmsVersion, setPmsVersion] = useState('1.3.0');
  const [pmsHotelId, setPmsHotelId] = useState('H001');
  const [hotelName, setHotelName] = useState('Hotel Example');
  const [city, setCity] = useState('Coimbatore');
  const [country, setCountry] = useState('IN');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [currency, setCurrency] = useState('INR');
  const [checkinTime, setCheckinTime] = useState('12:00');
  const [checkoutTime, setCheckoutTime] = useState('11:00');
  const [webhookBaseUrl, setWebhookBaseUrl] = useState(() => window.location.origin);

  const [roomTypes, setRoomTypes] = useState([
    { pms_ref: 'RT-1', name: 'Standard Room', rooms: 10, base_occupancy: 2, max_occupancy: 3 },
    { pms_ref: 'RT-2', name: 'Deluxe Suite', rooms: 6, base_occupancy: 2, max_occupancy: 4 },
  ]);
  const [ratePlans, setRatePlans] = useState([
    { pms_ref: 'RT-1|EP', pms_room_type_ref: 'RT-1', name: 'Room Only', meal_plan: 'room_only', sell_mode: 'per_room' },
    { pms_ref: 'RT-2|CP', pms_room_type_ref: 'RT-2', name: 'Breakfast Included', meal_plan: 'breakfast', sell_mode: 'per_room' },
  ]);

  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingSuccess, setPairingSuccess] = useState<string | null>(null);

  const [editableMappings, setEditableMappings] = useState<MappingRecord[]>(snapshot?.mappings ?? []);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [mappingNotice, setMappingNotice] = useState<string | null>(null);

  React.useEffect(() => {
    setEditableMappings(snapshot?.mappings ?? []);
  }, [snapshot?.property.propertyId, snapshot?.mappings]);

  const handlePairSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPairingBusy(true);
    setPairingError(null);
    setPairingSuccess(null);
    try {
      const res = await syncApi.claimPairing({
        environment,
        baseUrl: environment === 'staging' ? baseUrl : undefined,
        code,
        pmsName,
        pmsVersion,
        instanceUrl: window.location.origin,
        webhookBaseUrl,
        hotel: {
          pmsHotelId,
          name: hotelName,
          city,
          country,
          timezone,
          currency,
          checkinTime,
          checkoutTime,
        },
        roomTypes,
        ratePlans,
      });
      setPairingSuccess(`Paired ${res.property.name} (${res.property.propertyId}). Credentials encrypted with AES-256-GCM.`);
      await onPaired(res.property.propertyId);
    } catch (err: any) {
      setPairingError(err?.message || 'Pairing claim failed');
    } finally {
      setPairingBusy(false);
    }
  };

  const handleSaveMappings = async () => {
    if (!snapshot) return;
    setMappingBusy(true);
    setMappingNotice(null);
    try {
      await syncApi.saveMappings(snapshot.property.propertyId, editableMappings);
      setMappingNotice('Mappings saved to M-Channel and synced.');
      await onRefresh();
    } catch (err: any) {
      setMappingNotice(`Error: ${err?.message || 'Failed to update mappings'}`);
    } finally {
      setMappingBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#112A3A]">
          <div>
            <h2 className="text-lg font-semibold text-white">01. One-Time Hotel Pairing</h2>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Claims a 30-minute one-time code via <code className="text-xs bg-[#0A2233] text-cyan-300 px-1.5 py-0.5 rounded">POST /api/v1/pairing/claim</code> and stores API key &amp; webhook secret encrypted with AES-256-GCM.
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 bg-[#040C16] border border-[#133144] rounded-lg shrink-0">
            {(['simulator', 'staging', 'production'] as MChannelEnvironment[]).map((env) => (
              <button
                key={env}
                type="button"
                onClick={() => {
                  setEnvironment(env);
                  if (env === 'staging') setBaseUrl('https://stagcm.microgenn.com');
                  if (env === 'production') setBaseUrl('https://cmlive.microgenn.com');
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  environment === env
                    ? 'bg-cyan-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {env === 'simulator' ? 'Contract Simulator' : env === 'staging' ? 'Staging' : 'Production'}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handlePairSubmit} className="mt-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">One-Time Pairing Code</label>
              <input
                type="text"
                required
                minLength={6}
                maxLength={32}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="MCH-7F3K-92QD"
                className={`${inputCls} font-mono`}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Target Base URL</label>
              <input
                type="text"
                readOnly={environment !== 'staging'}
                value={
                  environment === 'simulator'
                    ? 'simulator://mchannel.local'
                    : environment === 'production'
                    ? 'https://cmlive.microgenn.com'
                    : baseUrl
                }
                onChange={(e) => setBaseUrl(e.target.value)}
                className={`${inputCls} font-mono text-cyan-300`}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Webhook Receiver Base URL</label>
              <input
                type="url"
                required
                value={webhookBaseUrl}
                onChange={(e) => setWebhookBaseUrl(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">PMS Hotel ID</label>
              <input
                type="text"
                required
                value={pmsHotelId}
                onChange={(e) => setPmsHotelId(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Hotel Name</label>
              <input
                type="text"
                required
                value={hotelName}
                onChange={(e) => setHotelName(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">City / Country</label>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className={`col-span-2 ${inputCls}`}
                />
                <input
                  type="text"
                  maxLength={2}
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                  className={`${inputCls} font-mono`}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Currency / Timezone</label>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  maxLength={3}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  className={`${inputCls} font-mono`}
                />
                <input
                  type="text"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className={`col-span-2 ${inputCls} font-mono`}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">PMS Name</label>
              <input
                type="text"
                required
                value={pmsName}
                onChange={(e) => setPmsName(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">PMS Version</label>
              <input
                type="text"
                value={pmsVersion}
                onChange={(e) => setPmsVersion(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Check-in Time</label>
              <input
                type="text"
                value={checkinTime}
                onChange={(e) => setCheckinTime(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Check-out Time</label>
              <input
                type="text"
                value={checkoutTime}
                onChange={(e) => setCheckoutTime(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>
          </div>

          <div className="pt-4 border-t border-[#112A3A] grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200">PMS Room Types to Pair</span>
                <button
                  type="button"
                  onClick={() =>
                    setRoomTypes((prev) => [
                      ...prev,
                      {
                        pms_ref: `RT-${prev.length + 1}`,
                        name: `Room Category ${prev.length + 1}`,
                        rooms: 5,
                        base_occupancy: 2,
                        max_occupancy: 3,
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-cyan-300 hover:text-cyan-200"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Room Type
                </button>
              </div>
              <div className="space-y-2">
                {roomTypes.map((rt, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                    <input
                      type="text"
                      value={rt.pms_ref}
                      onChange={(e) => {
                        const next = [...roomTypes];
                        next[idx].pms_ref = e.target.value;
                        setRoomTypes(next);
                      }}
                      placeholder="Ref"
                      className="col-span-3 px-2.5 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
                    />
                    <input
                      type="text"
                      value={rt.name}
                      onChange={(e) => {
                        const next = [...roomTypes];
                        next[idx].name = e.target.value;
                        setRoomTypes(next);
                      }}
                      placeholder="Name"
                      className="col-span-5 px-2.5 py-1.5 text-xs bg-[#040C16] border border-[#16384C] rounded text-slate-100"
                    />
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      value={rt.rooms}
                      onChange={(e) => {
                        const next = [...roomTypes];
                        next[idx].rooms = Number(e.target.value);
                        setRoomTypes(next);
                      }}
                      placeholder="Count"
                      className="col-span-3 px-2.5 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={() => setRoomTypes((prev) => prev.filter((_, i) => i !== idx))}
                      className="col-span-1 text-slate-500 hover:text-red-400 flex justify-center"
                      aria-label="Remove room type"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200">PMS Rate Plans to Pair</span>
                <button
                  type="button"
                  onClick={() =>
                    setRatePlans((prev) => [
                      ...prev,
                      {
                        pms_ref: `RT-1|RP${prev.length + 1}`,
                        pms_room_type_ref: roomTypes[0]?.pms_ref || 'RT-1',
                        name: 'Special Rate',
                        meal_plan: 'room_only',
                        sell_mode: 'per_room',
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-cyan-300 hover:text-cyan-200"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Rate Plan
                </button>
              </div>
              <div className="space-y-2">
                {ratePlans.map((rp, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                    <input
                      type="text"
                      value={rp.pms_ref}
                      onChange={(e) => {
                        const next = [...ratePlans];
                        next[idx].pms_ref = e.target.value;
                        setRatePlans(next);
                      }}
                      placeholder="Rate Ref"
                      className="col-span-3 px-2.5 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
                    />
                    <input
                      type="text"
                      value={rp.pms_room_type_ref}
                      onChange={(e) => {
                        const next = [...ratePlans];
                        next[idx].pms_room_type_ref = e.target.value;
                        setRatePlans(next);
                      }}
                      placeholder="Room Ref"
                      className="col-span-3 px-2.5 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
                    />
                    <input
                      type="text"
                      value={rp.name}
                      onChange={(e) => {
                        const next = [...ratePlans];
                        next[idx].name = e.target.value;
                        setRatePlans(next);
                      }}
                      placeholder="Plan Name"
                      className="col-span-5 px-2.5 py-1.5 text-xs bg-[#040C16] border border-[#16384C] rounded text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={() => setRatePlans((prev) => prev.filter((_, i) => i !== idx))}
                      className="col-span-1 text-slate-500 hover:text-red-400 flex justify-center"
                      aria-label="Remove rate plan"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {pairingError && (
            <div className="p-3 bg-red-950/60 border border-red-700/70 rounded-lg text-xs text-red-200 font-mono">
              {pairingError}
            </div>
          )}
          {pairingSuccess && (
            <div className="p-3 bg-[#062426] border border-emerald-700/60 rounded-lg text-xs text-emerald-200 flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0 text-emerald-400" />
              <span>{pairingSuccess}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              type="submit"
              disabled={pairingBusy}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <KeyRound className="w-4 h-4" />
              {pairingBusy ? 'Claiming Pairing Code...' : 'Claim Code & Store Encrypted Credentials'}
            </button>
          </div>
        </form>
      </section>

      {snapshot && (
        <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#112A3A]">
            <div>
              <h2 className="text-lg font-semibold text-white">02. Room Type &amp; Rate Plan Mappings</h2>
              <p className="text-xs sm:text-sm text-slate-400 mt-1">
                Maps PMS references to M-Channel UUIDs via <code className="text-xs bg-[#0A2233] text-cyan-300 px-1.5 py-0.5 rounded">PUT /api/v1/properties/:id/mappings</code>. Ownership: ari_source={snapshot.property.ariSource} · rate_source={snapshot.property.rateSource}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={async () => {
                  await syncApi.refreshSetup(snapshot.property.propertyId);
                  await onRefresh();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#0A1D2D] border border-[#193F56] hover:bg-[#102A40] rounded-lg whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Sync Remote Setup
              </button>
              <button
                type="button"
                disabled={mappingBusy}
                onClick={handleSaveMappings}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg whitespace-nowrap shrink-0"
              >
                <Link2 className="w-3.5 h-3.5" /> {mappingBusy ? 'Saving...' : 'Save Mappings'}
              </button>
            </div>
          </div>

          {mappingNotice && (
            <div className="mt-4 p-3 bg-[#040C16] border border-[#16384C] rounded-lg text-xs font-mono text-cyan-200">
              {mappingNotice}
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#133144] text-xs font-medium text-slate-400">
                  <th className="py-2.5 pr-4">PMS Room Ref</th>
                  <th className="py-2.5 pr-4">Room Name</th>
                  <th className="py-2.5 pr-4">M-Channel Room UUID</th>
                  <th className="py-2.5 pr-4">PMS Rate Ref</th>
                  <th className="py-2.5 pr-4">M-Channel Rate UUID</th>
                  <th className="py-2.5 pr-4">Sell / Rate Mode</th>
                  <th className="py-2.5 text-right">Rooms</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0E2433] text-sm">
                {editableMappings.map((m, idx) => (
                  <tr key={m.id} className="hover:bg-[#081A2A]">
                    <td className="py-2.5 pr-4 font-mono text-xs">
                      <input
                        type="text"
                        value={m.pmsRoomTypeRef}
                        onChange={(e) => {
                          const next = [...editableMappings];
                          next[idx] = { ...next[idx], pmsRoomTypeRef: e.target.value };
                          setEditableMappings(next);
                        }}
                        className="w-24 px-2 py-1 bg-[#040C16] border border-[#16384C] rounded text-xs font-mono text-slate-100"
                      />
                    </td>
                    <td className="py-2.5 pr-4 text-slate-100">{m.roomTypeName}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-cyan-300">{m.roomTypeId}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">
                      <input
                        type="text"
                        value={m.pmsRatePlanRef ?? ''}
                        onChange={(e) => {
                          const next = [...editableMappings];
                          next[idx] = { ...next[idx], pmsRatePlanRef: e.target.value || null };
                          setEditableMappings(next);
                        }}
                        className="w-28 px-2 py-1 bg-[#040C16] border border-[#16384C] rounded text-xs font-mono text-slate-100"
                      />
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-400">{m.ratePlanId ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-300">
                      {m.sellMode} · {m.rateMode}
                    </td>
                    <td className="py-2.5 text-right font-mono text-xs text-slate-100 tabular-nums">
                      {m.countOfRooms}
                    </td>
                  </tr>
                ))}
                {editableMappings.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-sm text-slate-500">
                      No mappings recorded for this property yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};
