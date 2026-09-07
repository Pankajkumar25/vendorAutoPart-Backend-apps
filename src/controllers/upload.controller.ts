import type { Request, Response } from 'express';
import { uploadImage, uploadImages, deleteImage, createUploadSignature, isUploadEnabled } from '../services/upload.service';
import { ok, created } from '../utils/apiResponse';
import { ApiError } from '../utils/apiError';

/**
 * Image upload endpoints (spec section 29).
 *
 * These sit behind admin auth in the router - the catalogue is the only thing
 * customers upload against, and they do not. The actual Cloudinary credentials
 * live in `upload.service`; nothing here can see them. Files arrive in memory
 * via multer (`req.file` / `req.files`) and are streamed straight through.
 */

/** Optional per-request folder, constrained so a caller cannot escape the root. */
function safeFolder(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  // Only simple nested folder names, never an absolute or traversing path.
  const cleaned = input.trim().replace(/^\/+|\/+$/g, '');
  if (!/^[a-zA-Z0-9_\-/]{1,80}$/.test(cleaned) || cleaned.includes('..')) {
    throw ApiError.badRequest('Invalid upload folder');
  }
  return cleaned;
}

export async function uploadSingle(req: Request, res: Response): Promise<void> {
  if (!req.file) throw ApiError.badRequest('No image file was provided');
  const folder = safeFolder(req.body?.folder ?? req.query?.folder);

  const image = await uploadImage(req.file.buffer, req.file.originalname, { folder });
  created(res, image, 'Image uploaded');
}

export async function uploadMultiple(req: Request, res: Response): Promise<void> {
  const files = req.files ?? [];
  if (!files.length) throw ApiError.badRequest('No image files were provided');
  const folder = safeFolder(req.body?.folder ?? req.query?.folder);

  const images = await uploadImages(
    files.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
    { folder },
  );
  created(res, { images, count: images.length }, 'Images uploaded');
}

/**
 * Removes an asset from Cloudinary. `publicId` is what `uploadImage` returned;
 * it is required because the URL alone is not a reliable delete key.
 */
export async function deleteUpload(req: Request, res: Response): Promise<void> {
  const publicId = req.body?.publicId ?? req.params?.publicId;
  if (typeof publicId !== 'string' || !publicId) throw ApiError.badRequest('publicId is required');

  const removed = await deleteImage(publicId);
  ok(res, { removed }, removed ? 'Image deleted' : 'Image could not be deleted');
}

/**
 * Signed direct-upload parameters, so the admin app can upload large product
 * photos straight to Cloudinary without the bytes passing through this server.
 * The signature is produced server-side, so the API secret still never leaves
 * the backend.
 */
export async function getUploadSignature(req: Request, res: Response): Promise<void> {
  const folder = safeFolder(req.body?.folder ?? req.query?.folder);
  ok(res, createUploadSignature(folder));
}

/** Whether uploads are configured at all, so the admin UI can hide the button. */
export async function getUploadStatus(_req: Request, res: Response): Promise<void> {
  ok(res, { enabled: isUploadEnabled() });
}
