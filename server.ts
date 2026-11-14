import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { requireAuth, type AuthRequest } from './src/server/authMiddleware.ts';
import {
  listPropertiesForUser,
  getPropertySnapshot,
  claimPairing,
  refreshHotelSetup,
  saveMappings,
  pushFull365Days,
  pushAriBatch,
  updatePmsInventoryAndPushDelta,
  retryOutboxBatch,
  pullStoredCalendar,
  createStopSale,
  reopenStopSale,
  pullBookingsFallback,
  reportBookingNoShow,
  requestInvalidCardCancel,
  getDiagnostics,
  handleIncomingWebhook,
  dispatchSimulatedSignedWebhook,
  runGoLiveChecklist,
} from './src/server/syncService.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);

  // 1. Public M-Channel Webhook Receivers (MUST read unmodified raw bytes before JSON parsing)
  const rawJsonMiddleware = express.raw({ type: '*/*', limit: '2mb' });
  const webhookHandler = async (req: express.Request, res: express.Response) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');
      const timestamp = String(req.header('X-MChannel-Timestamp') || '');
      const signature = String(req.header('X-MChannel-Signature') || '');
      const eventId = String(req.header('X-MChannel-Event-Id') || '');
      const propertyIdHint = req.params.propertyId;

      const result = await handleIncomingWebhook({
        propertyIdHint,
        rawBody,
        timestamp,
        signature,
        eventId,
      });

      res.status(result.httpStatus).json(result.body);
    } catch (err: any) {
      console.error('Webhook receiver error:', err);
      res.status(500).json({ ok: false, error: 'Internal webhook processing error' });
    }
  };

  app.post('/api/v1/mchannel/webhook/:propertyId', rawJsonMiddleware, webhookHandler);
  app.post('/api/v1/mchannel/webhook', rawJsonMiddleware, webhookHandler);
  app.post('/mchannel/webhook/:propertyId', rawJsonMiddleware, webhookHandler);
  app.post('/mchannel/webhook', rawJsonMiddleware, webhookHandler);

  // 2. JSON parser for all authenticated console & sync routes
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'mchannel-pms-sync', contract_version: '1.3.0' });
  });

  // 3. Authenticated Sync Management Routes
  app.get('/api/sync/properties', requireAuth, async (req: AuthRequest, res) => {
    try {
      const properties = await listPropertiesForUser(req.idToken!, req.user!.uid);
      res.json({ properties });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to list properties' });
    }
  });

  app.post('/api/sync/pairing/claim', requireAuth, async (req: AuthRequest, res) => {
    try {
      const result = await claimPairing({
        idToken: req.idToken!,
        ownerUid: req.user!.uid,
        environment: req.body.environment || 'simulator',
        baseUrl: req.body.baseUrl,
        code: req.body.code,
        pmsName: req.body.pmsName || 'NodePMS',
        pmsVersion: req.body.pmsVersion || '1.3.0',
        instanceUrl: req.body.instanceUrl || process.env.APP_URL || 'https://pms.example.com',
        webhookBaseUrl: req.body.webhookBaseUrl || process.env.APP_URL || `${req.protocol}://${req.get('host')}`,
        hotel: req.body.hotel,
        roomTypes: req.body.roomTypes || [],
        ratePlans: req.body.ratePlans || [],
      });
      res.status(201).json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Pairing failed' });
    }
  });

  app.get('/api/sync/properties/:propertyId/snapshot', requireAuth, async (req: AuthRequest, res) => {
    try {
      const snapshot = await getPropertySnapshot(req.idToken!, req.user!.uid, String(req.params.propertyId));
      res.json(snapshot);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to load property snapshot' });
    }
  });

  app.post('/api/sync/properties/:propertyId/refresh', requireAuth, async (req: AuthRequest, res) => {
    try {
      const data = await refreshHotelSetup(req.idToken!, req.user!.uid, String(req.params.propertyId));
      res.json(data);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to refresh hotel setup' });
    }
  });

  app.put('/api/sync/properties/:propertyId/mappings', requireAuth, async (req: AuthRequest, res) => {
    try {
      const data = await saveMappings(req.idToken!, req.user!.uid, String(req.params.propertyId), req.body.mappings || []);
      res.json(data);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to save mappings' });
    }
  });

  app.post('/api/sync/properties/:propertyId/ari/full-365', requireAuth, async (req: AuthRequest, res) => {
    try {
      const outbox = await pushFull365Days(req.idToken!, req.user!.uid, String(req.params.propertyId));
      res.json({ outbox });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Full 365-day push failed' });
    }
  });

  app.post('/api/sync/properties/:propertyId/ari/push', requireAuth, async (req: AuthRequest, res) => {
    try {
      const outbox = await pushAriBatch({
        idToken: req.idToken!,
        ownerUid: req.user!.uid,
        propertyId: String(req.params.propertyId),
        syncType: req.body.syncType || 'delta',
        availability: req.body.availability || [],
        restrictions: req.body.restrictions || [],
        idempotencyKey: req.body.idempotencyKey,
        bypassOwnershipGuard: Boolean(req.body.bypassOwnershipGuard),
      });
      res.json({ outbox });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'ARI push failed' });
    }
  });

  app.post('/api/sync/properties/:propertyId/inventory/update', requireAuth, async (req: AuthRequest, res) => {
    try {
      const result = await updatePmsInventoryAndPushDelta({
        idToken: req.idToken!,
        ownerUid: req.user!.uid,
        propertyId: String(req.params.propertyId),
        pmsRoomTypeRef: req.body.pmsRoomTypeRef,
        date: req.body.date,
        freeRooms: Number(req.body.freeRooms),
        rate: req.body.rate,
        minStayArrival: req.body.minStayArrival !== undefined && req.body.minStayArrival !== null ? Number(req.body.minStayArrival) : null,
        stopSell: req.body.stopSell,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Inventory update failed' });
    }
  });

  app.post('/api/sync/properties/:propertyId/outbox/:idempotencyKey/retry', requireAuth, async (req: AuthRequest, res) => {
    try {
      const outbox = await retryOutboxBatch(req.idToken!, req.user!.uid, String(req.params.propertyId), String(req.params.idempotencyKey));
      res.json({ outbox });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Retry failed' });
    }
  });

  app.get('/api/sync/properties/:propertyId/ari/remote', requireAuth, async (req: AuthRequest, res) => {
    try {
      const dateFrom = String(req.query.date_from || new Date().toISOString().slice(0, 10));
      const dateTo = String(req.query.date_to || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
      const changedSince = req.query.changed_since ? String(req.query.changed_since) : undefined;
      const calendar = await pullStoredCalendar(req.idToken!, req.user!.uid, String(req.params.propertyId), dateFrom, dateTo, changedSince);
      res.json({ calendar });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to read remote ARI calendar' });
    }
  });

  app.post('/api/sync/properties/:propertyId/stop-sales', requireAuth, async (req: AuthRequest, res) => {
    try {
      const stopSale = await createStopSale({
        idToken: req.idToken!,
        ownerUid: req.user!.uid,
        propertyId: String(req.params.propertyId),
        pmsRoomTypeRef: req.body.pmsRoomTypeRef || null,
        dateFrom: req.body.dateFrom,
        dateTo: req.body.dateTo,
        otas: req.body.otas || 'all',
        reason: req.body.reason || 'Manual stop sale',
      });
      res.status(201).json({ stopSale });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to create stop sale' });
    }
  });

  app.post('/api/sync/properties/:propertyId/stop-sales/:stopSaleId/reopen', requireAuth, async (req: AuthRequest, res) => {
    try {
      const result = await reopenStopSale(req.idToken!, req.user!.uid, String(req.params.propertyId), String(req.params.stopSaleId));
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to reopen stop sale' });
    }
  });

  app.post('/api/sync/properties/:propertyId/bookings/pull', requireAuth, async (req: AuthRequest, res) => {
    try {
      const since = String(req.body.since || '2026-01-01T00:00:00Z');
      const onlyUnacked = req.body.onlyUnacked !== false;
      const result = await pullBookingsFallback(req.idToken!, req.user!.uid, String(req.params.propertyId), since, onlyUnacked);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Pull bookings fallback failed' });
    }
  });

  app.post('/api/sync/properties/:propertyId/bookings/:bookingId/no-show', requireAuth, async (req: AuthRequest, res) => {
    try {
      const data = await reportBookingNoShow(req.idToken!, req.user!.uid, String(req.params.propertyId), String(req.params.bookingId), Boolean(req.body.waiveFees));
      res.json({ data });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'No-show report failed' });
    }
  });

  app.post('/api/sync/properties/:propertyId/bookings/:bookingId/cancel-request', requireAuth, async (req: AuthRequest, res) => {
    try {
      const data = await requestInvalidCardCancel(req.idToken!, req.user!.uid, String(req.params.propertyId), String(req.params.bookingId), String(req.body.note || 'Invalid card reported by hotel'));
      res.json({ data });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Cancel request failed' });
    }
  });

  app.get('/api/sync/properties/:propertyId/diagnostics', requireAuth, async (req: AuthRequest, res) => {
    try {
      const data = await getDiagnostics(req.idToken!, req.user!.uid, String(req.params.propertyId));
      res.json(data);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to fetch diagnostics' });
    }
  });

  app.post('/api/sync/properties/:propertyId/webhooks/simulate', requireAuth, async (req: AuthRequest, res) => {
    try {
      const result = await dispatchSimulatedSignedWebhook({
        idToken: req.idToken!,
        ownerUid: req.user!.uid,
        propertyId: String(req.params.propertyId),
        scenario: req.body.scenario || 'created',
        bookingId: req.body.bookingId,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Webhook simulation failed' });
    }
  });

  app.post('/api/sync/properties/:propertyId/checklist/run', requireAuth, async (req: AuthRequest, res) => {
    try {
      const results = await runGoLiveChecklist(req.idToken!, req.user!.uid, String(req.params.propertyId));
      res.json({ results });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Checklist run failed' });
    }
  });

  app.get('/api/sync/vps-bundle', requireAuth, async (_req: AuthRequest, res) => {
    try {
      const bundleDir = path.resolve(__dirname, 'vps-postgres-sync');
      const relativeFiles = [
        'README.md',
        'install_vps.sh',
        'package.json',
        'tsconfig.json',
        '.env.example',
        'sql/000_create_database.sql',
        'sql/001_schema.sql',
        'src/index.ts',
        'src/inboundBookings.ts',
        'src/outboundAri.ts',
        'src/db.ts',
        'src/crypto.ts',
        'src/mchannel.ts',
        'src/pairCli.ts',
        'src/migrate.ts',
        'ecosystem.config.cjs',
        'mchannel-sync.service',
      ];
      const files = await Promise.all(
        relativeFiles.map(async (rel) => ({
          path: rel,
          content: await fs.readFile(path.join(bundleDir, rel), 'utf8'),
        }))
      );
      res.json({ files });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to read VPS bundle' });
    }
  });

  // 4. Vite Dev Middleware or Static Production Build
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`M-Channel PMS Sync Service listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
