import type { NextFunction, Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '../config/env';
import { ApiError } from '../utils/apiError';

/**
 * Image upload handling (spec section 29).
 *
 * Files are kept in memory only - they are streamed straight to Cloudinary by
 * `upload.service` and never touch this server's disk. The two guard rails that
 * matter: an image-only MIME allow-list (so a caller cannot post an executable
 * dressed as a product photo) and a size/count cap driven by env, so a single
 * request cannot exhaust memory.
 */

const MAX_FILE_BYTES = env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024;

// A conservative allow-list rather than a broad `image/*` test - it is the set
// the product catalogue actually needs and nothing that a browser would try to
// render as active content.
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: env.UPLOAD_MAX_FILES,
  },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    // Passing an error here surfaces as a MulterError-adjacent rejection which
    // `translateMulterError` turns into a clean 400.
    cb(new ApiError(400, 'Only JPEG, PNG, WebP, GIF or AVIF images are allowed', 'UNSUPPORTED_MEDIA_TYPE'));
  },
});

/**
 * Converts multer's own errors into the API's error envelope. Multer throws
 * outside the normal `next(err)` contract for limit breaches, so each upload
 * handler is wrapped to catch and translate them into a 400/413 the client can
 * read, instead of a generic 500.
 */
function translateMulterError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new ApiError(
          413,
          `Each image must be ${env.UPLOAD_MAX_FILE_SIZE_MB} MB or smaller`,
          'FILE_TOO_LARGE',
        );
      case 'LIMIT_FILE_COUNT':
        return new ApiError(400, `You can upload at most ${env.UPLOAD_MAX_FILES} images at once`, 'TOO_MANY_FILES');
      case 'LIMIT_UNEXPECTED_FILE':
        return new ApiError(400, `Unexpected file field "${err.field ?? ''}"`.trim(), 'UNEXPECTED_FILE');
      default:
        return new ApiError(400, err.message || 'Image upload failed', 'UPLOAD_ERROR');
    }
  }
  return ApiError.internal('Image upload failed');
}

/** Wraps a multer middleware so its errors flow through the API error handler. */
function wrap(mw: ReturnType<typeof upload.single>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    mw(req, res, (err: unknown) => {
      if (err) {
        next(translateMulterError(err));
        return;
      }
      next();
    });
  };
}

/** Accepts one image under the `image` field. */
export const uploadSingleImage = wrap(upload.single('image'));

/** Accepts up to `UPLOAD_MAX_FILES` images under the `images` field. */
export const uploadManyImages = wrap(upload.array('images', env.UPLOAD_MAX_FILES));
