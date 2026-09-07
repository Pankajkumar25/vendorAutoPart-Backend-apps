/* eslint-disable no-console */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { env } from '../config/env';
import {
  COUPON_DISCOUNT_TYPE,
  PRODUCT_STATUS,
  RECORD_STATUS,
  ROLES,
  USER_STATUS,
} from '../config/constants';
import { Category } from '../models/category.model';
import { Product } from '../models/product.model';
import { User } from '../models/user.model';
import { UserProductPrice } from '../models/userProductPrice.model';
import { QuantityDiscountRule } from '../models/quantityDiscountRule.model';
import { Coupon } from '../models/coupon.model';
import { getSettings } from '../services/settings.service';
import { slugify } from '../utils/slug';

/**
 * Development seed (spec section 46).
 *
 * Populates a realistic, ORIGINAL spare-parts catalogue - no Bajaj branding,
 * logos or copied assets, only neutral fitment descriptors like "150cc
 * Commuter". Its second job is to make the headline business rules visible in
 * real data:
 *
 *   - RULE 18/19: three dealers each get a DIFFERENT negotiated price on the
 *     very same Brake Shoe Set, and none can see another's.
 *   - RULE 7:     a global quantity ladder (6+ / 12+ / 24+) so a buyer only ever
 *     gets the single highest qualifying tier, never the sum.
 *   - RULE 9/10:  an ONLINE-only percentage coupon (the domain forbids it on COD
 *     regardless of any flag).
 *
 * Money is stored in RUPEES throughout (the engine computes in paise); values
 * here are plain rupee numbers.
 *
 * Idempotent: entities are found-or-created by their natural key, so re-running
 * is safe. Pass `--fresh` to wipe the seeded collections first.
 */

const FRESH = process.argv.includes('--fresh');

// ---------------------------------------------------------------------------
// Catalogue definition
// ---------------------------------------------------------------------------

interface CategorySeed {
  key: string;
  name: string;
  icon: string;
  colorHex: string;
  description: string;
  isFeatured?: boolean;
}

const CATEGORIES: CategorySeed[] = [
  { key: 'braking', name: 'Braking System', icon: 'Disc', colorHex: '#B91C1C', description: 'Brake shoes, pads, discs, cables and hydraulic parts.', isFeatured: true },
  { key: 'engine', name: 'Engine Components', icon: 'Cog', colorHex: '#1E3A8A', description: 'Pistons, rings, gaskets, valves and cylinder kits.', isFeatured: true },
  { key: 'electrical', name: 'Electrical & Ignition', icon: 'Zap', colorHex: '#B45309', description: 'CDI units, coils, spark plugs, regulators and wiring.', isFeatured: true },
  { key: 'transmission', name: 'Transmission & Clutch', icon: 'Settings', colorHex: '#4338CA', description: 'Clutch plates, springs, sprockets and gear parts.' },
  { key: 'suspension', name: 'Suspension & Fork', icon: 'GitCommitVertical', colorHex: '#0F766E', description: 'Fork tubes, shock absorbers, bushes and oil seals.' },
  { key: 'filters', name: 'Filters', icon: 'Filter', colorHex: '#15803D', description: 'Air, oil and fuel filters for clean running.', isFeatured: true },
  { key: 'body', name: 'Body & Panels', icon: 'Car', colorHex: '#334155', description: 'Fairings, mudguards, side panels and fasteners.' },
  { key: 'lighting', name: 'Lighting', icon: 'Lightbulb', colorHex: '#CA8A04', description: 'Headlamps, indicators, tail lights and bulbs.' },
  { key: 'wheels', name: 'Wheels & Tyres', icon: 'CircleDot', colorHex: '#1F2937', description: 'Rims, spokes, tubes and tyre valves.' },
  { key: 'cables', name: 'Cables & Controls', icon: 'Cable', colorHex: '#7C2D12', description: 'Throttle, clutch and speedometer cables.' },
  { key: 'bearings', name: 'Bearings & Seals', icon: 'Circle', colorHex: '#475569', description: 'Wheel bearings, steering races and oil seals.' },
  { key: 'fuel', name: 'Fuel System', icon: 'Fuel', colorHex: '#9A3412', description: 'Carburettor kits, petcocks, jets and fuel pipes.' },
  { key: 'exhaust', name: 'Exhaust System', icon: 'Wind', colorHex: '#0C4A6E', description: 'Silencers, bends, gaskets and clamps.' },
  { key: 'lubricants', name: 'Lubricants & Oils', icon: 'Droplet', colorHex: '#166534', description: 'Engine oil, fork oil, grease and additives.' },
];

