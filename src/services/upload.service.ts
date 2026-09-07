import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from 'cloudinary';
import { cloudinaryConfigured, env } from '../config/env';
import { logger } from '../config/logger';
import { ApiError } from '../utils/apiError';

/**
 * Image uploads (spec section 29).
 *
 * Files are streamed straight from memory to Cloudinary - nothing is written to
 * the server's disk, so the API stays stateless and horizontally scalable.
 * Credentials live only in the environment.
 *
 * When Cloudinary is not configured the upload endpoints fail with a clear
 * message rather than a stack trace. Everything else in the app keeps working,
 * which matters for local development.
 */

let configured = false;

function ensureConfigured(): void {
  if (!cloudinaryConfigured) {
    throw new ApiError(
      503,
      'Image uploads are not configured on this server. Add the Cloudinary credentials to enable them.',
      'UPLOAD_NOT_CONFIGURED',
    );
  }
  if (!configured) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
}

export interface UploadedImage {
  url: string;
  publicId: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
}

export interface UploadOptions {
  folder?: string;
  /** Overwrite an existing asset - used when replacing a product image. */
  publicId?: string;
}

export async function uploadImage(
  buffer: Buffer,
  originalName: string,
  options: UploadOptions = {},
): Promise<UploadedImage> {
  ensureConfigured();

  const uploadOptions: UploadApiOptions = {
    folder: options.folder ?? env.CLOUDINARY_UPLOAD_FOLDER,
    public_id: options.publicId,
    resource_type: 'image',
    overwrite: Boolean(options.publicId),
    // Product photos arrive straight from a phone camera. Capping the long edge
    // and letting Cloudinary pick the format keeps the catalogue fast on mobile
    // data without the admin having to think about it.
    transformation: [
      { width: 1600, height: 1600, crop: 'limit' },
      { quality: 'auto:good' },
      { fetch_format: 'auto' },
    ],
    context: { original_filename: originalName.slice(0, 120) },
  };

  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, uploaded) => {
      if (error || !uploaded) {
        reject(new ApiError(502, error?.message ?? 'Image upload failed', 'UPLOAD_FAILED'));
        return;
      }
      resolve(uploaded);
    });
    stream.end(buffer);
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
  };
}

export async function uploadImages(
  files: { buffer: Buffer; originalname: string }[],
  options: UploadOptions = {},
): Promise<UploadedImage[]> {
  return Promise.all(files.map((file) => uploadImage(file.buffer, file.originalname, options)));
}

/**
 * Removes an asset. Failures are logged rather than thrown: an orphaned image
 * in Cloudinary is a housekeeping problem, but failing the product update the
 * admin actually asked for would be a real one.
 */
export async function deleteImage(publicId: string): Promise<boolean> {
  if (!publicId) return false;
  try {
    ensureConfigured();
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    return result.result === 'ok' || result.result === 'not found';
  } catch (err) {
    logger.warn(`[upload] failed to delete ${publicId}`, err);
    return false;
  }
}

export async function deleteImages(publicIds: string[]): Promise<void> {
  await Promise.all(publicIds.filter(Boolean).map((id) => deleteImage(id)));
}

/**
 * Signed direct-upload parameters.
 *
 * Lets the admin app upload straight to Cloudinary without a large multipart
 * body passing through this server. The signature is produced here, so the API
 * secret still never leaves the backend.
 */
export function createUploadSignature(folder?: string): {
  timestamp: number;
  signature: string;
  apiKey: string;
  cloudName: string;
  folder: string;
} {
  ensureConfigured();
  const timestamp = Math.floor(Date.now() / 1000);
  const targetFolder = folder ?? env.CLOUDINARY_UPLOAD_FOLDER;

  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder: targetFolder },
    env.CLOUDINARY_API_SECRET,
  );

  return {
    timestamp,
    signature,
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    folder: targetFolder,
  };
}

export const isUploadEnabled = (): boolean => cloudinaryConfigured;
