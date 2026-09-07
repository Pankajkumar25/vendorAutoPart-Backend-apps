import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getPublicSettings } from '../services/settings.service';
import { gateway, isMockGateway } from '../services/payment.service';
import { isUploadEnabled } from '../services/upload.service';
import { ok } from '../utils/apiResponse';
import { env } from '../config/env';

/**
 * Public, unauthenticated configuration the app needs before (and without) a
 * signed-in session (spec section 32).
 *
 * Only the customer-safe projection of settings is exposed here - the payment
 * *secret*, gateway credentials and internal pricing knobs never appear.
 * `getPublicSettings` is the single gate for that.
 */

/** Store identity, COD/delivery rules and platform flags for the client. */
export async function getPublicSettingsController(_req: Request, res: Response): Promise<void> {
  ok(res, await getPublicSettings());
}

/**
 * One bootstrap call the app makes on launch: public settings plus the payment
 * gateway's *public* handle and whether image uploads are available. Bundling
 * them saves a cold-start round-trip and gives the app a single source for
 * "what is this backend configured to do".
 */
export async function getAppConfig(_req: Request, res: Response): Promise<void> {
  const settings = await getPublicSettings();
  const g = gateway();

  ok(res, {
    settings,
    payment: {
      provider: g.name,
      // Public key only - the secret lives in payment.service and never leaves it.
      publicKey: g.publicKey,
      currency: env.PAYMENT_CURRENCY,
      isMock: isMockGateway(),
    },
    features: {
      imageUploads: isUploadEnabled(),
    },
    serverTime: new Date().toISOString(),
  });
}

/**
 * Liveness/readiness probe for the load balancer and the app's connectivity
 * check. Reports the database connection state; returns 503 when the database
 * is not connected so an orchestrator can pull the instance out of rotation.
 */
export async function healthCheck(_req: Request, res: Response): Promise<void> {
  const state = mongoose.connection.readyState; // 1 = connected
  const dbConnected = state === 1;

  ok(
    res,
    {
      status: dbConnected ? 'ok' : 'degraded',
      database: dbConnected ? 'connected' : 'disconnected',
      uptimeSeconds: Math.floor(process.uptime()),
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
    undefined,
    undefined,
    dbConnected ? 200 : 503,
  );
}