interface ProductSeed {
  categoryKey: string;
  name: string;
  sku: string;
  partNumber: string;
  brand: string;
  mrp: number;
  basePrice: number;
  stock: number;
  gstRate: number;
  weight: number; // grams
  compatibleModels: string[];
  isFeatured?: boolean;
  isBestSeller?: boolean;
}

// The Brake Shoe Set is the anchor for the custom-pricing demonstration.
const BRAKE_SHOE_SKU = 'BRK-SHOE-150';

const PRODUCTS: ProductSeed[] = [
  { categoryKey: 'braking', name: 'Brake Shoe Set (Rear Drum)', sku: BRAKE_SHOE_SKU, partNumber: 'BS150R', brand: 'TorqLine', mrp: 1250, basePrice: 1000, stock: 240, gstRate: 28, weight: 320, compatibleModels: ['150cc Commuter', '125cc Standard'], isFeatured: true, isBestSeller: true },
  { categoryKey: 'braking', name: 'Front Disc Brake Pad', sku: 'BRK-PAD-220', partNumber: 'BP220F', brand: 'TorqLine', mrp: 780, basePrice: 610, stock: 180, gstRate: 28, weight: 140, compatibleModels: ['220cc Sport'] },
  { categoryKey: 'braking', name: 'Brake Cable Assembly', sku: 'BRK-CBL-STD', partNumber: 'BC100', brand: 'MotoGrip', mrp: 190, basePrice: 132, stock: 500, gstRate: 18, weight: 90, compatibleModels: ['150cc Commuter', '110cc Economy'] },

  { categoryKey: 'engine', name: 'Piston & Ring Kit 150cc', sku: 'ENG-PRK-150', partNumber: 'PK150', brand: 'DuraFit', mrp: 1650, basePrice: 1290, stock: 120, gstRate: 28, weight: 410, compatibleModels: ['150cc Commuter'], isFeatured: true },
  { categoryKey: 'engine', name: 'Full Gasket Set', sku: 'ENG-GKT-150', partNumber: 'GS150', brand: 'DuraFit', mrp: 540, basePrice: 398, stock: 160, gstRate: 28, weight: 150, compatibleModels: ['150cc Commuter', '125cc Standard'] },
  { categoryKey: 'engine', name: 'Cylinder Head Valve Pair', sku: 'ENG-VLV-125', partNumber: 'VP125', brand: 'PulseTech', mrp: 470, basePrice: 355, stock: 140, gstRate: 28, weight: 80, compatibleModels: ['125cc Standard'] },

  { categoryKey: 'electrical', name: 'CDI Ignition Unit', sku: 'ELE-CDI-DC', partNumber: 'CDI12', brand: 'PulseTech', mrp: 990, basePrice: 745, stock: 90, gstRate: 18, weight: 110, compatibleModels: ['150cc Commuter', '220cc Sport'], isBestSeller: true },
  { categoryKey: 'electrical', name: 'Iridium Spark Plug', sku: 'ELE-SPK-IR', partNumber: 'SP7I', brand: 'PulseTech', mrp: 260, basePrice: 189, stock: 600, gstRate: 18, weight: 40, compatibleModels: ['150cc Commuter', '125cc Standard', '110cc Economy'], isFeatured: true },
  { categoryKey: 'electrical', name: 'Voltage Regulator Rectifier', sku: 'ELE-RRU-12', partNumber: 'RR12', brand: 'VoltEdge', mrp: 720, basePrice: 560, stock: 75, gstRate: 18, weight: 130, compatibleModels: ['220cc Sport'] },

  { categoryKey: 'transmission', name: 'Clutch Plate Friction Set', sku: 'TRN-CLP-STD', partNumber: 'CP150', brand: 'GripMax', mrp: 860, basePrice: 655, stock: 150, gstRate: 28, weight: 260, compatibleModels: ['150cc Commuter'], isFeatured: true },
  { categoryKey: 'transmission', name: 'Rear Sprocket 42T', sku: 'TRN-SPR-42', partNumber: 'SP42', brand: 'GripMax', mrp: 610, basePrice: 470, stock: 130, gstRate: 18, weight: 340, compatibleModels: ['150cc Commuter', '125cc Standard'] },

  { categoryKey: 'suspension', name: 'Front Fork Oil Seal Pair', sku: 'SUS-FOS-PR', partNumber: 'FS30', brand: 'RideSoft', mrp: 240, basePrice: 168, stock: 300, gstRate: 18, weight: 60, compatibleModels: ['150cc Commuter', '110cc Economy'] },
  { categoryKey: 'suspension', name: 'Rear Shock Absorber', sku: 'SUS-RSA-STD', partNumber: 'RSA150', brand: 'RideSoft', mrp: 1480, basePrice: 1150, stock: 70, gstRate: 18, weight: 720, compatibleModels: ['150cc Commuter'], isBestSeller: true },

  { categoryKey: 'filters', name: 'Air Filter Element', sku: 'FLT-AIR-150', partNumber: 'AF150', brand: 'PureFlow', mrp: 210, basePrice: 148, stock: 420, gstRate: 18, weight: 70, compatibleModels: ['150cc Commuter', '125cc Standard'], isFeatured: true },
  { categoryKey: 'filters', name: 'Oil Filter Cartridge', sku: 'FLT-OIL-STD', partNumber: 'OF10', brand: 'PureFlow', mrp: 160, basePrice: 110, stock: 480, gstRate: 18, weight: 55, compatibleModels: ['150cc Commuter', '220cc Sport'] },

  { categoryKey: 'body', name: 'Front Mudguard', sku: 'BDY-MDG-FR', partNumber: 'MG150F', brand: 'FormLine', mrp: 690, basePrice: 520, stock: 85, gstRate: 18, weight: 480, compatibleModels: ['150cc Commuter'] },
  { categoryKey: 'lighting', name: 'LED Headlamp Assembly', sku: 'LGT-HLP-LED', partNumber: 'HL12L', brand: 'LumenPro', mrp: 1320, basePrice: 1030, stock: 95, gstRate: 18, weight: 380, compatibleModels: ['150cc Commuter', '220cc Sport'], isFeatured: true },
  { categoryKey: 'lighting', name: 'Indicator Blinker Pair', sku: 'LGT-IND-PR', partNumber: 'IB4', brand: 'LumenPro', mrp: 320, basePrice: 232, stock: 260, gstRate: 18, weight: 90, compatibleModels: ['150cc Commuter', '125cc Standard'] },

  { categoryKey: 'wheels', name: 'Tube 90/90-18', sku: 'WHL-TUB-18', partNumber: 'TB18', brand: 'RollTrue', mrp: 300, basePrice: 214, stock: 340, gstRate: 28, weight: 520, compatibleModels: ['150cc Commuter'] },
  { categoryKey: 'cables', name: 'Throttle Cable', sku: 'CBL-THR-STD', partNumber: 'TC100', brand: 'MotoGrip', mrp: 170, basePrice: 118, stock: 400, gstRate: 18, weight: 70, compatibleModels: ['150cc Commuter', '110cc Economy'] },
  { categoryKey: 'bearings', name: 'Wheel Bearing Set 6301', sku: 'BRG-WHL-6301', partNumber: 'WB6301', brand: 'SpinCore', mrp: 280, basePrice: 205, stock: 380, gstRate: 18, weight: 120, compatibleModels: ['150cc Commuter', '125cc Standard', '220cc Sport'] },
  { categoryKey: 'fuel', name: 'Carburettor Repair Kit', sku: 'FUL-CRB-KIT', partNumber: 'CK150', brand: 'FlowJet', mrp: 560, basePrice: 430, stock: 110, gstRate: 18, weight: 95, compatibleModels: ['150cc Commuter'] },
  { categoryKey: 'exhaust', name: 'Silencer Gasket', sku: 'EXH-GKT-STD', partNumber: 'EG20', brand: 'HeatShield', mrp: 90, basePrice: 58, stock: 700, gstRate: 18, weight: 30, compatibleModels: ['150cc Commuter', '125cc Standard'] },
  { categoryKey: 'lubricants', name: 'Engine Oil 10W-30 (1L)', sku: 'LUB-EO-1030', partNumber: 'EO1030', brand: 'ProLube', mrp: 470, basePrice: 360, stock: 520, gstRate: 18, weight: 950, compatibleModels: ['150cc Commuter', '125cc Standard', '220cc Sport', '110cc Economy'], isBestSeller: true },
];

