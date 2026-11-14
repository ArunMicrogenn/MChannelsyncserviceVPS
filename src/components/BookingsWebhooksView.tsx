import React, { useState } from 'react';
import { DownloadCloud, Webhook, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { syncApi, type PropertySnapshot } from '../lib/api';

interface BookingsWebhooksViewProps {
  snapshot: PropertySnapshot;
  onRefresh: () => Promise<void>;
}

export const BookingsWebhooksView: React.FC<BookingsWebhooksViewProps> = ({ snapshot, onRefresh }) => {
  const { property, bookings, webhookEvents } = snapshot;
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastCreatedBookingId, setLastCreatedBookingId] = useState<string | undefined>(
    bookings.find((b) => b.status === 'new')?.bookingId
  );

  const handlePullFallback = async () => {
    setBusy('pull');
    setNotice(null);
    try {
      const res = await syncApi.pullBookings(property.propertyId, '2026-01-01T00:00:00Z', true);
      setNotice(`Pull fallback complete: fetched ${res.fetched}, processed ${res.processed}`);
      await onRefresh();
    } catch (err: any) {
      setNotice(`Error: ${err?.message || 'Pull fallback failed'}`);
    } finally {
      setBusy(null);
    }
  };

  const handleSimulate = async (
    scenario: 'created' | 'modified' | 'cancelled' | 'unmapped' | 'full_room' | 'bad_signature' | 'duplicate_event'
  ) => {
    setBusy(scenario);
    setNotice(null);
    try {
      const res = await syncApi.simulateWebhook(
        property.propertyId,
        scenario,
        scenario === 'modified' || scenario === 'cancelled' ? lastCreatedBookingId : undefined
      );
      if (scenario === 'created' && res.bookingId) {
        setLastCreatedBookingId(res.bookingId);
      }
      setNotice(
        scenario === 'duplicate_event'
          ? `Duplicate event test: 1st HTTP ${res.first?.httpStatus}, 2nd HTTP ${res.second?.httpStatus} (deduplicated=${res.second?.body?.deduplicated})`
          : `Webhook (${scenario}): HTTP ${res.httpStatus} · ${res.body?.message || res.body?.error || 'Done'}`
      );
      await onRefresh();
    } catch (err: any) {
      setNotice(`Error: ${err?.message || 'Simulation failed'}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {notice && (
        <div className="p-3.5 bg-[#072629] border border-emerald-700/60 text-emerald-200 text-xs font-mono rounded-lg">
          {notice}
        </div>
      )}

      {/* Webhook Simulator & Signature Tester */}
      <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#112A3A]">
          <div>
            <div className="flex items-center gap-2">
              <Webhook className="w-4 h-4 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">Webhook Receiver &amp; HMAC-SHA256 Tester</h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Dispatches real raw-body signed payloads to <code className="bg-[#0A2233] text-cyan-300 px-1.5 py-0.5 rounded">POST /api/v1/mchannel/webhook/:propertyId</code> with timestamp skew (&le;300s) and constant-time HMAC comparison.
            </p>
          </div>
          <button
            type="button"
            disabled={busy === 'pull'}
            onClick={handlePullFallback}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg whitespace-nowrap shrink-0"
          >
            <DownloadCloud className="w-3.5 h-3.5" />
            {busy === 'pull' ? 'Pulling...' : 'Pull Unacked Bookings (8.2)'}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {[
            { id: 'created', label: 'booking.created (Ack Imported)' },
            { id: 'modified', label: 'booking.modified (Rev 2)' },
            { id: 'cancelled', label: 'booking.cancelled (Rev 3)' },
            { id: 'unmapped', label: 'is_unmapped = true' },
            { id: 'full_room', label: 'Room Full (Ack Failed)' },
            { id: 'duplicate_event', label: 'Duplicate Event ID (200 Dedupe)' },
            { id: 'bad_signature', label: 'Wrong HMAC Signature (401)' },
          ].map((btn) => (
            <button
              key={btn.id}
              type="button"
              disabled={busy !== null}
              onClick={() => handleSimulate(btn.id as any)}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0A1D2D] border border-[#193F56] hover:bg-[#102A40] disabled:opacity-50 rounded-lg whitespace-nowrap"
            >
              {busy === btn.id ? 'Running...' : btn.label}
            </button>
          ))}
        </div>
      </section>

      {/* OTA Bookings Ledger */}
      <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
        <h2 className="text-base font-semibold text-white pb-4 border-b border-[#112A3A]">
          Imported OTA Bookings &amp; Acknowledgement Outcomes
        </h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#133144] text-xs font-medium text-slate-400">
                <th className="py-2 pr-4">OTA / Ref</th>
                <th className="py-2 pr-4">Guest</th>
                <th className="py-2 pr-4">Stay Dates</th>
                <th className="py-2 pr-4">Room / Rate</th>
                <th className="py-2 pr-4 text-right">Amount</th>
                <th className="py-2 pr-4 text-right">Rev</th>
                <th className="py-2 pr-4">PMS Booking / Ack</th>
                <th className="py-2 text-right">OTA Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#0E2433] text-sm">
              {bookings.map((b) => (
                <tr key={b.id} className="hover:bg-[#081A2A]">
                  <td className="py-2.5 pr-4">
                    <div className="font-mono text-xs font-medium text-cyan-300">{b.uniqueId}</div>
                    <div className="text-xs text-slate-400">{b.otaName} · {b.status}</div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="text-sm text-slate-100">{b.guestName}</div>
                    <div className="text-xs text-slate-400 font-mono">{b.guestEmail || 'No email'}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-slate-300 tabular-nums">
                    {b.arrivalDate} → {b.departureDate}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-slate-300">
                    {b.isUnmapped ? (
                      <span className="inline-flex items-center gap-1 text-amber-300 font-sans font-medium">
                        <AlertTriangle className="w-3.5 h-3.5" /> Unallocated
                      </span>
                    ) : (
                      `${b.pmsRoomTypeRef || '—'} · ${b.pmsRatePlanRef || '—'}`
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono text-xs text-slate-100 tabular-nums">
                    {b.currency} {b.amount}
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono text-xs text-slate-400 tabular-nums">
                    #{b.revisionSeq}
                  </td>
                  <td className="py-2.5 pr-4 text-xs">
                    <div className="flex items-center gap-1 font-medium">
                      {b.ackResult === 'failed' ? (
                        <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      )}
                      <span className={b.ackResult === 'failed' ? 'text-red-300' : 'text-emerald-300'}>
                        {b.ackResult}
                      </span>
                      {b.pmsBookingNo && <span className="font-mono text-slate-400">· {b.pmsBookingNo}</span>}
                    </div>
                    {b.ackFailureReason && (
                      <div className="text-xs text-red-400 mt-0.5 max-w-xs truncate">{b.ackFailureReason}</div>
                    )}
                  </td>
                  <td className="py-2.5 text-right whitespace-nowrap space-x-2">
                    <button
                      type="button"
                      onClick={async () => {
                        await syncApi.reportNoShow(property.propertyId, b.bookingId, false);
                        setNotice(`Reported no-show for ${b.uniqueId}`);
                        await onRefresh();
                      }}
                      className="px-2 py-1 text-xs text-slate-200 bg-[#0A1D2D] border border-[#193F56] rounded hover:bg-[#102A40]"
                    >
                      No-Show
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await syncApi.requestInvalidCardCancel(property.propertyId, b.bookingId, 'Card declined during pre-auth');
                        setNotice(`Requested invalid-card cancellation for ${b.uniqueId}`);
                        await onRefresh();
                      }}
                      className="px-2 py-1 text-xs text-red-300 bg-red-950/50 border border-red-800/70 rounded hover:bg-red-900/50"
                    >
                      Invalid Card
                    </button>
                  </td>
                </tr>
              ))}
              {bookings.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-sm text-slate-500">
                    No bookings received yet. Use the signed webhook tester above or run the Master Sync Cycle.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Webhook Deduplication Log */}
      <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
        <h2 className="text-base font-semibold text-white pb-4 border-b border-[#112A3A]">
          Inbound Webhook Event Deduplication Log
        </h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#133144] text-xs font-medium text-slate-400">
                <th className="py-2 pr-4">Processed At</th>
                <th className="py-2 pr-4">Event ID</th>
                <th className="py-2 pr-4">Event Type</th>
                <th className="py-2 pr-4">HMAC Sig</th>
                <th className="py-2 pr-4">HTTP</th>
                <th className="py-2">Outcome Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#0E2433] text-xs">
              {webhookEvents.map((evt) => (
                <tr key={evt.id} className="hover:bg-[#081A2A]">
                  <td className="py-2 pr-4 font-mono text-slate-400 tabular-nums">{evt.processedAt}</td>
                  <td className="py-2 pr-4 font-mono text-slate-200">{evt.eventId}</td>
                  <td className="py-2 pr-4 font-mono text-cyan-300">{evt.eventType}</td>
                  <td className="py-2 pr-4 font-medium">
                    <span className={evt.signatureValid ? 'text-emerald-400' : 'text-red-400'}>
                      {evt.signatureValid ? 'Verified' : 'Rejected'}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono tabular-nums text-slate-200">{evt.httpStatus}</td>
                  <td className="py-2 text-slate-300">{evt.summary}</td>
                </tr>
              ))}
              {webhookEvents.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-sm text-slate-500">
                    No webhook deliveries logged yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
