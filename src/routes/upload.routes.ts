import { Router } from 'express';
import * as c from '../controllers/upload.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { requireAdmin, requirePermission } from '../middleware/admin.middleware';
import { uploadLimiter } from '../middleware/rateLimit.middleware';
import { uploadSingleImage, uploadManyImages } from '../middleware/upload.middleware';

/**
 * Image uploads (spec section 29). Admin-only: the catalogue is the only thing
 * uploaded against and customers never upload. Files pass through memory
 * straight to Cloudinary (`upload.middleware` + `upload.service`); the API
 * secret never leaves the backend, and the multer guard rails cap size/count.
 */
const router = Router();

router.use(authenticate, requireAdmin);

router.get('/status', asyncHandler(c.getUploadStatus));
router.post(
  '/image',
  requirePermission('products.write'),
  uploadLimiter,
  uploadSingleImage,
  asyncHandler(c.uploadSingle),
);
router.post(
  '/images',
  requirePermission('products.write'),
  uploadLimiter,
  uploadManyImages,
  asyncHandler(c.uploadMultiple),
);
router.post('/signature', requirePermission('products.write'), asyncHandler(c.getUploadSignature));
router.delete('/', requirePermission('products.write'), asyncHandler(c.deleteUpload));

export default router;
