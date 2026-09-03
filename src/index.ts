import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import mongoose from 'mongoose';
import { config } from './config';
import venueRoutes from './routes/venue.routes';
import { Venue } from './models/Venue';
import { errorHandler, notFoundHandler, asyncHandler } from './middleware/error';
import { requestLogger } from './middleware/logger';
import { getQueueStats, closeQueue } from './queue/scrape.queue';
import { closeRedis } from './queue/connection';
import { GooglePlacesService } from './services/googlePlaces.service';
import { providerStatus } from './providers';
import { ImageService } from './services/image.service';

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

// Serve the static dashboard
app.use(express.static(path.join(__dirname, '../public')));

// Serve converted WebP assets with a long-lived cache (hashed filenames)
app.use(
  '/uploads/images',
  express.static(config.uploadsDir, { maxAge: '30d', immutable: true, fallthrough: true })
);

// Throttle the API surface only; static assets stay unmetered.
app.use(
  '/api',
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: 'error', message: 'Too many requests, please slow down.' },
  })
);

app.use('/api/v1/venues', venueRoutes);

app.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const queue = await getQueueStats();
    const mongoConnected = mongoose.connection.readyState === 1;

    res.status(mongoConnected ? 200 : 503).json({
      status: mongoConnected ? 'ok' : 'degraded',
      environment: config.env,
      mongo_state: mongoConnected ? 'connected' : 'disconnected',
      redis_state: queue.available ? 'connected' : 'unavailable',
      google_places: GooglePlacesService.isLive ? 'live' : 'no API key (not required)',
      providers: providerStatus(),
      queue,
      image_pipeline: { ...ImageService.storageStats(), webp_quality: config.webpQuality },
      timestamp: new Date().toISOString(),
    });
  })
);

// API surface descriptor - useful for integrators and smoke tests.
app.get('/api/v1', (_req, res) => {
  res.json({
    name: 'PlaceFind SaaS API',
    version: '1.1.0',
    endpoints: {
      'POST /api/v1/venues/search': 'GEO or text scan via the provider chain; queues enrichment jobs',
      'POST /api/v1/venues/ingest': 'Ingest venues from supplied URLs; crawls the menu and audits the site',
      'GET  /api/v1/venues': 'Filtered, paginated venue list',
      'GET  /api/v1/venues/nearby': '2dsphere $near radius query',
      'POST /api/v1/venues/within': '2dsphere $geoWithin bbox/polygon query',
      'GET  /api/v1/venues/stats': 'Market & pipeline aggregates',
      'GET  /api/v1/venues/export': 'Bulk export (json|xml|csv)',
      'GET  /api/v1/venues/jobs/:jobId': 'Enrichment job status',
      'GET  /api/v1/venues/:id': 'Single venue',
      'GET  /api/v1/venues/:id/export': 'Single venue export (json|xml|csv)',
      'POST /api/v1/venues/:id/refresh': 'Re-run the enrichment pipeline',
      'DELETE /api/v1/venues/:id': 'Delete a venue',
    },
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

async function connectMongoDB(): Promise<void> {
  console.log(`[MongoDB] Connecting to ${config.mongoUri}...`);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  console.log('[MongoDB] Connected successfully.');

  // Ensure the 2dsphere and filter indexes exist before serving traffic.
  await Venue.syncIndexes();
  console.log('[MongoDB] Indexes synchronised (2dsphere ready).');
}

async function bootstrap(): Promise<void> {
  try {
    await connectMongoDB();

    const server = app.listen(config.port, () => {
      console.log(`🚀 [PlaceFind SaaS] Dashboard running at http://localhost:${config.port}`);
      console.log(`📁 WebP assets served from ${config.uploadsDir}`);
      const status = providerStatus();
      const configured = status.available
        .filter((entry) => entry.configured)
        .map((entry) => entry.provider);
      console.log(`🔎 Place provider: ${status.active} (fallbacks: ${status.fallbacks.join(', ') || 'none'})`);
      console.log(`   Configured providers: ${configured.join(', ') || 'none'}`);
    });

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\n[Shutdown] ${signal} received, closing gracefully...`);
      server.close();
      await closeQueue();
      await closeRedis();
      await mongoose.disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error: any) {
    console.error(`❌ [Bootstrap Error] ${error.message}`);
    process.exit(1);
  }
}

bootstrap();

export { app };