// Dealers who receive customer-specific pricing on the Brake Shoe Set.
const CUSTOMERS = [
  { name: 'Raj Traders', email: 'raj.traders@example.com', mobile: '9811100001', businessName: 'Raj Traders', customerGroup: 'Dealer - Tier 1', brakeShoePrice: 900 },
  { name: 'Sharma Auto Parts', email: 'sharma.auto@example.com', mobile: '9811100002', businessName: 'Sharma Auto Parts', customerGroup: 'Dealer - Tier 2', brakeShoePrice: 950 },
  { name: 'Kumar Motors', email: 'kumar.motors@example.com', mobile: '9811100003', businessName: 'Kumar Motors', customerGroup: 'Dealer - Tier 1', brakeShoePrice: 850 },
];

const CUSTOMER_PASSWORD = 'Customer@123';

// ---------------------------------------------------------------------------
// Seed steps
// ---------------------------------------------------------------------------

async function wipe(): Promise<void> {
  console.log('[seed] --fresh: clearing seeded collections');
  await Promise.all([
    Category.deleteMany({}),
    Product.deleteMany({}),
    UserProductPrice.deleteMany({}),
    QuantityDiscountRule.deleteMany({}),
    Coupon.deleteMany({}),
    // Only the seeded accounts, never real data that might exist.
    User.deleteMany({ email: { $in: [env.SEED_ADMIN_EMAIL, ...CUSTOMERS.map((c) => c.email)] } }),
  ]);
}

