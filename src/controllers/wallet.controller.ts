import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { ok } from '../utils/apiResponse';
import { ApiError } from '../utils/apiError';
import * as walletService from '../services/wallet.service';

export async function getWallet(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const balance = await walletService.getWalletBalance(auth.userId);
  ok(res, balance);
}

export async function getWalletTransactions(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const result = await walletService.getWalletTransactions(auth.userId, page, limit);
  ok(res, result);
}

export async function topupWallet(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const { amount, referenceId, referenceType, description, metadata } = req.body;
  if (!amount || amount <= 0) throw ApiError.badRequest('Amount is required and must be greater than zero');

  const result = await walletService.topupWallet({
    userId: auth.userId,
    amount,
    referenceId,
    referenceType,
    description,
    metadata,
    actorId: auth.userId,
  });
  ok(res, result, 'Wallet topped up successfully');
}

export async function adminAdjustWallet(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const { userId, amount, description, metadata } = req.body;
  if (!userId) throw ApiError.badRequest('User ID is required');
  if (amount === 0 || amount === undefined) throw ApiError.badRequest('Amount is required and cannot be zero');
  if (!description) throw ApiError.badRequest('Description is required for adjustments');

  const result = await walletService.adjustWallet({
    userId,
    amount,
    description,
    metadata,
    actorId: auth.userId,
  });
  ok(res, result, 'Wallet adjusted successfully');
}

export async function adminGetUserWallet(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const { userId } = req.params;
  const balance = await walletService.getWalletBalance(userId);
  ok(res, { userId, ...balance });
}