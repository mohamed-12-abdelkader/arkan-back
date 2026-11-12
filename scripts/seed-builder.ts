import pool from '../src/db/pool';

const slots = [
  ['وحدة المعالجة المركزية', 'cpu', true, false, 1, 1, false, 1],
  ['اللوحة الأم', 'motherboard', true, false, 1, 1, false, 2],
  ['وحدة معالجة الرسومات', 'gpu', false, false, 0, 1, true, 3],
  ['مزود الطاقة', 'psu', true, false, 1, 1, false, 4],
  ['حاوية الحاسوب', 'case', true, false, 1, 1, false, 5],
  ['ذاكرة الوصول العشوائي', 'ram', true, true, 1, 4, false, 6],
  ['مساحة التخزين', 'storage', true, true, 1, 4, false, 7],
  ['المبرد', 'cooler', false, false, 0, 1, true, 8],
] as const;

type Part = {
  sku: string;
  name: string;
  type: string;
  price: number;
  stock: number;
  description: string;
  specs: Record<string, string | number | boolean>;
};

const parts: Part[] = [
  {
    sku: 'BLD-CPU-R5-7600',
    name: 'AMD Ryzen 5 7600',
    type: 'cpu',
    price: 8499,
    stock: 12,
    description: 'معالج 6 أنوية لمنصة AM5',
    specs: { socket: 'AM5', tdp_w: 65, memory_type: 'DDR5', integrated_graphics: true },
  },
  {
    sku: 'BLD-CPU-I5-14400F',
    name: 'Intel Core i5-14400F',
    type: 'cpu',
    price: 9299,
    stock: 10,
    description: 'معالج 10 أنوية لمنصة LGA1700',
    specs: { socket: 'LGA1700', tdp_w: 148, memory_type: 'DDR5', integrated_graphics: false },
  },
  {
    sku: 'BLD-MB-B650',
    name: 'لوحة أم B650 ATX',
    type: 'motherboard',
    price: 6999,
    stock: 8,
    description: 'لوحة AM5 تدعم DDR5',
    specs: {
      socket: 'AM5',
      form_factor: 'ATX',
      ram_type: 'DDR5',
      ram_slots: 4,
      max_ram_gb: 128,
      m2_slots: 2,
    },
  },
  {
    sku: 'BLD-MB-B760',
    name: 'لوحة أم B760 ATX',
    type: 'motherboard',
    price: 6499,
    stock: 8,
    description: 'لوحة LGA1700 تدعم DDR5',
    specs: {
      socket: 'LGA1700',
      form_factor: 'ATX',
      ram_type: 'DDR5',
      ram_slots: 4,
      max_ram_gb: 128,
      m2_slots: 2,
    },
  },
  {
    sku: 'BLD-GPU-4060',
    name: 'NVIDIA GeForce RTX 4060 8GB',
    type: 'gpu',
    price: 16499,
    stock: 7,
    description: 'كارت شاشة 1080p و1440p',
    specs: { length_mm: 240, tdp_w: 115, recommended_psu_w: 550 },
  },
  {
    sku: 'BLD-GPU-3060',
    name: 'NVIDIA GeForce RTX 3060 12GB',
    type: 'gpu',
    price: 13999,
    stock: 6,
    description: 'كارت شاشة مناسب للتجميعات المتوسطة',
    specs: { length_mm: 242, tdp_w: 170, recommended_psu_w: 550 },
  },
  {
    sku: 'BLD-PSU-650',
    name: 'مزود طاقة 650W 80+ Bronze',
    type: 'psu',
    price: 2799,
    stock: 15,
    description: 'قدرة كافية لتجميعة بكارت متوسط',
    specs: { wattage: 650, efficiency: '80+ Bronze', modular: 'semi' },
  },
  {
    sku: 'BLD-PSU-750',
    name: 'مزود طاقة 750W 80+ Gold',
    type: 'psu',
    price: 4199,
    stock: 9,
    description: 'هامش قدرة أعلى للترقية',
    specs: { wattage: 750, efficiency: '80+ Gold', modular: 'full' },
  },
  {
    sku: 'BLD-CASE-ATX',
    name: 'كيس ATX Airflow',
    type: 'case',
    price: 2499,
    stock: 11,
    description: 'يستوعب لوحات ATX وكارت حتى 380 مم',
    specs: {
      motherboard_form_factors: 'ATX,mATX',
      max_gpu_length_mm: 380,
      max_cooler_height_mm: 170,
    },
  },
  {
    sku: 'BLD-CASE-GLASS',
    name: 'كيس زجاج جانبي RGB',
    type: 'case',
    price: 3299,
    stock: 8,
    description: 'كيس ATX بواجهة زجاجية',
    specs: {
      motherboard_form_factors: 'ATX,mATX',
      max_gpu_length_mm: 360,
      max_cooler_height_mm: 165,
    },
  },
  {
    sku: 'BLD-RAM-32',
    name: 'رام 32GB DDR5 6000',
    type: 'ram',
    price: 4599,
    stock: 14,
    description: 'قطعتان 16GB',
    specs: {
      capacity_gb: 32,
      ddr_generation: 'DDR5',
      speed_mhz: 6000,
      modules: 2,
      form_factor: 'DIMM',
    },
  },
  {
    sku: 'BLD-RAM-16',
    name: 'رام 16GB DDR5 5600',
    type: 'ram',
    price: 2499,
    stock: 18,
    description: 'قطعتان 8GB',
    specs: {
      capacity_gb: 16,
      ddr_generation: 'DDR5',
      speed_mhz: 5600,
      modules: 2,
      form_factor: 'DIMM',
    },
  },
  {
    sku: 'BLD-SSD-1TB',
    name: 'SSD NVMe 1TB',
    type: 'storage',
    price: 2899,
    stock: 20,
    description: 'تخزين سريع للويندوز والألعاب',
    specs: { capacity_gb: 1000, interface: 'NVMe', form_factor: 'M.2' },
  },
  {
    sku: 'BLD-SSD-512',
    name: 'SSD NVMe 512GB',
    type: 'storage',
    price: 1699,
    stock: 20,
    description: 'خيار اقتصادي للبداية',
    specs: { capacity_gb: 512, interface: 'NVMe', form_factor: 'M.2' },
  },
  {
    sku: 'BLD-COOL-AM5',
    name: 'مبرد هوائي AM5',
    type: 'cooler',
    price: 1499,
    stock: 13,
    description: 'ارتفاع 155 مم ويدعم AM5',
    specs: { type: 'air', supported_sockets: 'AM5,AM4', height_mm: 155 },
  },
  {
    sku: 'BLD-COOL-1700',
    name: 'مبرد هوائي LGA1700',
    type: 'cooler',
    price: 1599,
    stock: 13,
    description: 'ارتفاع 158 مم ويدعم LGA1700',
    specs: { type: 'air', supported_sockets: 'LGA1700,LGA1200', height_mm: 158 },
  },
];

