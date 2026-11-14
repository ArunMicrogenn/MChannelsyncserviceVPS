import React, { useState } from 'react';
import { Calendar, UploadCloud, RotateCcw, Ban, Unlock, Search } from 'lucide-react';
import { syncApi, type PropertySnapshot } from '../lib/api';

interface AriInventoryViewProps {
  snapshot: PropertySnapshot;
  onRefresh: () => Promise<void>;
}

export const AriInventoryView: React.FC<AriInventoryViewProps> = ({ snapshot, onRefresh }) => {
  const { property, mappings, inventory, outbox, stopSales } = snapshot;

  const [selectedRoomRef, setSelectedRoomRef] = useState<string>(mappings[0]?.pmsRoomTypeRef || 'RT-1');
  const [editDate, setEditDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [editFreeRooms, setEditFreeRooms] = useState<number>(8);
  const [editRate, setEditRate] = useState<string>('2800.00');
  const [editMinStay, setEditMinStay] = useState<string>('');
  const [editStopSell, setEditStopSell] = useState<boolean>(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [remoteFrom, setRemoteFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [remoteTo, setRemoteTo] = useState(() => new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
  const [remoteCalendar, setRemoteCalendar] = useState<any | null>(null);

  const [ssRoomRef, setSsRoomRef] = useState<string>(mappings[0]?.pmsRoomTypeRef || '');
  const [ssFrom, setSsFrom] = useState(() => new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10));
  const [ssTo, setSsTo] = useState(() => new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10));
  const [ssReason, setSsReason] = useState('Maintenance block');

  const filteredInventory = inventory.filter((row) => !selectedRoomRef || row.pmsRoomTypeRef === selectedRoomRef);

  const handleUpdateInventory = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction('delta');
    setNotice(null);
    try {
      const res = await syncApi.updateInventoryDay(property.propertyId, {
        pmsRoomTypeRef: selectedRoomRef,
        date: editDate,
        freeRooms: editFreeRooms,
        rate: property.rateSource === 'pms' ? editRate : undefined,
        minStayArrival: editMinStay ? Number(editMinStay) : null,
        stopSell: editStopSell,
      });
      setNotice(
        res.outbox
          ? `Inventory updated & delta pushed (HTTP ${res.outbox.httpStatus}, batch ${res.outbox.batchId || res.outbox.idempotencyKey})`
          : 'Local inventory updated (ARI/Rate ownership belongs to M-Channel).'
      );
      await onRefresh();
    } catch (err: any) {
      setNotice(`Error: ${err?.message || 'Failed to update inventory'}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleFull365 = async () => {
    setBusyAction('full365');
    setNotice(null);
    try {
      const res = await syncApi.pushFull365(property.propertyId);
      setNotice(`365-day full ARI push: HTTP ${res.outbox.httpStatus} · batch_id=${res.outbox.batchId}`);
      await onRefresh();
    } catch (err: any) {
      setNotice(`Error: ${err?.message || '365-day push failed'}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleReadRemote = async () => {
    setBusyAction('remote');
    setNotice(null);
    try {
      const res = await syncApi.readRemoteAri(property.propertyId, remoteFrom, remoteTo);
      setRemoteCalendar(res.calendar);
    } catch (err: any) {
      setNotice(`Error: ${err?.message || 'Failed to read remote calendar'}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateStopSale = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction('stopsale');
    setNotice(null);
    try {
      await syncApi.createStopSale(property.propertyId, {
        pmsRoomTypeRef: ssRoomRef || null,
        dateFrom: ssFrom,
        dateTo: ssTo,
        otas: 'all',
        reason: ssReason,
      });
      setNotice(`Stop sale activated for ${ssFrom} to ${ssTo}`);
      await onRefresh();
    } catch (err: any) {
      setNotice(`Error: ${err?.message || 'Stop sale failed'}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-6">
      {notice && (
        <div className="p-3.5 bg-[#072629] border border-emerald-700/60 text-emerald-200 text-xs font-mono rounded-lg">
          {notice}
        </div>
      )}

      {/* PMS Inventory Editor + 365-Day Full Push */}
      <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#112A3A]">
          <div>
            <h2 className="text-lg font-semibold text-white">PMS Room Inventory &amp; Delta ARI Push</h2>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Updates recalculated free rooms and dispatches an idempotent <code className="text-xs bg-[#0A2233] text-cyan-300 px-1.5 py-0.5 rounded">POST /api/v1/properties/:id/ari</code> batch.
            </p>
          </div>
          <button
            type="button"
            disabled={busyAction === 'full365'}
            onClick={handleFull365}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 rounded-lg whitespace-nowrap shrink-0"
          >
            <UploadCloud className="w-4 h-4" />
            {busyAction === 'full365' ? 'Pushing 365 Days...' : 'Push 365-Day Full ARI'}
          </button>
        </div>

        <form onSubmit={handleUpdateInventory} className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Room Type</label>
            <select
              value={selectedRoomRef}
              onChange={(e) => setSelectedRoomRef(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded-lg text-slate-100"
            >
              {mappings.map((m) => (
                <option key={m.id} value={m.pmsRoomTypeRef}>
                  {m.pmsRoomTypeRef} — {m.roomTypeName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Local Date</label>
            <input
              type="date"
              required
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded-lg text-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Free Rooms</label>
            <input
              type="number"
              min={0}
              max={5000}
              required
              value={editFreeRooms}
              onChange={(e) => setEditFreeRooms(Number(e.target.value))}
              className="w-full px-3 py-2 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded-lg text-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Rate ({property.rateSource === 'pms' ? 'PMS Owned' : 'M-Channel Owned'})
            </label>
            <input
              type="text"
              disabled={property.rateSource !== 'pms'}
              value={editRate}
              onChange={(e) => setEditRate(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded-lg text-slate-100 disabled:bg-[#07111C] disabled:text-slate-600"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Min Stay / Stop Sell</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                placeholder="Min"
                value={editMinStay}
                onChange={(e) => setEditMinStay(e.target.value)}
                className="w-20 px-2.5 py-2 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded-lg text-slate-100"
              />
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={editStopSell}
                  onChange={(e) => setEditStopSell(e.target.checked)}
                  className="rounded border-[#16384C] bg-[#040C16]"
                />
                Stop
              </label>
            </div>
          </div>

          <button
            type="submit"
            disabled={busyAction === 'delta'}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg whitespace-nowrap"
          >
            {busyAction === 'delta' ? 'Pushing Delta...' : 'Save & Push Delta'}
          </button>
        </form>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#133144] text-xs font-medium text-slate-400">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">PMS Ref</th>
                <th className="py-2 pr-4 text-right">Total</th>
                <th className="py-2 pr-4 text-right">Booked</th>
                <th className="py-2 pr-4 text-right">Free</th>
                <th className="py-2 pr-4 text-right">Rate ({property.currency})</th>
                <th className="py-2 pr-4">Restrictions</th>
                <th className="py-2 text-right">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#0E2433] text-sm">
              {filteredInventory.slice(0, 14).map((day) => (
                <tr
                  key={day.id}
                  onClick={() => {
                    setEditDate(day.date);
                    setEditFreeRooms(day.freeRooms);
                    setEditRate(day.rate);
                    setEditMinStay(day.minStayArrival ? String(day.minStayArrival) : '');
                    setEditStopSell(day.stopSell);
                  }}
                  className="hover:bg-[#081A2A] cursor-pointer"
                >
                  <td className="py-2 pr-4 font-mono text-xs text-slate-100 tabular-nums">{day.date}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-cyan-300">{day.pmsRoomTypeRef}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs text-slate-400 tabular-nums">{day.totalRooms}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs text-slate-400 tabular-nums">{day.bookedRooms}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs font-semibold text-emerald-300 tabular-nums">{day.freeRooms}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs text-slate-200 tabular-nums">{day.rate}</td>
                  <td className="py-2 pr-4 text-xs text-slate-300">
                    {day.stopSell ? 'Stop Sell' : day.minStayArrival ? `Min ${day.minStayArrival}N` : 'Open'}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-slate-500 tabular-nums">
                    {day.updatedAt.slice(11, 19)}Z
                  </td>
                </tr>
              ))}
              {filteredInventory.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-sm text-slate-500">
                    No inventory rows recorded for {selectedRoomRef}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Outbox & Retry Queue */}
      <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
        <h2 className="text-base font-semibold text-white pb-4 border-b border-[#112A3A]">
          ARI Outbox &amp; Idempotent Retry Queue
        </h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#133144] text-xs font-medium text-slate-400">
                <th className="py-2 pr-4">Idempotency Key</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">HTTP</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Batch UUID</th>
                <th className="py-2 pr-4 text-right">Attempts</th>
                <th className="py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#0E2433] text-sm">
              {outbox.map((b) => (
                <tr key={b.id} className="hover:bg-[#081A2A]">
                  <td className="py-2.5 pr-4 font-mono text-xs text-slate-100">{b.idempotencyKey}</td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-slate-300">{b.syncType}</td>
                  <td className="py-2.5 pr-4 font-mono text-xs tabular-nums text-slate-200">{b.httpStatus}</td>
                  <td className="py-2.5 pr-4 text-xs font-medium">
                    <span
                      className={
                        b.status === 'accepted'
                          ? 'text-emerald-400'
                          : b.status === 'retry_scheduled'
                          ? 'text-amber-400'
                          : 'text-red-400'
                      }
                    >
                      {b.status}
                    </span>
                    {b.lastError && <span className="text-slate-400 font-normal"> · {b.lastError}</span>}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-cyan-300">{b.batchId ?? '—'}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-xs tabular-nums text-slate-200">{b.attempts}</td>
                  <td className="py-2.5 text-right">
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await syncApi.retryOutbox(property.propertyId, b.idempotencyKey);
                        setNotice(`Retried ${b.idempotencyKey} -> HTTP ${res.outbox.httpStatus} (batch ${res.outbox.batchId})`);
                        await onRefresh();
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-200 bg-[#0A1D2D] border border-[#193F56] rounded hover:bg-[#102A40]"
                    >
                      <RotateCcw className="w-3 h-3" /> Retry Same Key
                    </button>
                  </td>
                </tr>
              ))}
              {outbox.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-sm text-slate-500">
                    No ARI batches queued yet. Click &ldquo;Push 365-Day Full ARI&rdquo; above to initialize availability.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Remote Stored Calendar + Stop Sales */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
          <div className="flex items-center justify-between pb-4 border-b border-[#112A3A]">
            <div>
              <h2 className="text-base font-semibold text-white">Read Stored M-Channel Calendar</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                <code className="bg-[#0A2233] text-cyan-300 px-1 py-0.5 rounded">GET /api/v1/properties/:id/ari</code> (max 400 days)
              </p>
            </div>
            <button
              type="button"
              disabled={busyAction === 'remote'}
              onClick={handleReadRemote}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg whitespace-nowrap shrink-0"
            >
              <Search className="w-3.5 h-3.5" /> Read Remote
            </button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <input
              type="date"
              value={remoteFrom}
              onChange={(e) => setRemoteFrom(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
            />
            <input
              type="date"
              value={remoteTo}
              onChange={(e) => setRemoteTo(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
            />
          </div>
          {remoteCalendar ? (
            <div className="mt-4 text-xs font-mono bg-[#040C16] border border-[#133144] rounded p-3 max-h-60 overflow-y-auto space-y-1">
              <div className="text-cyan-300 pb-1 border-b border-[#112A3A]">
                ari_source={remoteCalendar.ari_source} · rate_source={remoteCalendar.rate_source} · {remoteCalendar.availability?.length ?? 0} availability rows
              </div>
              {(remoteCalendar.availability ?? []).slice(0, 15).map((a: any, i: number) => (
                <div key={i} className="flex justify-between text-slate-200">
                  <span>{a.pms_room_type_ref} · {a.date}</span>
                  <span className="text-emerald-300">free={a.availability}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-6 text-xs text-slate-400 flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-cyan-400" /> Click &ldquo;Read Remote&rdquo; to inspect M-Channel&apos;s stored calendar state.
            </p>
          )}
        </section>

        <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
          <h2 className="text-base font-semibold text-white pb-4 border-b border-[#112A3A]">
            Stop Sales (Section 6.4)
          </h2>
          <form onSubmit={handleCreateStopSale} className="mt-4 grid grid-cols-2 gap-3">
            <select
              value={ssRoomRef}
              onChange={(e) => setSsRoomRef(e.target.value)}
              className="px-2.5 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
            >
              <option value="">Whole Hotel</option>
              {mappings.map((m) => (
                <option key={m.id} value={m.pmsRoomTypeRef}>{m.pmsRoomTypeRef}</option>
              ))}
            </select>
            <input
              type="text"
              value={ssReason}
              onChange={(e) => setSsReason(e.target.value)}
              placeholder="Reason"
              className="px-2.5 py-1.5 text-xs bg-[#040C16] border border-[#16384C] rounded text-slate-100"
            />
            <input
              type="date"
              value={ssFrom}
              onChange={(e) => setSsFrom(e.target.value)}
              className="px-2.5 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
            />
            <input
              type="date"
              value={ssTo}
              onChange={(e) => setSsTo(e.target.value)}
              className="px-2.5 py-1.5 text-xs font-mono bg-[#040C16] border border-[#16384C] rounded text-slate-100"
            />
            <button
              type="submit"
              disabled={busyAction === 'stopsale'}
              className="col-span-2 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded-lg"
            >
              <Ban className="w-3.5 h-3.5" /> Create Stop Sale (All OTAs)
            </button>
          </form>

          <div className="mt-4 divide-y divide-[#0E2433]">
            {stopSales.map((ss) => (
              <div key={ss.id} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                <div>
                  <div className="font-mono text-slate-100">
                    {ss.pmsRoomTypeRef || 'WHOLE HOTEL'} · {ss.dateFrom} → {ss.dateTo}
                  </div>
                  <div className="text-slate-400">{ss.reason} · status={ss.status}</div>
                </div>
                {ss.status === 'active' && (
                  <button
                    type="button"
                    onClick={async () => {
                      await syncApi.reopenStopSale(property.propertyId, ss.stopSaleId);
                      await onRefresh();
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-200 bg-[#0A1D2D] border border-[#193F56] rounded hover:bg-[#102A40]"
                  >
                    <Unlock className="w-3 h-3" /> Reopen
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
