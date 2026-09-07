import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { WALLET_TXN_TYPE, type WalletTxnType, WALLET_TXN_STATUS, type WalletTxnStatus } from '../config/constants';

export interface IWallet extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  balance: number;
  currency: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWalletTransaction extends Document {
  _id: Types.ObjectId;
  walletId: Types.ObjectId;
  userId: Types.ObjectId;
  type: WalletTxnType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  status: WalletTxnStatus;
  referenceType?: string | null;
  referenceId?: Types.ObjectId | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const walletSchema = new Schema<IWallet>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
    currency: { type: String, default: 'INR' },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const walletTransactionSchema = new Schema<IWalletTransaction>(
  {
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: Object.values(WALLET_TXN_TYPE), required: true },
    amount: { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    status: { type: String, enum: Object.values(WALLET_TXN_STATUS), default: WALLET_TXN_STATUS.PENDING, index: true },
    referenceType: { type: String, default: null },
    referenceId: { type: Schema.Types.ObjectId, default: null, index: true },
    description: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

walletTransactionSchema.index({ walletId: 1, createdAt: -1 });
walletTransactionSchema.index({ userId: 1, createdAt: -1 });

export type IWalletModel = Model<IWallet>;
export type IWalletTransactionModel = Model<IWalletTransaction>;

export const Wallet = (mongoose.models.Wallet as IWalletModel) ?? mongoose.model<IWallet, IWalletModel>('Wallet', walletSchema);
export const WalletTransaction = (mongoose.models.WalletTransaction as IWalletTransactionModel) ?? mongoose.model<IWalletTransaction, IWalletTransactionModel>('WalletTransaction', walletTransactionSchema);