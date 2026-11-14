import React, { useState, useEffect } from 'react';
import { Copy, Check, Download, Server, FileCode2 } from 'lucide-react';
import { syncApi, type PropertySnapshot } from '../lib/api';
import { POSTGRES_DDL_SQL } from '../shared/postgresSchema';

interface LogsPostgresViewProps {
  snapshot: PropertySnapshot | null;
}

export const LogsPostgresView: React.FC<LogsPostgresViewProps> = ({ snapshot }) => {
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warning' | 'error'>('all');
  const [bundleFiles, setBundleFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [selectedFile, setSelectedFile] = useState<string>('sql/001_schema.sql');
  const [copiedFile, setCopiedFile] = useState(false);

  useEffect(() => {
    syncApi
      .getVpsBundle()
      .then((res) => {
        setBundleFiles(res.files);
        if (res.files.length > 0 && !res.files.some((f) => f.path === selectedFile)) {
          setSelectedFile(res.files[0].path);
        }
      })
      .catch(() => {
        setBundleFiles([{ path: 'sql/001_schema.sql', content: POSTGRES_DDL_SQL }]);
      });
  }, []);

  const logs = (snapshot?.syncLogs ?? []).filter(
    (l) => levelFilter === 'all' || l.level === levelFilter
  );

  const activeFileObj = bundleFiles.find((f) => f.path === selectedFile) ?? {
    path: 'sql/001_schema.sql',
    content: POSTGRES_DDL_SQL,
  };

  const handleDownloadFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.split('/').pop() || 'file.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadBootstrapScript = () => {
    const lines = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'mkdir -p mchannel-vps-postgres-sync/sql mchannel-vps-postgres-sync/src',
      'cd mchannel-vps-postgres-sync',
    ];
    for (const f of bundleFiles) {
      const marker = `EOF_${f.path.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
      lines.push(`cat <<'${marker}' > "${f.path}"`);
      lines.push(f.content);
      lines.push(marker);
    }
    lines.push('chmod +x install_vps.sh');
    lines.push('echo "Files extracted into $(pwd). Run on VPS: bash install_vps.sh"');
    handleDownloadFile('setup_mchannel_vps_sync.sh', lines.join('\n'));
  };

  return (
    <div className="space-y-6">
      {/* Standalone VPS Node.js + PostgreSQL Daemon Bundle */}
      <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#112A3A]">
          <div>
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">
                Standalone VPS Sync Daemon &amp; PostgreSQL Schema (<span className="font-mono text-cyan-300">vps-postgres-sync/</span>)
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Runs independently on a VPS: fetches M-Channel bookings via webhooks &amp; pull fallback into PostgreSQL (<code className="bg-[#0A2233] text-cyan-300 px-1 py-0.5 rounded">pms_bookings</code>), and pushes <code className="bg-[#0A2233] text-cyan-300 px-1 py-0.5 rounded">pms_room_inventory</code> changes to M-Channel using <code className="bg-[#0A2233] text-cyan-300 px-1 py-0.5 rounded">LISTEN/NOTIFY</code> + <code className="bg-[#0A2233] text-cyan-300 px-1 py-0.5 rounded">ari_outbox</code>.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(activeFileObj.content);
                setCopiedFile(true);
                setTimeout(() => setCopiedFile(false), 1800);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0A1D2D] border border-[#193F56] hover:bg-[#102A40] rounded-lg whitespace-nowrap"
            >
              {copiedFile ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedFile ? 'Copied' : 'Copy File'}
            </button>
            <button
              type="button"
              onClick={handleDownloadBootstrapScript}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" /> Download VPS Installer (.sh)
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-3 bg-[#040C16] border border-[#133144] rounded-lg divide-y divide-[#0E2433] max-h-[500px] overflow-y-auto">
            {bundleFiles.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelectedFile(f.path)}
                className={`w-full px-3 py-2 text-left text-xs font-mono flex items-center gap-2 transition-colors ${
                  selectedFile === f.path
                    ? 'bg-[#0B2A3E] text-cyan-200 font-semibold'
                    : 'text-slate-300 hover:bg-[#071828]'
                }`}
              >
                <FileCode2 className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
                <span className="truncate">{f.path}</span>
              </button>
            ))}
          </div>

          <div className="lg:col-span-9 flex flex-col">
            <div className="px-3.5 py-2 bg-[#091D2E] border border-b-0 border-[#133144] rounded-t-lg flex items-center justify-between text-xs font-mono text-cyan-200">
              <span>vps-postgres-sync/{activeFileObj.path}</span>
              <button
                type="button"
                onClick={() => handleDownloadFile(activeFileObj.path, activeFileObj.content)}
                className="text-emerald-300 hover:text-emerald-200 font-sans font-medium"
              >
                Download file
              </button>
            </div>
            <pre className="p-4 bg-[#020810] border border-[#133144] text-slate-200 text-xs font-mono rounded-b-lg overflow-auto h-[465px] leading-relaxed">
              {activeFileObj.content}
            </pre>
          </div>
        </div>
      </section>

      {/* Sync Logs */}
      {snapshot && (
        <section className="bg-[#061320] border border-[#133144] rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#112A3A]">
            <div>
              <h2 className="text-base font-semibold text-white">Sync Service Audit Log</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Every ARI push, webhook rejection, mapping prompt, and booking acknowledgement with <code className="bg-[#0A2233] text-cyan-300 px-1 py-0.5 rounded">X-Request-Id</code> correlation.
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-[#040C16] border border-[#133144] rounded-lg shrink-0">
              {(['all', 'info', 'warning', 'error'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setLevelFilter(lvl)}
                  className={`px-3 py-1 text-xs font-medium rounded-md capitalize whitespace-nowrap ${
                    levelFilter === lvl
                      ? 'bg-cyan-400 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#133144] text-xs font-medium text-slate-400">
                  <th className="py-2 pr-4">Timestamp</th>
                  <th className="py-2 pr-4">Level</th>
                  <th className="py-2 pr-4">Kind</th>
                  <th className="py-2 pr-4">Message</th>
                  <th className="py-2">Correlation ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0E2433] text-xs">
                {logs.map((l) => (
                  <tr key={l.id} className="hover:bg-[#081A2A]">
                    <td className="py-2 pr-4 font-mono text-slate-400 tabular-nums whitespace-nowrap">{l.createdAt}</td>
                    <td className="py-2 pr-4 font-medium capitalize">
                      <span
                        className={
                          l.level === 'error'
                            ? 'text-red-400'
                            : l.level === 'warning'
                            ? 'text-amber-300'
                            : 'text-emerald-300'
                        }
                      >
                        {l.level}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-cyan-300">{l.kind}</td>
                    <td className="py-2 pr-4 text-slate-200">{l.message}</td>
                    <td className="py-2 font-mono text-slate-400">{l.requestId || l.batchId || l.bookingId || '—'}</td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-slate-500">
                      No matching audit log entries.
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
