import pool from '../src/db/pool';

type CategorySeed = {
  name: string;
  slug: string;
  description: string;
  image: string;
  featured: boolean;
  order: number;
};

type ProductSeed = {
  sku: string;
  name: string;
  slug: string;
  category: string;
  brand?: string;
  price: number;
  salePrice?: number;
  stock: number;
  image: string;
  featured?: boolean;
  description: string;
  short?: string;
};

const IMG = {
  keyboard: '/uploads/products/keyboard.webp',
  monitor: '/uploads/products/monitor.webp',
  headset: '/uploads/products/headset.webp',
};

const categories: CategorySeed[] = [
  {
    name: 'أجهزة PS',
    slug: 'ps',
    description: 'بلايستيشن وإكسسواراته',
    image: IMG.monitor,
    featured: true,
    order: 1,
  },
  {
    name: 'لابتوبات',
    slug: 'laptops',
    description: 'لابتوبات للألعاب والعمل',
    image: IMG.keyboard,
    featured: true,
    order: 2,
  },
  {
    name: 'تجميعات',
    slug: 'builds',
    description: 'تجميعات جاهزة حسب احتياجك',
    image: IMG.headset,
    featured: true,
    order: 3,
  },
  {
    name: 'شاشات',
    slug: 'monitors',
    description: 'شاشات جيمنج ومونيتورز',
    image: IMG.monitor,
    featured: false,
    order: 4,
  },
  {
    name: 'إكسسوارات',
    slug: 'accessories',
    description: 'كيبوردات وماوسات وأكثر',
    image: IMG.keyboard,
    featured: false,
    order: 5,
  },
];

const extraBrands = [
  { name: 'Sony', slug: 'sony' },
  { name: 'MSI', slug: 'msi' },
  { name: 'Logitech', slug: 'logitech' },
];

