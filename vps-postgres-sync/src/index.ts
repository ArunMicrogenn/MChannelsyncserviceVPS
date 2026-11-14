import 'dotenv/config';
import express from 'express';
import { Client } from 'pg';
import { pool } from './db.js';
import { handleWebhookRequest, pollMissedBookings } from './inboundBookings.js';
import { enqueueDirtyInventory, flushAriOutbox } from './outboundAri.js';

const PORT = Number(process.env.PORT || 4000);
const OUTBOX_INTERVAL_MS = Number(process.env.OUTBOX_INTERVAL_MS || 5000);
const PULL_INTERVAL_MS = Number(process.env.PULL_INTERVAL_MS || 60000);

let isShuttingDown = false;
let outboundRunning = false;
let pullRunning = false;

async function runOutboundSync(propertyHint?: string) {
  if (outboundRunning || isShuttingDown) return;
  outboundRunning = true;
  try {
    await enqueueDirtyInventory(propertyHint);
    await flushAriOutbox();
  } catch (err) {
    console.error('[outbound-ari] Error:', err);
  } finally {
    outboundRunning = false;
  }
}

async function runInboundPull() {
  if (pullRunning || isShuttingDown) return;
  pullRunning = true;
  try {
    await pollMissedBookings();
  } catch (err) {
    console.error('[inbound-pull] Error:', err);
  } finally {
    pullRunning = false;
  }
}

async function startPostgresListener(): Promise<Client> {
  const listener = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'mchannel_pms_sync',
    user: process.env.PGUSER || 'mchannel_sync',
    password: process.env.PGPASSWORD || '',
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  await listener.connect();
  await listener.query('LISTEN mchannel_inventory_changed');

  listener.on('notification', (msg) => {
    if (msg.channel === 'mchannel_inventory_changed') {
      void runOutboundSync(msg.payload || undefined);
    }
  });

  listener.on('error', (err) => {
    console.error('[pg-listener] Error:', err.message);
  });

  console.log('[pg-listener] Listening for real-time pms_room_inventory updates');
  return listener;
}

async function main() {
  const app = express();

  // Raw body middleware MUST be registered before express.json() for HMAC-SHA256 verification
  const rawBody = express.raw({ type: '*/*', limit: '2mb' });
  const webhookRoute = async (req: express.Request, res: express.Response) => {
    try {
      const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');
      const result = await handleWebhookRequest({
        propertyIdHint: req.params.propertyId,
        rawBody: bodyBuffer,
        timestamp: String(req.header('X-MChannel-Timestamp') || ''),
        signature: String(req.header('X-MChannel-Signature') || ''),
        eventId: String(req.header('X-MChannel-Event-Id') || ''),
      });
      res.status(result.httpStatus).json(result.body);
      // Immediately flush any delta inventory changes triggered by the booking
      if (result.httpStatus === 200) {
        void runOutboundSync();
      }
    } catch (err) {
      console.error('[webhook] Unhandled error:', err);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  };

  app.post('/api/v1/mchannel/webhook/:propertyId', rawBody, webhookRoute);
  app.post('/api/v1/mchannel/webhook', rawBody, webhookRoute);
  app.post('/mchannel/webhook/:propertyId', rawBody, webhookRoute);
  app.post('/mchannel/webhook', rawBody, webhookRoute);

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, service: 'mchannel-vps-postgres-sync', contract_version: '1.3.0' });
    } catch (err: any) {
      res.status(503).json({ ok: false, error: err?.message || 'Database unreachable' });
    }
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[vps-sync] Webhook & Health HTTP server listening on port ${PORT}`);
  });

  const listener = await startPostgresListener();

  // Startup catch-up sweep
  await runInboundPull();
  await runOutboundSync();

  const outboxTimer = setInterval(() => void runOutboundSync(), OUTBOX_INTERVAL_MS);
  const pullTimer = setInterval(() => void runInboundPull(), PULL_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[vps-sync] Received ${signal}, shutting down cleanly...`);
    clearInterval(outboxTimer);
    clearInterval(pullTimer);
    server.close();
    await listener.end().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[vps-sync] Fatal startup error:', err);
  process.exit(1);
});
