import mongoose, { Types } from 'mongoose';
import { Wallet, WalletTransaction, type IWallet, type IWalletTransaction } from '../models/wallet.model';
import { WALLET_TXN_TYPE, WALLET_TXN_STATUS } from '../config/constants';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import { money } from '../utils/money';
import { logger } from '../config/logger';

export interface TopupInput {
  userId: string | Types.ObjectId;
  amount: number;
  referenceId?: string | Types.ObjectId;
  referenceType?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  actorId?: string | Types.ObjectId;
}

export interface PaymentInput {
  userId: string | Types.ObjectId;
  amount: number;
  orderId: string | Types.ObjectId;
  description?: string;
  actorId?: string | Types.ObjectId;
}

export interface RefundInput {
  userId: string | Types.ObjectId;
  amount: number;
  orderId: string | Types.ObjectId;
  paymentId: string | Types.ObjectId;
  description?: string;
  actorId?: string | Types.ObjectId;
}

export interface AdjustmentInput {
  userId: string | Types.ObjectId;
  amount: number;
  description: string;
  metadata?: Record<string, unknown>;
  actorId?: string | Types.ObjectId;
}

export interface WalletBalance {
  balance: number;
  currency: string;
}

function toId(value: string | Types.ObjectId): Types.ObjectId {
  return value instanceof Types.ObjectId ? value : new Types.ObjectId(value);
}

async function getOrCreateWallet(userId: string | Types.ObjectId, session?: mongoose.ClientSession): Promise<IWallet> {
  const id = toId(userId);
  let wallet = await Wallet.findOne({ userId: id }).session(session ?? null);
  if (!wallet) {
    const created = await Wallet.create([{ userId: id, balance: 0, currency: 'INR', version: 0 }], { session });
    wallet = created[0];
  }
  return wallet;
}

export async function getWalletBalance(userId: string | Types.ObjectId): Promise<WalletBalance> {
  const wallet = await getOrCreateWallet(userId);
  return { balance: wallet.balance, currency: wallet.currency };
}