const products: ProductSeed[] = [
  {
    sku: 'ARK-PS5-SLIM',
    name: 'PlayStation 5 Slim',
    slug: 'playstation-5-slim',
    category: 'ps',
    brand: 'sony',
    price: 23999,
    salePrice: 21999,
    stock: 14,
    image: IMG.monitor,
    featured: true,
    description: 'جهاز PS5 Slim مع مشغّل أقراص ودعم الألعاب الحصرية.',
    short: 'الجهاز الأكثر مبيعاً',
  },
  {
    sku: 'ARK-DS-WHITE',
    name: 'DualSense Controller أبيض',
    slug: 'dualsense-white',
    category: 'ps',
    brand: 'sony',
    price: 1299,
    stock: 30,
    image: IMG.keyboard,
    description: 'يد تحكم رسمية مع اهتزاز تكيّفي.',
  },
  {
    sku: 'ARK-PS-PORTAL',
    name: 'PlayStation Portal',
    slug: 'playstation-portal',
    category: 'ps',
    brand: 'sony',
    price: 9999,
    salePrice: 8999,
    stock: 8,
    image: IMG.headset,
    featured: true,
    description: 'شاشّة محمولة للعب عن بعد على PS5.',
  },
  {
    sku: 'ARK-PULSE-ELITE',
    name: 'سماعة Pulse Elite',
    slug: 'pulse-elite',
    category: 'ps',
    brand: 'sony',
    price: 4499,
    stock: 12,
    image: IMG.headset,
    description: 'سماعة لاسلكية رسمية لجهاز بلايستيشن.',
  },
  {
    sku: 'ARK-DS-EDGE',
    name: 'DualSense Edge',
    slug: 'dualsense-edge',
    category: 'ps',
    brand: 'sony',
    price: 5999,
    stock: 6,
    image: IMG.keyboard,
    description: 'يد احترافية بأزرار قابلة للتخصيص.',
  },
  {
    sku: 'ARK-DS-DOCK',
    name: 'قاعدة شحن DualSense',
    slug: 'dualsense-charging-dock',
    category: 'ps',
    brand: 'sony',
    price: 799,
    stock: 20,
    image: IMG.monitor,
    description: 'اشحن يدّين في نفس الوقت.',
  },
  {
    sku: 'ARK-LAP-4060',
    name: 'لابتوب جيمنج RTX 4060',
    slug: 'gaming-laptop-rtx-4060',
    category: 'laptops',
    brand: 'asus',
    price: 31999,
    salePrice: 28999,
    stock: 7,
    image: IMG.keyboard,
    featured: true,
    description: 'لابتوب ألعاب بمعالج حديث وكارت RTX 4060.',
  },
  {
    sku: 'ARK-LAP-TUF15',
    name: 'لابتوب ASUS TUF 15',
    slug: 'asus-tuf-15',
    category: 'laptops',
    brand: 'asus',
    price: 32999,
    stock: 5,
    image: IMG.monitor,
    description: 'هيكل متين وشاشة 144Hz للألعاب.',
  },
  {
    sku: 'ARK-LAP-KATANA',
    name: 'لابتوب MSI Katana 15',
    slug: 'msi-katana-15',
    category: 'laptops',
    brand: 'msi',
    price: 37999,
    salePrice: 35999,
    stock: 4,
    image: IMG.headset,
    description: 'لابتوب ألعاب من MSI بشاشة عالية التردد.',
  },
  {
    sku: 'ARK-LAP-R7',
    name: 'لابتوب للعمل Ryzen 7',
    slug: 'work-laptop-ryzen-7',
    category: 'laptops',
    brand: 'lenovo',
    price: 24999,
    stock: 9,
    image: IMG.keyboard,
    description: 'لابتوب عمل بمعالج Ryzen 7 وبطارية طويلة.',
  },
  {
    sku: 'ARK-LAP-LEGION',
    name: 'لابتوب Lenovo Legion 5',
    slug: 'lenovo-legion-5',
    category: 'laptops',
    brand: 'lenovo',
    price: 38999,
    stock: 3,
    image: IMG.monitor,
    featured: true,
    description: 'تجربة ألعاب قوية مع تبريد محسّن.',
  },
  {
    sku: 'ARK-BLD-PRO',
    name: 'تجميعة أركان Pro RGB',
    slug: 'arkan-pro-rgb',
    category: 'builds',
    brand: 'amd',
    price: 20999,
    salePrice: 18999,
    stock: 6,
    image: IMG.headset,
    featured: true,
    description: 'تجميعة متوسطة مع إضاءة RGB جاهزة للألعاب.',
  },
  {
    sku: 'ARK-BLD-START',
    name: 'تجميعة أركان Starter',
    slug: 'arkan-starter',
    category: 'builds',
    price: 12999,
    stock: 10,
    image: IMG.keyboard,
    description: 'تجميعة اقتصادية للدراسة والاستخدام اليومي.',
  },
  {
    sku: 'ARK-BLD-ULTRA',
    name: 'تجميعة أركان Ultra 4070',
    slug: 'arkan-ultra-4070',
    category: 'builds',
    brand: 'nvidia',
    price: 45999,
    salePrice: 42999,
    stock: 3,
    image: IMG.monitor,
    featured: true,
    description: 'تجميعة عالية بمعالج قوي وكارت RTX 4070.',
  },
  {
    sku: 'ARK-BLD-STREAM',
    name: 'تجميعة بث وتعديل',
    slug: 'arkan-stream-edit',
    category: 'builds',
    price: 27999,
    stock: 5,
    image: IMG.headset,
    description: 'مخصصة للبث والمونتاج مع نوى كافية للمعالجة.',
  },
  {
    sku: 'ARK-BLD-SILENT',
    name: 'تجميعة مكتبية صامتة',
    slug: 'arkan-office-silent',
    category: 'builds',
    price: 15999,
    stock: 8,
    image: IMG.keyboard,
    description: 'جهاز مكتبي هادئ للعمل المكتبي.',
  },
  {
    sku: 'ARK-MON-MAJ27',
    name: 'شاشة Majesty Gaming 27 بوصة 210Hz',
    slug: 'majesty-27-210hz',
    category: 'monitors',
    price: 3999,
    salePrice: 3499,
    stock: 16,
    image: IMG.monitor,
    featured: true,
    description: 'شاشة IPS 2K بتردد 210Hz للألعاب.',
  },
  {
    sku: 'ARK-MON-2K',
    name: 'شاشة 2K للتحرير والألعاب',
    slug: 'monitor-2k-edit',
    category: 'monitors',
    brand: 'samsung',
    price: 4299,
    stock: 11,
    image: IMG.monitor,
    description: 'دقة QHD مناسبة للمونتاج واللعب.',
  },
  {
    sku: 'ARK-MON-32C',
    name: 'شاشة منحنية 32 بوصة 165Hz',
    slug: 'monitor-32-curved',
    category: 'monitors',
    brand: 'gigabyte',
    price: 5799,
    salePrice: 5199,
    stock: 7,
    image: IMG.headset,
    description: 'شاشة منحنية تغمرَك في اللعب.',
  },
  {
    sku: 'ARK-MON-24',
    name: 'شاشة مكتبية 24 بوصة IPS',
    slug: 'monitor-24-office',
    category: 'monitors',
    brand: 'hp',
    price: 2199,
    stock: 18,
    image: IMG.keyboard,
    description: 'شاشة مكتبية واضحة للعمل اليومي.',
  },
  {
    sku: 'ARK-MON-UW34',
    name: 'شاشة Ultrawide 34 بوصة',
    slug: 'monitor-ultrawide-34',
    category: 'monitors',
    brand: 'samsung',
    price: 8999,
    stock: 4,
    image: IMG.monitor,
    description: 'مساحة عرض واسعة للإنتاجية والألعاب.',
  },
  {
    sku: 'ARK-KB-XTGK',
    name: 'كيبورد ميكانيكي XT-GK 979',
    slug: 'xt-gk-979-keyboard',
    category: 'accessories',
    brand: 'logitech',
    price: 1199,
    salePrice: 899,
    stock: 22,
    image: IMG.keyboard,
    featured: true,
    description: 'كيبورد ميكانيكي بإضاءة RGB.',
  },
  {
    sku: 'ARK-HS-PRO',
    name: 'سماعة ألعاب احترافية',
    slug: 'pro-gaming-headset',
    category: 'accessories',
    price: 649,
    stock: 25,
    image: IMG.headset,
    description: 'سماعة مريحة مع مايك واضح للألعاب.',
  },
  {
    sku: 'ARK-MS-RGB',
    name: 'ماوس جيمنج RGB',
    slug: 'gaming-mouse-rgb',
    category: 'accessories',
    brand: 'logitech',
    price: 699,
    salePrice: 499,
    stock: 28,
    image: IMG.keyboard,
    description: 'ماوس خفيف مع حساس دقيق.',
  },
  {
    sku: 'ARK-PAD-XL',
    name: 'ماوس باد XL',
    slug: 'mousepad-xl',
    category: 'accessories',
    price: 299,
    stock: 40,
    image: IMG.monitor,
    description: 'سطح واسع وثابت للمكتب.',
  },
  {
    sku: 'ARK-CAM-FHD',
    name: 'كاميرا ويب Full HD',
    slug: 'webcam-full-hd',
    category: 'accessories',
    brand: 'logitech',
    price: 899,
    stock: 15,
    image: IMG.headset,
    description: 'كاميرا 1080p للاجتماعات والبث.',
  },
  {
    sku: 'ARK-MIC-USB',
    name: 'ميكروفون USB للبث',
    slug: 'usb-broadcast-mic',
    category: 'accessories',
    price: 1299,
    stock: 10,
    image: IMG.keyboard,
    description: 'ميكروفون USB جاهز للبودكاست والبث.',
  },
];