async function seedAdmin(): Promise<mongoose.Types.ObjectId> {
  let admin = await User.findOne({ email: env.SEED_ADMIN_EMAIL.toLowerCase() });
  if (!admin) {
    admin = await User.create({
      name: env.SEED_ADMIN_NAME,
      email: env.SEED_ADMIN_EMAIL,
      mobile: env.SEED_ADMIN_MOBILE,
      password: env.SEED_ADMIN_PASSWORD,
      role: ROLES.ADMIN,
      status: USER_STATUS.ACTIVE,
      permissions: [], // full admin
      emailVerifiedAt: new Date(),
      mobileVerifiedAt: new Date(),
    });
    console.log(`[seed] admin created: ${admin.email} / ${env.SEED_ADMIN_PASSWORD}`);
  } else {
    console.log(`[seed] admin already present: ${admin.email}`);
  }
  return admin._id;
}

async function seedCategories(createdBy: mongoose.Types.ObjectId): Promise<Map<string, mongoose.Types.ObjectId>> {
  const byKey = new Map<string, mongoose.Types.ObjectId>();
  let sortOrder = 0;
  for (const c of CATEGORIES) {
    sortOrder += 1;
    const slug = slugify(c.name);
    let cat = await Category.findOne({ slug });
    if (!cat) {
      cat = await Category.create({
        name: c.name,
        slug,
        description: c.description,
        icon: c.icon,
        colorHex: c.colorHex,
        sortOrder,
        isFeatured: c.isFeatured ?? false,
        status: RECORD_STATUS.ACTIVE,
      });
    }
    byKey.set(c.key, cat._id);
  }
  console.log(`[seed] categories ready: ${byKey.size}`);
  void createdBy;
  return byKey;
}

async function seedProducts(
  categoryIds: Map<string, mongoose.Types.ObjectId>,
  createdBy: mongoose.Types.ObjectId,
): Promise<Map<string, mongoose.Types.ObjectId>> {
  const bySku = new Map<string, mongoose.Types.ObjectId>();
  for (const p of PRODUCTS) {
    const categoryId = categoryIds.get(p.categoryKey);
    if (!categoryId) throw new Error(`Seed misconfigured: unknown category "${p.categoryKey}" for ${p.sku}`);

    let product = await Product.findOne({ sku: p.sku });
    if (!product) {
      product = await Product.create({
        name: p.name,
        slug: slugify(p.name),
        sku: p.sku,
        partNumber: p.partNumber,
        brand: p.brand,
        category: categoryId,
        images: [],
        shortDescription: `${p.brand} ${p.name} - fits ${p.compatibleModels.join(', ')}.`,
        description: `Genuine-fit replacement ${p.name.toLowerCase()} by ${p.brand}. Engineered for ${p.compatibleModels.join(', ')} motorcycles. Sold as a workshop-grade spare.`,
        mrp: p.mrp,
        basePrice: p.basePrice,
        stock: p.stock,
        gstRate: p.gstRate,
        weight: p.weight,
        hsnCode: '8714',
        unit: 'PCS',
        compatibleModels: p.compatibleModels,
        tags: [p.brand.toLowerCase(), p.categoryKey],
        status: PRODUCT_STATUS.ACTIVE,
        isFeatured: p.isFeatured ?? false,
        isBestSeller: p.isBestSeller ?? false,
        createdBy,
      });
    }
    bySku.set(p.sku, product._id);
  }
  console.log(`[seed] products ready: ${bySku.size}`);
  return bySku;
}

