import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { RECORD_STATUS, type RecordStatus } from '../config/constants';

export interface ICategory extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  image?: string;
  /** Lucide icon name rendered by the mobile app, e.g. `Cog`, `Disc`. */
  icon?: string;
  /** Hex accent used for the category tile background. */
  colorHex?: string;
  parent?: Types.ObjectId | null;
  sortOrder: number;
  isFeatured: boolean;
  status: RecordStatus;
  /** Denormalised counter refreshed when products are created/updated. */
  productCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<ICategory>(
  {
    name: { type: String, required: [true, 'Category name is required'], trim: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 1000 },
    image: { type: String, trim: true },
    icon: { type: String, trim: true, default: 'Wrench' },
    colorHex: { type: String, trim: true, default: '#1E3A8A' },
    parent: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    sortOrder: { type: Number, default: 0 },
    isFeatured: { type: Boolean, default: false, index: true },
    status: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE, index: true },
    productCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ status: 1, sortOrder: 1, name: 1 });
categorySchema.index({ name: 'text' });

export type ICategoryModel = Model<ICategory>;

export const Category =
  (mongoose.models.Category as ICategoryModel) ??
  mongoose.model<ICategory, ICategoryModel>('Category', categorySchema);