async function upsertCategory(cat: CategorySeed) {
  const existing = await pool.query(`SELECT id FROM categories WHERE slug = $1`, [cat.slug]);
  if (existing.rowCount) {
    await pool.query(
      `UPDATE categories
       SET name = $1, description = $2, image = $3, is_featured = $4,
           display_order = $5, is_active = TRUE, parent_id = NULL, updated_at = NOW()
       WHERE id = $6`,
      [cat.name, cat.description, cat.image, cat.featured, cat.order, existing.rows[0].id],
    );
    return existing.rows[0].id as number;
  }
  const inserted = await pool.query(
    `INSERT INTO categories (name, slug, description, image, is_featured, display_order, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE)
     RETURNING id`,
    [cat.name, cat.slug, cat.description, cat.image, cat.featured, cat.order],
  );
  return inserted.rows[0].id as number;
}

async function upsertBrand(name: string, slug: string) {
  const existing = await pool.query(`SELECT id FROM brands WHERE slug = $1`, [slug]);
  if (existing.rowCount) return existing.rows[0].id as number;
  const inserted = await pool.query(
    `INSERT INTO brands (name, slug, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
    [name, slug],
  );
  return inserted.rows[0].id as number;
}

async function upsertProduct(
  item: ProductSeed,
  categoryIds: Map<string, number>,
  brandIds: Map<string, number>,
) {
  const categoryId = categoryIds.get(item.category);
  const brandId = item.brand ? (brandIds.get(item.brand) ?? null) : null;
  const values = [
    item.name,
    item.slug,
    item.sku,
    item.description,
    item.short ?? null,
    item.price,
    item.salePrice ?? null,
    item.stock,
    item.image,
    categoryId,
    brandId,
    item.featured ?? false,
  ];

  const existing = await pool.query(`SELECT id FROM products WHERE sku = $1`, [item.sku]);
  let id: number;
  if (existing.rowCount) {
    id = existing.rows[0].id;
    await pool.query(
      `UPDATE products SET
         name = $1, slug = $2, description = $3, short_description = $4,
         price = $5, sale_price = $6, stock = $7, image = $8,
         category_id = $9, brand_id = $10, is_featured = $11,
         status = 'active', is_active = TRUE, component_type = NULL,
         track_inventory = TRUE, updated_at = NOW()
       WHERE id = $12`,
      [
        item.name,
        item.slug,
        item.description,
        item.short ?? null,
        item.price,
        item.salePrice ?? null,
        item.stock,
        item.image,
        categoryId,
        brandId,
        item.featured ?? false,
        id,
      ],
    );
  } else {
    const inserted = await pool.query(
      `INSERT INTO products
        (name, slug, sku, description, short_description, price, sale_price, stock, image,
         category_id, brand_id, is_featured, status, is_active, track_inventory)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',TRUE,TRUE)
       RETURNING id`,
      values,
    );
    id = inserted.rows[0].id;
  }

  await pool.query(`DELETE FROM product_images WHERE product_id = $1`, [id]);
  await pool.query(`INSERT INTO product_images (product_id, url, position) VALUES ($1,$2,0)`, [
    id,
    item.image,
  ]);
}

async function main() {
  const categoryIds = new Map<string, number>();
  for (const cat of categories) {
    categoryIds.set(cat.slug, await upsertCategory(cat));
  }

  const brandIds = new Map<string, number>();
  const listed = await pool.query(`SELECT id, slug FROM brands`);
  for (const row of listed.rows) brandIds.set(row.slug, row.id);
  for (const brand of extraBrands) {
    brandIds.set(brand.slug, await upsertBrand(brand.name, brand.slug));
  }

  for (const item of products) {
    await upsertProduct(item, categoryIds, brandIds);
  }

  await pool.query(
    `INSERT INTO coupons (code, type, value, min_order_amount, max_discount, is_active)
     VALUES ('ARKAN10', 'percentage', 10, 500, 1000, TRUE)
     ON CONFLICT (code) DO UPDATE SET
       type = EXCLUDED.type, value = EXCLUDED.value, is_active = TRUE`,
  );
  await pool.query(
    `INSERT INTO coupons (code, type, value, min_order_amount, is_active)
     VALUES ('WELCOME50', 'fixed', 50, 200, TRUE)
     ON CONFLICT (code) DO UPDATE SET
       type = EXCLUDED.type, value = EXCLUDED.value, is_active = TRUE`,
  );

  await pool.query(
    `INSERT INTO shipping_methods (name, code, description, base_rate, free_above, estimated_days_min, estimated_days_max, is_active)
     VALUES
       ('توصيل المدينة', 'madinah-delivery', 'توصيل داخل المدينة المنورة', 25, 500, 1, 2, TRUE),
       ('استلام من الفرع', 'pickup', 'استلم طلبك من فرع أركان', 0, NULL, 0, 1, TRUE)
     ON CONFLICT (code) DO UPDATE SET
       name = EXCLUDED.name, base_rate = EXCLUDED.base_rate, is_active = TRUE`,
  );

  const summary = await pool.query(
    `SELECT c.name, COUNT(p.id)::int AS products
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id AND p.is_active = TRUE
     WHERE c.parent_id IS NULL
     GROUP BY c.name, c.display_order
     ORDER BY c.display_order`,
  );
  console.log('catalog:', summary.rows);
  console.log('coupons: ARKAN10 (10%), WELCOME50 (50 SAR)');
  console.log('shipping: madinah-delivery, pickup');
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
