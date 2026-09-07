import type { Types } from 'mongoose';
import type { Permission, Role } from '../config/constants';

/**
 * Request augmentation. `req.auth` is populated only by the auth middleware -
 * never from the request body - which is what makes RULE 6 of the security
 * section ("never trust the frontend user role") enforceable.
 */
export interface AuthContext {
  userId: Types.ObjectId;
  role: Role;
  permissions: Permission[];
  isFullAdmin: boolean;
  tokenVersion: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** Populated by multer for image uploads. */
      file?: {
        buffer: Buffer;
        originalname: string;
        mimetype: string;
        size: number;
      };
      files?: {
        buffer: Buffer;
        originalname: string;
        mimetype: string;
        size: number;
      }[];
      /** Raw body captured for gateway webhook signature verification. */
      rawBody?: string;
      requestId?: string;
    }
  }
}

export {};
