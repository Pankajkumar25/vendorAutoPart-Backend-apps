import { z } from 'zod';
import { ADDRESS_TYPES } from '../config/constants';
import { indianMobile, objectId, pincode, text } from './common.validator';

/**
 * Address, including the optional GPS pair from spec section 4.
 *
 * Coordinates are optional on purpose: "use my current location" is a
 * convenience, and a customer who denies location permission must still be able
 * to place an order. The typed pincode is what actually drives delivery zones.
 */
export const addressBodySchema = z.object({
  fullName: text(120, 'Contact name'),
  mobile: indianMobile,
  alternateMobile: indianMobile.optional().or(z.literal('')),
  houseNumber: text(80, 'House / shop number'),
  street: text(160, 'Street'),
  area: text(160, 'Area / locality'),
  landmark: z.string().trim().max(160).optional().or(z.literal('')),
  city: text(80, 'City'),
  state: text(80, 'State'),
  pincode,
  country: z.string().trim().max(80).default('India'),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  addressType: z.nativeEnum(ADDRESS_TYPES).default(ADDRESS_TYPES.SHOP),
  isDefault: z.boolean().optional(),
});

export const updateAddressSchema = addressBodySchema.partial();

export const addressIdParams = z.object({ id: objectId });

/** Reverse-geocode helper: takes a coordinate pair from the device. */
export const geocodeQuerySchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

/** Delivery-serviceability check before the customer commits to an address. */
export const pincodeParams = z.object({ pincode });
