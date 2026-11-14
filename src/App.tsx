import React, { useEffect, useState, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  Building2,
  Zap,
  Server,
  ArrowLeftRight,
  Database,
  Layers,
  CalendarRange,
  LogOut,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { auth, googleAuthProvider } from './lib/firebase';
import { syncApi, type PropertySnapshot } from './lib/api';
import type { PropertyRecord } from './shared/mchannel';
import { OverviewChecklistView } from './components/OverviewChecklistView';
import { PairingSetupView } from './components/PairingSetupView';
import { AriInventoryView } from './components/AriInventoryView';
import { BookingsWebhooksView } from './components/BookingsWebhooksView';
import { LogsPostgresView } from './components/LogsPostgresView';

type TabKey = 'overview' | 'pairing' | 'ari' | 'bookings' | 'logs';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [properties, setProperties] = useState<PropertyRecord[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PropertySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncingMaster, setSyncingMaster] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [headerNotice, setHeaderNotice] = useState<string | null>(null);
  const [apiLatencyMs, setApiLatencyMs] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  const measureHealth = useCallback(async () => {
    const start = performance.now();
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        setApiLatencyMs(Math.max(1, Math.round(performance.now() - start)));
      }
    } catch {
      setApiLatencyMs(null);
    }
  }, []);

  const fetchPropertiesAndSnapshot = useCallback(
    async (preferredId?: string) => {
      if (!auth.currentUser) return;
      setLoading(true);
      setLoadError(null);
      try {
        await measureHealth();
        const { properties: list } = await syncApi.listProperties();
        setProperties(list);
        const targetId = preferredId || selectedPropertyId || list[0]?.propertyId || null;
        setSelectedPropertyId(targetId);
        if (targetId) {
          const snap = await syncApi.getSnapshot(targetId);
          setSnapshot(snap);
        } else {
          setSnapshot(null);
        }
      } catch (err: any) {
        setLoadError(err?.message || 'Failed to load sync workspace');
      } finally {
        setLoading(false);
      }
    },
    [selectedPropertyId, measureHealth]
  );

  useEffect(() => {
    if (user) {
      fetchPropertiesAndSnapshot();
    } else {
      setProperties([]);
      setSelectedPropertyId(null);
      setSnapshot(null);
    }
  }, [user]);

  const handleSelectProperty = async (propertyId: string) => {
    setSelectedPropertyId(propertyId);
    setLoading(true);
    setLoadError(null);
    try {
      const snap = await syncApi.getSnapshot(propertyId);
      setSnapshot(snap);
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to switch property');
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteMasterSync = async () => {
    if (!snapshot) {
      setActiveTab('pairing');
      return;
    }
    setSyncingMaster(true);
    setHeaderNotice(null);
    setLoadError(null);
    try {
      const pullRes = await syncApi.pullBookings(snapshot.property.propertyId, '2026-01-01T00:00:00Z', true);
      let ariDetail = 'ARI skipped (owned by M-Channel)';
      if (snapshot.property.ariSource === 'pms' && snapshot.mappings.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const firstMap = snapshot.mappings[0];
        const inv = snapshot.inventory.find((d) => d.pmsRoomTypeRef === firstMap.pmsRoomTypeRef && d.date === today);
        const ariRes = await syncApi.pushAriBatch(snapshot.property.propertyId, {
          syncType: 'delta',
          availability: [
            {
              room_type_id: firstMap.roomTypeId,
              date: today,
              availability: inv?.freeRooms ?? firstMap.countOfRooms ?? 10,
            },
          ],
          restrictions: [],
        });
        ariDetail = `ARI HTTP ${ariRes.outbox.httpStatus} (batch ${ariRes.outbox.batchId || ariRes.outbox.idempotencyKey})`;
      }
      await fetchPropertiesAndSnapshot(snapshot.property.propertyId);
      setHeaderNotice(
        `Sync cycle completed: pulled ${pullRes.fetched} booking(s), processed ${pullRes.processed}; ${ariDetail}.`
      );
    } catch (err: any) {
      setLoadError(err?.message || 'Master sync execution failed');
    } finally {
      setSyncingMaster(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err: any) {
      setAuthError(err?.message || 'Google sign-in failed');
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#030912] flex items-center justify-center text-sm font-mono text-cyan-300">
        Initializing M-Channel → PostgreSQL VPS Studio...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#030912] text-slate-100 flex flex-col justify-center items-center px-4 relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 20% 15%, rgba(6, 182, 212, 0.14), transparent 45%), radial-gradient(circle at 80% 85%, rgba(16, 185, 129, 0.10), transparent 45%)',
          }}
        />
        <div className="relative w-full max-w-lg bg-[#061320] border border-[#14394D] rounded-xl p-8">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-lg bg-[#082436] border border-[#175570] flex items-center justify-center text-cyan-300 shrink-0">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-lg font-bold tracking-tight text-white">
                M-Channel → PostgreSQL VPS Studio
              </div>
              <div className="text-xs font-mono text-cyan-300/80">
                OTA / PMS Sync Engine · Contract mchannel-v1 (v1.3.0)
              </div>
            </div>
          </div>

          <h1 className="mt-6 text-2xl font-bold text-white text-balance">
            Channel Manager Ingestion &amp; Room Availability Studio
          </h1>
          <p className="mt-2.5 text-sm text-slate-300 leading-relaxed">
            Node.js + PostgreSQL sync control plane for M-Channel PMS API v1.3.0: encrypted pairing claims, 365-day ARI availability pushes, raw-body HMAC-SHA256 webhook ingestion, and standalone VPS daemon deployment.
          </p>

          {authError && (
            <div className="mt-4 p-3 bg-red-950/60 border border-red-800 rounded-md text-xs text-red-200 font-mono">
              {authError}
            </div>
          )}

          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="mt-6 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors whitespace-nowrap"
          >
            <Zap className="w-4 h-4" />
            Sign in with Google to Launch Studio
          </button>

          <p className="mt-4 text-xs text-slate-400 font-mono">
            Auth: Firebase Google Sign-In · Storage: AES-256-GCM + PostgreSQL DDL
          </p>
        </div>
      </div>
    );
  }

  const navTabs: Array<{
    id: TabKey;
    label: string;
    shortTag?: string;
    icon: React.ComponentType<{ className?: string }>;
    requiresProperty?: boolean;
  }> = [
    { id: 'overview', label: 'M-Channel VPS Suite', shortTag: 'NODE → PG', icon: Server },
    { id: 'pairing', label: 'Pairing & Mappings', icon: Layers },
    { id: 'ari', label: 'ARI & Inventory Push', icon: CalendarRange, requiresProperty: true },
    { id: 'bookings', label: 'Bookings & Webhooks', icon: ArrowLeftRight, requiresProperty: true },
    { id: 'logs', label: 'Live Postgres & VPS Bundle', icon: Database },
  ];

  return (
    <div
      className="min-h-screen bg-[#030912] text-slate-100 flex flex-col"
      style={{
        backgroundImage:
          'radial-gradient(circle at 12% 0%, rgba(6, 182, 212, 0.11), transparent 38%), radial-gradient(circle at 88% 4%, rgba(16, 185, 129, 0.08), transparent 34%)',
      }}
    >
      {/* Top Studio Header */}
      <header className="border-b border-[#112A3A] bg-[#040D17]/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          {/* Left: Brand Lockup & Subtitle */}
          <div className="flex items-start sm:items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-lg bg-[#082233] border border-[#164E68] flex items-center justify-center text-cyan-300 shrink-0 shadow-[0_0_20px_rgba(34,211,238,0.14)]">
              <Building2 className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white whitespace-nowrap">
                  M-Channel → PostgreSQL VPS Studio
                </h1>
                {snapshot && (
                  <span className="text-xs font-mono text-cyan-300 whitespace-nowrap">
                    · {snapshot.property.code} ({snapshot.property.environment})
                  </span>
                )}
              </div>
              <p className="text-xs font-mono text-slate-400 truncate mt-0.5">
                OTA / PMS Sync: Reservations, Ack, Room Availability &amp; Rate Ingestion into PostgreSQL
              </p>
            </div>
          </div>

          {/* Right: Property Switcher, Health Latency, Primary Action */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {properties.length > 0 && (
              <select
                value={selectedPropertyId || ''}
                onChange={(e) => handleSelectProperty(e.target.value)}
                aria-label="Select paired property"
                className="px-3 py-2 text-xs font-mono bg-[#071827] border border-[#174056] rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400 max-w-[210px]"
              >
                {properties.map((p) => (
                  <option key={p.propertyId} value={p.propertyId}>
                    {p.name} ({p.environment})
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => fetchPropertiesAndSnapshot(selectedPropertyId ?? undefined)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-mono text-emerald-300 bg-[#062020] hover:bg-[#082B2A] border border-emerald-700/60 rounded-lg transition-colors whitespace-nowrap shrink-0"
              title="Measured API health & state refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>API: {apiLatencyMs !== null ? `${apiLatencyMs}ms` : 'Ready'}</span>
            </button>

            <button
              type="button"
              onClick={handleExecuteMasterSync}
              disabled={syncingMaster}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Zap className="w-3.5 h-3.5" />
              {syncingMaster ? 'Syncing...' : snapshot ? 'Execute Sync' : 'Pair Property'}
            </button>

            <button
              type="button"
              onClick={() => signOut(auth)}
              title={`Signed in as ${user.email}`}
              className="p-2 text-slate-400 hover:text-white bg-[#071827] border border-[#15364A] rounded-lg transition-colors shrink-0"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Horizontal Tab Navigation Bar */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-3 flex items-center gap-2 overflow-x-auto">
          {navTabs.map((tab) => {
            const Icon = tab.icon;
            const disabled = Boolean(tab.requiresProperty && !snapshot);
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                disabled={disabled}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-[#092738] border-[#1A6382] text-cyan-200 shadow-[inset_0_1px_0_rgba(56,189,248,0.18)]'
                    : disabled
                    ? 'bg-transparent border-transparent text-slate-600 cursor-not-allowed'
                    : 'bg-transparent border-transparent text-slate-400 hover:text-slate-100 hover:bg-[#081927]'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span>{tab.label}</span>
                {tab.shortTag && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#0C374C] text-cyan-300">
                    {tab.shortTag}
                  </span>
                )}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setActiveTab('pairing')}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:text-emerald-200 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> Pair New Property
          </button>
        </div>
      </header>

      {/* Main Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {loadError && (
          <div className="p-3.5 bg-red-950/70 border border-red-700/70 rounded-lg text-xs font-mono text-red-200">
            {loadError}
          </div>
        )}
        {headerNotice && (
          <div className="p-3.5 bg-[#072629] border border-emerald-700/60 rounded-lg text-xs font-mono text-emerald-200">
            {headerNotice}
          </div>
        )}

        {activeTab === 'overview' && (
          <OverviewChecklistView
            properties={properties}
            snapshot={snapshot}
            onRefresh={() => fetchPropertiesAndSnapshot(snapshot?.property.propertyId)}
            onNavigate={(tab) => setActiveTab(tab)}
            onExecuteMasterSync={handleExecuteMasterSync}
            syncingMaster={syncingMaster}
          />
        )}

        {activeTab === 'pairing' && (
          <PairingSetupView
            snapshot={snapshot}
            onPaired={async (pid) => {
              await fetchPropertiesAndSnapshot(pid);
              setActiveTab('overview');
            }}
            onRefresh={() => fetchPropertiesAndSnapshot(selectedPropertyId ?? undefined)}
          />
        )}

        {activeTab === 'ari' && snapshot && (
          <AriInventoryView
            snapshot={snapshot}
            onRefresh={() => fetchPropertiesAndSnapshot(snapshot.property.propertyId)}
          />
        )}

        {activeTab === 'bookings' && snapshot && (
          <BookingsWebhooksView
            snapshot={snapshot}
            onRefresh={() => fetchPropertiesAndSnapshot(snapshot.property.propertyId)}
          />
        )}

        {activeTab === 'logs' && <LogsPostgresView snapshot={snapshot} />}
      </main>
    </div>
  );
}
