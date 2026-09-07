import { Router } from 'express';
import * as c from '../controllers/address.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { validate, validateBody, validateParams, validateQuery } from '../middleware/validate.middleware';
import {
  addressBodySchema,
  updateAddressSchema,
  addressIdParams,
  geocodeQuerySchema,
  pincodeParams,
} from '../validators/address.validator';

/**
 * Delivery addresses (spec section 18). All private to the signed-in customer.
 * The serviceability and geocode helpers back the address form; they carry no
 * price logic, only "can we deliver here / what is this PIN called".
 */
const router = Router();

router.use(authenticate);

// Utility lookups come before the `/:id` routes so their literal paths win.
router.get('/geocode', validateQuery(geocodeQuerySchema), asyncHandler(c.reverseGeocode));
router.get('/pincode/:pincode', validateParams(pincodeParams), asyncHandler(c.checkPincode));

router.get('/', asyncHandler(c.listAddresses));
router.post('/', validateBody(addressBodySchema), asyncHandler(c.createAddress));
router.get('/:id', validateParams(addressIdParams), asyncHandler(c.getAddress));
router.patch(
  '/:id',
  validate({ params: addressIdParams, body: updateAddressSchema }),
  asyncHandler(c.updateAddress),
);
router.post('/:id/default', validateParams(addressIdParams), asyncHandler(c.setDefaultAddress));
router.delete('/:id', validateParams(addressIdParams), asyncHandler(c.deleteAddress));

export default router;