export async function topupWallet(input: TopupInput): Promise<{ wallet: IWallet; transaction: IWalletTransaction }> {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const wallet = await getOrCreateWallet(input.userId, session);
    const amount = money(input.amount);
    if (amount <= 0) throw ApiError.badRequest('Top-up amount must be greater than zero');

    const balanceBefore = wallet.balance;
    wallet.balance = money(balanceBefore + amount);
    wallet.version += 1;
    await wallet.save({ session });

    const transaction = await WalletTransaction.create([{
      walletId: wallet._id,
      userId: toId(input.userId),
      type: WALLET_TXN_TYPE.TOPUP,
      amount,
      balanceBefore,
      balanceAfter: wallet.balance,
      status: WALLET_TXN_STATUS.COMPLETED,
      referenceType: input.referenceType,
      referenceId: input.referenceId ? toId(input.referenceId) : null,
      description: input.description ?? `Wallet top-up of ₹${amount}`,
      metadata: input.metadata ?? {},
    }], { session });

    await session.commitTransaction();
    logger.info(`[wallet] top-up ₹${amount} for user ${input.userId}, new balance ₹${wallet.balance}`);
    return { wallet, transaction: transaction[0] };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function payFromWallet(input: PaymentInput): Promise<{ wallet: IWallet; transaction: IWalletTransaction }> {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const wallet = await getOrCreateWallet(input.userId, session);
    const amount = money(input.amount);
    if (amount <= 0) throw ApiError.badRequest('Payment amount must be greater than zero');
    if (wallet.balance < amount) {
      throw ApiError.badRequest('Insufficient wallet balance', ERROR_CODES.INSUFFICIENT_WALLET_BALANCE);
    }

    const balanceBefore = wallet.balance;
    wallet.balance = money(balanceBefore - amount);
    wallet.version += 1;
    await wallet.save({ session });

    const transaction = await WalletTransaction.create([{
      walletId: wallet._id,
      userId: toId(input.userId),
      type: WALLET_TXN_TYPE.PAYMENT,
      amount: -amount,
      balanceBefore,
      balanceAfter: wallet.balance,
      status: WALLET_TXN_STATUS.COMPLETED,
      referenceType: 'ORDER',
      referenceId: toId(input.orderId),
      description: input.description ?? `Payment for order`,
      metadata: { orderId: String(input.orderId) },
    }], { session });

    await session.commitTransaction();
    logger.info(`[wallet] payment ₹${amount} from user ${input.userId}, new balance ₹${wallet.balance}`);
    return { wallet, transaction: transaction[0] };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function refundToWallet(input: RefundInput): Promise<{ wallet: IWallet; transaction: IWalletTransaction }> {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const wallet = await getOrCreateWallet(input.userId, session);
    const amount = money(input.amount);
    if (amount <= 0) throw ApiError.badRequest('Refund amount must be greater than zero');

    const balanceBefore = wallet.balance;
    wallet.balance = money(balanceBefore + amount);
    wallet.version += 1;
    await wallet.save({ session });

    const transaction = await WalletTransaction.create([{
      walletId: wallet._id,
      userId: toId(input.userId),
      type: WALLET_TXN_TYPE.REFUND,
      amount,
      balanceBefore,
      balanceAfter: wallet.balance,
      status: WALLET_TXN_STATUS.COMPLETED,
      referenceType: 'ORDER',
      referenceId: toId(input.orderId),
      description: input.description ?? `Refund for order`,
      metadata: { orderId: String(input.orderId), paymentId: String(input.paymentId) },
    }], { session });

    await session.commitTransaction();
    logger.info(`[wallet] refund ₹${amount} to user ${input.userId}, new balance ₹${wallet.balance}`);
    return { wallet, transaction: transaction[0] };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function adjustWallet(input: AdjustmentInput): Promise<{ wallet: IWallet; transaction: IWalletTransaction }> {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const wallet = await getOrCreateWallet(input.userId, session);
    const amount = money(input.amount);
    if (amount === 0) throw ApiError.badRequest('Adjustment amount cannot be zero');

    const balanceBefore = wallet.balance;
    const balanceAfter = money(balanceBefore + amount);
    if (balanceAfter < 0) {
      throw ApiError.badRequest('Adjustment would result in negative balance', ERROR_CODES.INSUFFICIENT_WALLET_BALANCE);
    }

    wallet.balance = balanceAfter;
    wallet.version += 1;
    await wallet.save({ session });

    const type = amount > 0 ? WALLET_TXN_TYPE.ADJUSTMENT : WALLET_TXN_TYPE.ADJUSTMENT;
    const transaction = await WalletTransaction.create([{
      walletId: wallet._id,
      userId: toId(input.userId),
      type,
      amount,
      balanceBefore,
      balanceAfter: wallet.balance,
      status: WALLET_TXN_STATUS.COMPLETED,
      referenceType: 'ADJUSTMENT',
      referenceId: null,
      description: input.description,
      metadata: input.metadata ?? {},
    }], { session });

    await session.commitTransaction();
    logger.info(`[wallet] adjustment ₹${amount} for user ${input.userId}, new balance ₹${wallet.balance}`);
    return { wallet, transaction: transaction[0] };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function getWalletTransactions(
  userId: string | Types.ObjectId,
  page = 1,
  limit = 20,
): Promise<{ transactions: (mongoose.FlattenMaps<IWalletTransaction> & { _id: mongoose.Types.ObjectId })[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const id = toId(userId);
  const [transactions, total] = await Promise.all([
    WalletTransaction.find({ userId: id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    WalletTransaction.countDocuments({ userId: id }),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function ensureWalletBalance(userId: string | Types.ObjectId, requiredAmount: number): Promise<boolean> {
  const wallet = await getOrCreateWallet(userId);
  return wallet.balance >= money(requiredAmount);
}