async function seedCustomersAndPricing(
  brakeShoeId: mongoose.Types.ObjectId,
  brakeShoeBasePrice: number,
  createdBy: mongoose.Types.ObjectId,
): Promise<void> {
  for (const c of CUSTOMERS) {
    let user = await User.findOne({ email: c.email });
    if (!user) {
      user = await User.create({
        name: c.name,
        email: c.email,
        mobile: c.mobile,
        password: CUSTOMER_PASSWORD,
        role: ROLES.USER,
        status: USER_STATUS.ACTIVE,
        businessName: c.businessName,
        customerGroup: c.customerGroup,
        emailVerifiedAt: new Date(),
        mobileVerifiedAt: new Date(),
      });
    }

    // RULE 18/19: a per-customer price on the SAME product. Upsert so a re-run
    // keeps the negotiated figure in sync without duplicating.
    await UserProductPrice.updateOne(
      { userId: user._id, productId: brakeShoeId },
      {
        $set: {
          customPrice: c.brakeShoePrice,
          basePriceAtAssignment: brakeShoeBasePrice,
          status: RECORD_STATUS.ACTIVE,
          note: `Negotiated rate for ${c.businessName}`,
          updatedBy: createdBy,
        },
        $setOnInsert: { createdBy },
      },
      { upsert: true },
    );
  }
  console.log(`[seed] customers ready: ${CUSTOMERS.length} (each with a distinct Brake Shoe price)`);
}

async function seedQuantityLadder(createdBy: mongoose.Types.ObjectId): Promise<void> {
  // RULE 7: a global ladder. At qty 12 a buyer gets 10% only - never 5%+10%.
  const tiers = [
    { minimumQuantity: 6, discountPercentage: 5, label: 'Buy 6+' },
    { minimumQuantity: 12, discountPercentage: 10, label: 'Buy 12+' },
    { minimumQuantity: 24, discountPercentage: 15, label: 'Buy 24+' },
  ];
  for (const t of tiers) {
    await QuantityDiscountRule.updateOne(
      { productId: null, categoryId: null, minimumQuantity: t.minimumQuantity },
      {
        $set: { discountPercentage: t.discountPercentage, label: t.label, status: RECORD_STATUS.ACTIVE },
        $setOnInsert: { createdBy },
      },
      { upsert: true },
    );
  }
  console.log(`[seed] global quantity ladder ready: ${tiers.map((t) => `${t.minimumQuantity}+→${t.discountPercentage}%`).join(', ')}`);
}

async function seedCoupon(createdBy: mongoose.Types.ObjectId): Promise<void> {
  // RULE 9/10: ONLINE-only by nature of the domain (no COD flag exists). This
  // 6% coupon matches the section 22 worked example (₹5,400 → −₹324).
  const code = 'SAVE6';
  const existing = await Coupon.findOne({ code });
  if (!existing) {
    await Coupon.create({
      code,
      title: 'Save 6% on your order',
      description: '6% off online orders above ₹1,000.',
      discountType: COUPON_DISCOUNT_TYPE.PERCENTAGE,
      discountPercentage: 6,
      discountAmount: 0,
      minOrderValue: 1000,
      maxDiscountAmount: null,
      isPublic: true,
      isActive: true,
      createdBy,
    });
    console.log('[seed] coupon ready: SAVE6 (6% online-only)');
  } else {
    console.log('[seed] coupon already present: SAVE6');
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  await connectDatabase();
  console.log(`[seed] connected to ${env.MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}`);

  if (FRESH) await wipe();

  // Materialise the settings singleton with its rule defaults.
  await getSettings(true);

  const adminId = await seedAdmin();
  const categoryIds = await seedCategories(adminId);
  const productIds = await seedProducts(categoryIds, adminId);

  const brakeShoeId = productIds.get(BRAKE_SHOE_SKU);
  if (!brakeShoeId) throw new Error('Seed misconfigured: Brake Shoe Set was not created');

  await seedCustomersAndPricing(brakeShoeId, 1000, adminId);
  await seedQuantityLadder(adminId);
  await seedCoupon(adminId);

  console.log('\n[seed] done.');
  console.log(`[seed]   Admin login:    ${env.SEED_ADMIN_EMAIL} / ${env.SEED_ADMIN_PASSWORD}`);
  console.log(`[seed]   Customer login: ${CUSTOMERS[0].email} / ${CUSTOMER_PASSWORD}`);
  console.log('[seed]   Brake Shoe Set base ₹1000 →  Raj ₹900 · Sharma ₹950 · Kumar ₹850');
}

run()
  .then(async () => {
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[seed] failed:', err);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
