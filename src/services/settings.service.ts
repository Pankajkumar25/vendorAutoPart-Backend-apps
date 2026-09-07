import { Settings, type ISettings } from '../models/settings.model';
import { logger } from '../config/logger';

/**
 * Settings are read on essentially every pricing call, so they are cached in
 * process for a short window. The TTL is deliberately small: an admin who
 * lowers the COD limit expects it to take effect within seconds, and every
 * write path calls `invalidateSettingsCache()` anyway.
 */
const CACHE_TTL_MS = 15_000;

let cached: { doc: ISettings; at: number } | null = null;

/** Creates the singleton on first use so a fresh database just works. */
export async function getSettings(force = false): Promise<ISettings> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.doc;

  let doc = await Settings.findOne({ key: 'app' });
  if (!doc) {
    doc = await Settings.create({ key: 'app' });
    logger.info('[settings] created default settings document');
  }
  cached = { doc, at: Date.now() };
  return doc;
}

export function invalidateSettingsCache(): void {
  cached = null;
}

export async function updateSettings(
  patch: Partial<Record<keyof ISettings, unknown>>,
  updatedBy?: string,
): Promise<ISettings> {
  const doc = await getSettings(true);

  // `key` is immutable and the audit fields are set by us, never by the caller.
  const forbidden = new Set(['key', '_id', 'createdAt', 'updatedAt', '__v', 'updatedBy']);
  for (const [field, value] of Object.entries(patch)) {
    if (forbidden.has(field)) continue;
    if (value === undefined) continue;
    (doc as unknown as Record<string, unknown>)[field] = value;
  }
  if (updatedBy) doc.updatedBy = updatedBy as unknown as ISettings['updatedBy'];

  await doc.save();
  invalidateSettingsCache();
  return doc;
}

/** Projection of settings that is safe to hand to a customer-facing client. */
export async function getPublicSettings(): Promise<Record<string, unknown>> {
  const s = await getSettings();
  return {
    storeName: s.storeName,
    supportPhone: s.supportPhone,
    supportEmail: s.supportEmail,
    currency: s.currency,
    cod: {
      enabled: s.codEnabled,
      maxOrderAmount: s.codMaxOrderAmount,
      minOrderAmount: s.codMinOrderAmount,
      advanceRequired: s.codAdvanceRequired,
    },
    delivery: {
      freeAboveAmount: s.deliveryFreeAboveAmount,
      estimatedDays: s.estimatedDeliveryDays,
    },
    order: {
      minOrderAmount: s.minOrderAmount,
      cancellationWindowHours: s.customerCancellationWindowHours,
    },
    display: {
      showMrp: s.showMrpToCustomers,
      gstMode: s.gstMode,
    },
    platform: {
      maintenanceMode: s.maintenanceMode,
      maintenanceMessage: s.maintenanceMessage,
      minSupportedAppVersion: s.minSupportedAppVersion,
    },
  };
}
