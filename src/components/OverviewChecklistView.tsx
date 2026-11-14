import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  XCircle,
  Play,
  RefreshCw,
  Copy,
  Check,
  ShieldCheck,
  Download,
  PlugZap,
  Database,
  Link2,
} from 'lucide-react';
import { syncApi, type PropertySnapshot } from '../lib/api';
import type { ChecklistItemResult, PropertyRecord } from '../shared/mchannel';

interface OverviewChecklistViewProps {
  properties: PropertyRecord[];
  snapshot: PropertySnapshot | null;
  onRefresh: () => Promise<void>;
  onNavigate: (tab: 'overview' | 'pairing' | 'ari' | 'bookings' | 'logs') => void;
  onExecuteMasterSync: () => Promise<void>;
  syncingMaster: boolean;
}

const DEFAULT_CHECKLIST_META: Array<{ step: number; title: string; expected: string }> = [
  { step: 1, title: 'Pair with a one-time code', expected: '201; key, secret, property id and mapping stored encrypted' },
  { step: 2, title: 'GET /pairing/status', expected: 'paired, mapping_saved and webhook_registered are true' },
  { step: 3, title: 'Full push of free rooms for 365 days', expected: '202; availability_received becomes true' },
  { step: 4, title: 'Create a booking in the PMS', expected: 'Delta push with recalculated free-room count' },
  { step: 5, title: 'Cancel that booking in the PMS', expected: 'Delta push restoring the free-room count' },
  { step: 6, title: 'Retry push with same idempotency_key', expected: 'Same 202 response & batch_id, no duplicate' },
  { step: 7, title: 'Receive booking.created', expected: 'Signature verified; booking saved; ack imported' },
  { step: 8, title: 'Receive the same event twice', expected: 'Second one ignored, 200 returned' },
  { step: 9, title: 'Receive booking.modified and booking.cancelled', expected: 'PMS booking updated / cancelled; ack updated / cancelled' },
  { step: 10, title: 'Receive a booking when the room is full', expected: 'Ack failed with a clear failure_reason' },
  { step: 11, title: 'Receive a booking with is_unmapped = true', expected: 'Saved as unallocated; user alerted to map' },
  { step: 12, title: 'Send a wrong signature to webhook', expected: 'PMS replies 401 and saves nothing' },
  { step: 13, title: 'Pull missed bookings with only_unacked=true', expected: 'GET /bookings?only_unacked=true returns & acks missed bookings' },
  { step: 14, title: 'Push a price when rate_source = mchannel', expected: '409 conflict handled without retry' },
];

