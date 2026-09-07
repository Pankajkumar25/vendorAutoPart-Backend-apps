import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { ADDRESS_TYPES, type AddressType } from '../config/constants';

export interface IGeoPoint {
  type: 'Point';
  /** GeoJSON order: [longitude, latitude]. */
  coordinates: [number, number];
}

export interface IAddress extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  fullName: string;
  mobile: string;
  alternateMobile?: string;
  houseNumber: string;
  street?: string;
  area: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  latitude?: number | null;
  longitude?: number | null;
  location?: IGeoPoint | null;
  addressType: AddressType;
  label?: string;
  isDefault: boolean;
  /** How the coordinates were obtained; useful for delivery-quality reporting. */
  locationSource?: 'GPS' | 'MAP_PICK' | 'MANUAL' | 'NONE';
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;

  readonly formatted: string;
}

const geoPointSchema = new Schema<IGeoPoint>(
  {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number] },
  },
  { _id: false },
);

const addressSchema = new Schema<IAddress>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fullName: { type: String, required: [true, 'Full name is required'], trim: true, maxlength: 120 },
    mobile: {
      type: String,
      required: [true, 'Mobile number is required'],
      trim: true,
      match: [/^[6-9]\d{9}$/, 'Please provide a valid 10 digit mobile number'],
    },
    alternateMobile: { type: String, trim: true, match: [/^[6-9]\d{9}$/, 'Invalid alternate mobile number'] },
    houseNumber: { type: String, required: [true, 'House/shop number is required'], trim: true, maxlength: 120 },
    street: { type: String, trim: true, maxlength: 200 },
    area: { type: String, required: [true, 'Area is required'], trim: true, maxlength: 200 },
    landmark: { type: String, trim: true, maxlength: 200 },
    city: { type: String, required: [true, 'City is required'], trim: true, maxlength: 120 },
    state: { type: String, required: [true, 'State is required'], trim: true, maxlength: 120 },
    pincode: {
      type: String,
      required: [true, 'Pincode is required'],
      trim: true,
      match: [/^[1-9]\d{5}$/, 'Please provide a valid 6 digit pincode'],
    },
    country: { type: String, default: 'India', trim: true },
    latitude: { type: Number, min: -90, max: 90, default: null },
    longitude: { type: Number, min: -180, max: 180, default: null },
    location: { type: geoPointSchema, default: null },
    addressType: { type: String, enum: Object.values(ADDRESS_TYPES), default: ADDRESS_TYPES.SHOP },
    label: { type: String, trim: true, maxlength: 60 },
    isDefault: { type: Boolean, default: false },
    locationSource: { type: String, enum: ['GPS', 'MAP_PICK', 'MANUAL', 'NONE'], default: 'NONE' },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

addressSchema.index({ userId: 1, isDeleted: 1, isDefault: -1, updatedAt: -1 });
addressSchema.index({ location: '2dsphere' }, { sparse: true });

/** Keeps the GeoJSON mirror in sync with the flat lat/lng the app sends. */
addressSchema.pre('save', function syncLocation(next) {
  if (typeof this.latitude === 'number' && typeof this.longitude === 'number') {
    this.location = { type: 'Point', coordinates: [this.longitude, this.latitude] };
  } else {
    this.location = null;
  }
  return next();
});

addressSchema.virtual('formatted').get(function formatted(this: IAddress): string {
  return [this.houseNumber, this.street, this.area, this.landmark, `${this.city} - ${this.pincode}`, this.state]
    .filter(Boolean)
    .join(', ');
});

export type IAddressModel = Model<IAddress>;

export const Address =
  (mongoose.models.Address as IAddressModel) ??
  mongoose.model<IAddress, IAddressModel>('Address', addressSchema);