async function main() {
  await pool.query(
    `INSERT INTO build_templates (name, slug, description, display_order)
     VALUES ('تجميعة مخصصة', 'custom-pc', 'اختار مكونات جهازك قطعة قطعة', 1)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
  );

  const template = await pool.query(`SELECT id FROM build_templates WHERE slug = 'custom-pc'`);
  const templateId = template.rows[0].id;

  for (const [name, type, required, multiple, min, max, skip, order] of slots) {
    const existing = await pool.query(
      `SELECT id FROM build_slots WHERE template_id = $1 AND component_type = $2`,
      [templateId, type],
    );
    if (existing.rowCount) {
      await pool.query(
        `UPDATE build_slots
         SET name = $1, is_required = $2, allow_multiple = $3, min_quantity = $4,
             max_quantity = $5, can_skip = $6, display_order = $7
         WHERE id = $8`,
        [name, required, multiple, min, max, skip, order, existing.rows[0].id],
      );
    } else {
      await pool.query(
        `INSERT INTO build_slots
          (template_id, name, component_type, is_required, allow_multiple, min_quantity, max_quantity, can_skip, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [templateId, name, type, required, multiple, min, max, skip, order],
      );
    }
  }

  for (const part of parts) {
    const slug = part.sku.toLowerCase();
    await pool.query(
      `INSERT INTO products
        (name, slug, sku, description, price, stock, status, is_active, component_type, specs, track_inventory)
       VALUES ($1,$2,$3,$4,$5,$6,'active',TRUE,$7,$8::jsonb,TRUE)
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         stock = EXCLUDED.stock,
         status = 'active',
         is_active = TRUE,
         component_type = EXCLUDED.component_type,
         specs = EXCLUDED.specs,
         updated_at = NOW()`,
      [
        part.name,
        slug,
        part.sku,
        part.description,
        part.price,
        part.stock,
        part.type,
        JSON.stringify(part.specs),
      ],
    );
  }

  const count = await pool.query(
    `SELECT component_type, COUNT(*)::int AS n
     FROM products WHERE sku LIKE 'BLD-%' AND is_active = TRUE
     GROUP BY component_type ORDER BY component_type`,
  );
  console.log('builder parts:', count.rows);
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