export const OverviewChecklistView: React.FC<OverviewChecklistViewProps> = ({
  properties,
  snapshot,
  onRefresh,
  onNavigate,
  onExecuteMasterSync,
  syncingMaster,
}) => {
  const property = snapshot?.property ?? null;
  const mappings = snapshot?.mappings ?? [];
  const outbox = snapshot?.outbox ?? [];
  const bookings = snapshot?.bookings ?? [];
  const webhookEvents = snapshot?.webhookEvents ?? [];

  const [diag, setDiag] = useState<{ health: any; pairingStatus: any } | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItemResult[]>(
    DEFAULT_CHECKLIST_META.map((item) => ({
      ...item,
      status: 'pending',
      detail: 'Not executed in this session',
      lastRunAt: null,
    }))
  );
  const [runningChecklist, setRunningChecklist] = useState(false);
  const [downloadingPkg, setDownloadingPkg] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [connResult, setConnResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedWebhook, setCopiedWebhook] = useState(false);

  const loadDiagnostics = async () => {
    if (!property) return;
    try {
      const res = await syncApi.getDiagnostics(property.propertyId);
      setDiag({ health: res.health, pairingStatus: res.pairingStatus });
    } catch {
      // Quiet fallback when offline or staging unreachable
    }
  };

  useEffect(() => {
    loadDiagnostics();
  }, [property?.propertyId]);

  const handleTestConnection = async () => {
    setTestingConn(true);
    setConnResult(null);
    const t0 = performance.now();
    try {
      const healthRes = await fetch('/api/health');
      const healthJson = await healthRes.json();
      const apiMs = Math.max(1, Math.round(performance.now() - t0));

      if (!property) {
        setConnResult({
          ok: healthRes.ok,
          text: `Sync API healthy (${apiMs}ms, v${healthJson.contract_version}). Pair a property to verify M-Channel upstream.`,
        });
        return;
      }

      const d = await syncApi.getDiagnostics(property.propertyId);
      setDiag({ health: d.health, pairingStatus: d.pairingStatus });
      const paired = Boolean(d.pairingStatus?.checks?.paired ?? property.hasCredentials);
      setConnResult({
        ok: true,
        text: `Connected to ${property.baseUrl} (${apiMs}ms local API) · paired=${paired} · ari_source=${property.ariSource} · rate_source=${property.rateSource}`,
      });
    } catch (err: any) {
      setConnResult({
        ok: false,
        text: err?.message || 'Connection test failed',
      });
    } finally {
      setTestingConn(false);
    }
  };

  const handleDownloadVpsPackage = async () => {
    setDownloadingPkg(true);
    try {
      const res = await syncApi.getVpsBundle();
      const lines = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'mkdir -p mchannel-vps-postgres-sync/sql mchannel-vps-postgres-sync/src',
        'cd mchannel-vps-postgres-sync',
      ];
      for (const f of res.files) {
        const marker = `EOF_${f.path.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
        lines.push(`cat <<'${marker}' > "${f.path}"`);
        lines.push(f.content);
        lines.push(marker);
      }
      lines.push('chmod +x install_vps.sh');
      lines.push('echo "Extracted vps-postgres-sync. Run on VPS: bash install_vps.sh"');
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'setup_mchannel_vps_sync.sh';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingPkg(false);
    }
  };

  const handleRunChecklist = async () => {
    if (!property) return;
    setRunningChecklist(true);
    try {
      const res = await syncApi.runChecklist(property.propertyId);
      setChecklist(res.results);
      await loadDiagnostics();
      await onRefresh();
    } finally {
      setRunningChecklist(false);
    }
  };

  const passedCount = checklist.filter((c) => c.status === 'passed').length;
  const checks = diag?.pairingStatus?.checks;
  const unackedCount = bookings.filter((b) => b.ackResult === 'pending').length;

  return (
    <div className="space-y-6">
      {/* Primary Engine Hero Card matching VPS Ingestion Studio */}
      <section
        className="relative rounded-2xl border border-[#14394E] p-6 sm:p-8 overflow-hidden"
        style={{
          background: 'linear-gradient(145deg, #061524 0%, #050E1A 55%, #071928 100%)',
        }}
      >
        {/* Specifier Kicker */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono text-cyan-300/90">
          <span>M-Channel PMS &amp; OTA Channel Bridge</span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-emerald-300">Node.js → PostgreSQL (Standalone VPS)</span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-slate-300">
            API Endpoint: {property ? property.baseUrl : 'stagcm.microgenn.com / cmlive.microgenn.com'}
          </span>
        </div>

        {/* Display Headline */}
        <h2 className="mt-4 text-2xl sm:text-3xl font-bold tracking-tight text-white text-balance">
          M-Channel Ingestion &amp; Room Availability Engine
        </h2>

        {/* Monospace Target Spec */}
        <p className="mt-2.5 text-xs sm:text-sm font-mono text-slate-400 leading-relaxed">
          Target Service: <span className="text-cyan-300">vps-postgres-sync</span>{' '}
          <span className="text-slate-600">|</span> Database: <span className="text-cyan-300">PostgreSQL (LISTEN/NOTIFY)</span>{' '}
          <span className="text-slate-600">|</span> Contract: <span className="text-emerald-300">mchannel-v1 (v1.3.0)</span>
        </p>

        {/* Primary Action Cluster */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={downloadingPkg}
            onClick={handleDownloadVpsPackage}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-4 h-4" />
            {downloadingPkg ? 'Bundling...' : 'Download VPS Package (.SH)'}
          </button>

          <button
            type="button"
            disabled={testingConn}
            onClick={handleTestConnection}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-medium text-slate-100 bg-[#0A1D2D] hover:bg-[#102A40] border border-[#1B4259] rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <PlugZap className="w-4 h-4 text-cyan-300" />
            {testingConn ? 'Testing...' : 'Test Connection'}
          </button>

          <button
            type="button"
            onClick={() => onNavigate('logs')}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-medium text-cyan-200 bg-[#082B3A] hover:bg-[#0C394D] border border-[#175771] rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Database className="w-4 h-4 text-cyan-300" />
            Verify / Inspect Postgres DDL
          </button>

          {property ? (
            <button
              type="button"
              disabled={syncingMaster}
              onClick={onExecuteMasterSync}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="w-4 h-4" />
              {syncingMaster ? 'Running Master Sync...' : 'Run Master Sync Cycle'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('pairing')}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Link2 className="w-4 h-4" />
              Claim Pairing Code
            </button>
          )}
        </div>

        {connResult && (
          <div
            className={`mt-4 p-3 rounded-lg border text-xs font-mono ${
              connResult.ok
                ? 'bg-[#062426] border-emerald-700/60 text-emerald-200'
                : 'bg-red-950/70 border-red-700/70 text-red-200'
            }`}
          >
            {connResult.text}
          </div>
        )}

        {/* Inline Status Telemetry Footer */}
        <div className="mt-6 pt-4 border-t border-[#122D3E] space-y-1.5 text-xs font-mono">
          <div className="flex flex-wrap items-center gap-2 text-slate-400">
            <span>Sync Service Status:</span>
            {property ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Active &amp; Paired ({property.name} · {property.environment})
              </span>
            ) : (
              <span className="text-amber-300 font-medium">
                Ready for Pairing — claim a 30-min code or run Simulator mode
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-400 tabular-nums">
            <span>
              Paired Properties: <strong className="text-cyan-300 font-semibold">{properties.length}</strong>
            </span>
            <span aria-hidden="true">•</span>
            <span>
              Mapped Rooms: <strong className="text-cyan-300 font-semibold">{mappings.length}</strong>
            </span>
            <span aria-hidden="true">•</span>
            <span>
              ARI Outbox Batches: <strong className="text-amber-300 font-semibold">{outbox.length}</strong>
            </span>
            <span aria-hidden="true">•</span>
            <span>
              Total Ingested Bookings: <strong className="text-cyan-300 font-semibold">{bookings.length}</strong>
            </span>
            <span aria-hidden="true">•</span>
            <span>
              Pending Ack: <strong className="text-slate-200 font-semibold">{unackedCount}</strong>
            </span>
          </div>
        </div>
      </section>

      {property && (
        <>
          {/* Diagnostics + Channels */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <section className="lg:col-span-2 bg-[#061320] border border-[#133144] rounded-xl p-6">
              <div className="flex items-center justify-between pb-4 border-b border-[#112A3A]">
                <div>
                  <h3 className="text-base font-semibold text-white">Pairing &amp; Webhook Receiver Diagnostics</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Live state from <code className="bg-[#0B2233] text-cyan-300 px-1.5 py-0.5 rounded">GET /api/v1/pairing/status</code> &amp; ownership guards (Section 6.3)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadDiagnostics}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0A1D2D] border border-[#193F56] rounded-lg hover:bg-[#102A40] whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Refresh
                </button>
              </div>

              <div className="mt-4 space-y-4">
                <div className="flex items-center justify-between gap-3 p-3.5 bg-[#040C16] border border-[#122E40] rounded-lg">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-400">Inbound Webhook Receiver (Raw-Body HMAC-SHA256)</div>
                    <div className="text-xs font-mono text-cyan-300 truncate mt-0.5">{property.webhookUrl}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(property.webhookUrl);
                      setCopiedWebhook(true);
                      setTimeout(() => setCopiedWebhook(false), 1800);
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-[#0A1E2F] border border-[#1B4259] rounded-md hover:bg-[#102B42] shrink-0"
                  >
                    {copiedWebhook ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedWebhook ? 'Copied' : 'Copy'}
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Paired', ok: Boolean(checks?.paired ?? property.hasCredentials) },
                    { label: 'Mapping Saved', ok: Boolean(checks?.mapping_saved ?? mappings.length > 0) },
                    { label: 'Availability Received', ok: Boolean(checks?.availability_received ?? outbox.some((o) => o.status === 'accepted')) },
                    { label: 'Webhook Registered', ok: Boolean(checks?.webhook_registered ?? true) },
                  ].map((item) => (
                    <div key={item.label} className="p-3 bg-[#040C16] border border-[#122E40] rounded-lg">
                      <div className="text-xs text-slate-400">{item.label}</div>
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs font-medium">
                        {item.ok ? (
                          <>
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                            <span className="text-emerald-300">Verified</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="w-4 h-4 text-amber-400 shrink-0" />
                            <span className="text-amber-300">Pending</span>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-6 pt-1 text-xs font-mono text-slate-400">
                  <span>
                    ari_source: <strong className="text-cyan-300">{property.ariSource}</strong>
                  </span>
                  <span>
                    rate_source: <strong className="text-cyan-300">{property.rateSource}</strong>
                  </span>
                  <span>
                    webhook_events: <strong className="text-slate-200 tabular-nums">{webhookEvents.length}</strong>
                  </span>
                </div>
              </div>
            </section>

            <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
              <h3 className="text-base font-semibold text-white pb-4 border-b border-[#112A3A]">
                Active OTA Channels
              </h3>
              <div className="mt-4 divide-y divide-[#102636]">
                {(diag?.health?.channels || property.activeChannels || []).map((ch: any, i: number) => (
                  <div key={ch.connection_id || i} className="py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-100 truncate">{ch.title}</div>
                      <div className="text-xs font-mono text-slate-400">{ch.ota_code}</div>
                    </div>
                    <div className="text-xs font-medium shrink-0">
                      {ch.is_active ? (
                        <span className="text-emerald-400">Active</span>
                      ) : (
                        <span className="text-slate-500">Paused</span>
                      )}
                    </div>
                  </div>
                ))}
                {(diag?.health?.channels || property.activeChannels || []).length === 0 && (
                  <p className="py-6 text-xs text-slate-400">No OTA channels linked yet.</p>
                )}
              </div>
            </section>
          </div>

          {/* 14-Point Go-Live Checklist Runner */}
          <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#112A3A]">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-cyan-400" />
                  <h3 className="text-lg font-semibold text-white">14-Point Go-Live Verification Checklist</h3>
                </div>
                <p className="text-xs sm:text-sm text-slate-400 mt-1">
                  Executes Section 10 verification: encrypted pairing, 365-day push, delta sync, idempotency, HMAC signature checks, deduplication, pull fallback, and 409 ownership enforcement.
                </p>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <span className="text-xs font-mono text-cyan-300 tabular-nums">{passedCount} / 14 passed</span>
                <button
                  type="button"
                  disabled={runningChecklist}
                  onClick={handleRunChecklist}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <Play className="w-3.5 h-3.5" />
                  {runningChecklist ? 'Running 14 Tests...' : 'Run 14-Point Verification'}
                </button>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#133144] text-xs font-medium text-slate-400">
                    <th className="py-2.5 pr-4 w-10">#</th>
                    <th className="py-2.5 pr-4">Contract Test</th>
                    <th className="py-2.5 pr-4">Expected Outcome</th>
                    <th className="py-2.5 pr-4">Execution Detail</th>
                    <th className="py-2.5 text-right w-28">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#0E2433] text-sm">
                  {checklist.map((row) => (
                    <tr key={row.step} className="hover:bg-[#081A2A]">
                      <td className="py-2.5 pr-4 font-mono text-xs text-slate-400 tabular-nums">{row.step}</td>
                      <td className="py-2.5 pr-4 font-medium text-slate-100">{row.title}</td>
                      <td className="py-2.5 pr-4 text-xs text-slate-400">{row.expected}</td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-slate-300 max-w-md truncate">{row.detail}</td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        {row.status === 'passed' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Passed
                          </span>
                        ) : row.status === 'failed' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-400">
                            <XCircle className="w-3.5 h-3.5" /> Failed
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">Pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
