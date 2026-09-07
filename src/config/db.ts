import mongoose from 'mongoose';
import { env, isProd } from './env';
import { logger } from './logger';

mongoose.set('strictQuery', true);
// Surfaces missing indexes as errors during development instead of silently
// running unindexed collection scans in production.
if (!isProd) mongoose.set('autoIndex', true);

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDatabase(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;

  connecting = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 20,
      minPoolSize: 2,
      retryWrites: true,
    })
    .then((m) => {
      logger.info(`[db] connected to ${m.connection.name}`);
      return m;
    })
    .catch((err) => {
      connecting = null;
      throw err;
    });

  return connecting;
}

export async function disconnectDatabase(): Promise<void> {
  connecting = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('[db] disconnected');
  }
}

mongoose.connection.on('error', (err) => logger.error('[db] connection error', err));
mongoose.connection.on('disconnected', () => logger.warn('[db] disconnected'));

/**
 * Whether the deployment can run multi-document transactions. Standalone
 * mongod (the common local dev setup) cannot, so order creation degrades to a
 * non-transactional path guarded by conditional stock updates.
 */
export function supportsTransactions(): boolean {
  const topology = (mongoose.connection as unknown as { client?: { topology?: { description?: { type?: string } } } })
    .client?.topology?.description?.type;
  return topology === 'ReplicaSetWithPrimary' || topology === 'Sharded';
}
