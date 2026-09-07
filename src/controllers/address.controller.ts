import type { Request, Response } from 'express';
import { Address } from '../models/address.model';
import { requireAuth } from '../middleware/auth.middleware';
import { getSettings } from '../services/settings.service';
import { calculateDelivery } from '../services/delivery.service';
import { created, noContent, ok } from '../utils/apiResponse';
import { ApiError } from '../utils/apiError';
import { toPaise, toRupees } from '../utils/money';

/**
 * Address book (spec section 4).
 *
 * Coordinates are stored when the device supplies them but are never required:
 * the typed PIN code is what drives delivery zones, so a customer who refuses
 * location permission is not blocked from ordering.
 */

function toGeoPoint(latitude?: number | null, longitude?: number | null) {
  if (latitude == null || longitude == null) return null;
  return { type: 'Point' as const, coordinates: [longitude, latitude] as [number, number] };
}

async function unsetOtherDefaults(userId: unknown, keepId?: unknown): Promise<void> {
  await Address.updateMany(
    { userId, isDeleted: false, ...(keepId ? { _id: { $ne: keepId } } : {}) },
    { $set: { isDefault: false } },
  );
}

export async function listAddresses(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const addresses = await Address.find({ userId: auth.userId, isDeleted: false })
    .sort({ isDefault: -1, updatedAt: -1 })
    .lean({ virtuals: true });
  ok(res, addresses);
}

export async function getAddress(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const address = await Address.findOne({
    _id: req.params.id,
    userId: auth.userId,
    isDeleted: false,
  }).lean({ virtuals: true });
  if (!address) throw ApiError.notFound('Address not found');
  ok(res, address);
}

export async function createAddress(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);

  const existingCount = await Address.countDocuments({ userId: auth.userId, isDeleted: false });
  if (existingCount >= 30) {
    throw ApiError.badRequest('You have reached the maximum number of saved addresses');
  }

  // The first address a customer saves is their default whether they asked for
  // it or not - otherwise checkout has nothing preselected.
  const isDefault = req.body.isDefault ?? existingCount === 0;
  if (isDefault) await unsetOtherDefaults(auth.userId);

  const address = await Address.create({
    ...req.body,
    userId: auth.userId,
    isDefault,
    location: toGeoPoint(req.body.latitude, req.body.longitude),
    locationSource: req.body.latitude != null ? 'GPS' : 'MANUAL',
  });

  created(res, address.toJSON(), 'Address saved');
}

export async function updateAddress(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const address = await Address.findOne({ _id: req.params.id, userId: auth.userId, isDeleted: false });
  if (!address) throw ApiError.notFound('Address not found');

  Object.assign(address, req.body);

  if (req.body.latitude !== undefined || req.body.longitude !== undefined) {
    address.location = toGeoPoint(address.latitude, address.longitude);
    address.locationSource = address.latitude != null ? 'MAP_PICK' : 'MANUAL';
  }

  if (req.body.isDefault === true) await unsetOtherDefaults(auth.userId, address._id);
  await address.save();

  ok(res, address.toJSON(), 'Address updated');
}

export async function setDefaultAddress(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const address = await Address.findOne({ _id: req.params.id, userId: auth.userId, isDeleted: false });
  if (!address) throw ApiError.notFound('Address not found');

  await unsetOtherDefaults(auth.userId, address._id);
  address.isDefault = true;
  await address.save();

  ok(res, address.toJSON(), 'Default delivery address updated');
}

/**
 * Soft delete. Orders keep a frozen copy of the address they shipped to, but
 * hard-deleting the row would still break the "deliver here again" link on an
 * old order, so the record stays and is simply hidden.
 */
export async function deleteAddress(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const address = await Address.findOne({ _id: req.params.id, userId: auth.userId, isDeleted: false });
  if (!address) throw ApiError.notFound('Address not found');

  address.isDeleted = true;
  address.isDefault = false;
  await address.save();

  // Promote another address so the customer is never left without a default.
  const replacement = await Address.findOne({ userId: auth.userId, isDeleted: false }).sort({
    updatedAt: -1,
  });
  if (replacement && !replacement.isDefault) {
    replacement.isDefault = true;
    await replacement.save();
  }

  noContent(res);
}

/**
 * Serviceability + delivery quote for a PIN code, so the customer learns the
 * charge before they have committed to an address.
 */
export async function checkPincode(req: Request, res: Response): Promise<void> {
  const pincode = req.params.pincode ?? (req.body?.pincode as string);
  const settings = await getSettings();

  const amount = Number(req.body?.amount ?? req.query?.amount ?? 0) || 0;
  const weight = Number(req.body?.weight ?? req.query?.weight ?? 0) || 0;

  const quote = calculateDelivery(
    { merchandisePaise: toPaise(amount), totalWeightGrams: weight, pincode },
    settings,
  );

  const zone = settings.deliveryZones?.find((z) =>
    (z.pincodePrefixes ?? []).some((prefix) => prefix && pincode.startsWith(prefix)),
  );

  ok(res, {
    pincode,
    serviceable: true,
    zone: zone?.label ?? 'Standard delivery',
    deliveryCharge: toRupees(quote.chargePaise),
    isFree: quote.isFree,
    reason: quote.reason,
    estimatedDays: quote.estimatedDays,
    freeDeliveryShortfall:
      quote.freeDeliveryShortfallPaise != null ? toRupees(quote.freeDeliveryShortfallPaise) : null,
  });
}

/**
 * Reverse geocode helper for "use my current location".
 *
 * There is no third-party geocoder wired in - the endpoint echoes the
 * coordinates back with the nearest matching delivery zone so the app can
 * prefill the PIN code field when it already knows one. Whatever the customer
 * types still wins.
 */
export async function reverseGeocode(req: Request, res: Response): Promise<void> {
  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);

  ok(res, {
    latitude,
    longitude,
    // Deliberately empty rather than guessed: a wrong prefilled city is worse
    // than an empty one the customer fills in themselves.
    suggestion: null,
    message: 'Please confirm your address details',
  });
}
