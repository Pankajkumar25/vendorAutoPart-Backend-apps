import { afterAll, afterEach, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { invalidateSettingsCache } from '../services/settings.service';

/**
 * Shared test database lifecycle.
 *
 * One in-memory mongod for the whole file, a fresh set of collections for every
 * test. The settings cache is process-global, so it is invalidated alongside
 * the wipe - otherwise a test that changed store settings would leak its rules
 * into the next one.
 */

let mongo: MongoMemoryServer;

beforeAll(async () => {
  // A cold first launch on Windows (antivirus scanning the freshly-extracted
  // mongod.exe) can exceed the 10s default; give it room so the suite is not
  // flaky on the first run of the day.
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await connectDatabase(mongo.getUri());
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
  invalidateSettingsCache();
});

afterAll(async () => {
  await disconnectDatabase();
  if (mongo) await mongo.stop();
});
