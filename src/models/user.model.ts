import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import {
  PERMISSIONS,
  ROLES,
  USER_STATUS,
  type Permission,
  type Role,
  type UserStatus,
} from '../config/constants';

export interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  mobile: string;
  password: string;
  role: Role;
  status: UserStatus;
  permissions: Permission[];
  businessName?: string;
  gstNumber?: string;
  /** Free-text label admins use to group customers, e.g. "Dealer - Tier 1". */
  customerGroup?: string;
  notes?: string;
  /**
   * Incremented whenever the account is disabled, its role changes or the
   * password is reset. Access tokens carrying an older value are rejected, so
   * a disabled user loses access immediately instead of at token expiry.
   */
  tokenVersion: number;
  lastLoginAt?: Date;
  emailVerifiedAt?: Date;
  mobileVerifiedAt?: Date;
  pushTokens: string[];
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;

  comparePassword(candidate: string): Promise<boolean>;
  isFullAdmin(): boolean;
  can(permission: Permission): boolean;
}

export interface IUserModel extends Model<IUser> {}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      maxlength: 200,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please provide a valid email address'],
    },
    mobile: {
      type: String,
      required: [true, 'Mobile number is required'],
      trim: true,
      match: [/^[6-9]\d{9}$/, 'Please provide a valid 10 digit Indian mobile number'],
    },
    // `select: false` keeps the hash out of every ordinary query result; the
    // login path opts back in explicitly with `.select('+password')`.
    password: { type: String, required: true, select: false, minlength: 8 },
    role: { type: String, enum: Object.values(ROLES), default: ROLES.USER, index: true },
    status: { type: String, enum: Object.values(USER_STATUS), default: USER_STATUS.ACTIVE, index: true },
    permissions: { type: [{ type: String, enum: PERMISSIONS }], default: [] },
    businessName: { type: String, trim: true, maxlength: 160 },
    gstNumber: { type: String, trim: true, uppercase: true, maxlength: 20 },
    customerGroup: { type: String, trim: true, maxlength: 60 },
    notes: { type: String, trim: true, maxlength: 2000 },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
    emailVerifiedAt: { type: Date },
    mobileVerifiedAt: { type: Date },
    pushTokens: { type: [String], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ mobile: 1 }, { unique: true });
userSchema.index({ name: 'text', email: 'text', mobile: 'text', businessName: 'text' });
userSchema.index({ createdAt: -1 });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, env.BCRYPT_SALT_ROUNDS);
  return next();
});

/** Any change that should invalidate existing sessions bumps tokenVersion. */
userSchema.pre('save', function bumpTokenVersion(next) {
  if (this.isNew) return next();
  if (this.isModified('password') || this.isModified('role') || this.isModified('status')) {
    this.tokenVersion += 1;
  }
  return next();
});

userSchema.methods.comparePassword = function comparePassword(candidate: string): Promise<boolean> {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

/** An ADMIN with no explicit permission list has every capability. */
userSchema.methods.isFullAdmin = function isFullAdmin(): boolean {
  return this.role === ROLES.ADMIN && (!this.permissions || this.permissions.length === 0);
};

userSchema.methods.can = function can(permission: Permission): boolean {
  if (this.role !== ROLES.ADMIN) return false;
  if (!this.permissions || this.permissions.length === 0) return true;
  return this.permissions.includes(permission);
};

export const User = (mongoose.models.User as IUserModel) ?? mongoose.model<IUser, IUserModel>('User', userSchema);
