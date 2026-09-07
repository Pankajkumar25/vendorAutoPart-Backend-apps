import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';

/**
 * Aggregated search analytics that power "Popular searches" on the search
 * screen (spec sections 6, 30). One row per normalised term with a hit counter,
 * rather than one row per search event, keeps the collection tiny.
 */
export interface ISearchTerm extends Document {
  _id: Types.ObjectId;
  term: string;
  count: number;
  resultCount: number;
  lastSearchedAt: Date;
  /** Admin-curated terms are pinned above organically popular ones. */
  isPromoted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const searchTermSchema = new Schema<ISearchTerm>(
  {
    term: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
    count: { type: Number, default: 1, min: 0 },
    resultCount: { type: Number, default: 0, min: 0 },
    lastSearchedAt: { type: Date, default: Date.now },
    isPromoted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

searchTermSchema.index({ term: 1 }, { unique: true });
searchTermSchema.index({ isPromoted: -1, count: -1 });

export type ISearchTermModel = Model<ISearchTerm>;

export const SearchTerm =
  (mongoose.models.SearchTerm as ISearchTermModel) ??
  mongoose.model<ISearchTerm, ISearchTermModel>('SearchTerm', searchTermSchema);

/**
 * Per-user recent searches (kept server-side so the list follows the customer
 * across devices) and recently viewed products.
 */
export interface IUserActivity extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  recentSearches: { term: string; at: Date }[];
  recentlyViewed: { productId: Types.ObjectId; at: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

const userActivitySchema = new Schema<IUserActivity>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    recentSearches: {
      type: [new Schema({ term: String, at: { type: Date, default: Date.now } }, { _id: false })],
      default: [],
    },
    recentlyViewed: {
      type: [
        new Schema(
          { productId: { type: Schema.Types.ObjectId, ref: 'Product' }, at: { type: Date, default: Date.now } },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export const MAX_RECENT_SEARCHES = 12;
export const MAX_RECENTLY_VIEWED = 24;

export type IUserActivityModel = Model<IUserActivity>;

export const UserActivity =
  (mongoose.models.UserActivity as IUserActivityModel) ??
  mongoose.model<IUserActivity, IUserActivityModel>('UserActivity', userActivitySchema);
