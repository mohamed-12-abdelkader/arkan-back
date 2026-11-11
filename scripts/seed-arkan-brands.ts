import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
  tls.setDefaultCACertificates([
    ...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]),
  ]);
}

import pool from '../src/db/pool';

const BRANDS: Array<{ name: string; slug: string; logoUrl: string }> = [
  {
    name: 'Kingston',
    slug: 'kingston',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/kingston.png.webp',
  },
  {
    name: 'Lenovo',
    slug: 'lenovo',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/lenovo.png.webp',
  },
  {
    name: 'NVIDIA',
    slug: 'nvidia',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/NVIDIA.png.webp',
  },
  {
    name: 'Samsung',
    slug: 'samsung',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/samsung.png.webp',
  },
  {
    name: 'AMD',
    slug: 'amd',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/AMD-Logo.png.webp',
  },
  {
    name: 'ASUS',
    slug: 'asus',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/asus.png.webp',
  },
  {
    name: 'Apple',
    slug: 'apple',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/apple.png.webp',
  },
  {
    name: 'Dell',
    slug: 'dell',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/dell.png.webp',
  },
  {
    name: 'Gigabyte',
    slug: 'gigabyte',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/gigabyte.png.webp',
  },
  {
    name: 'HP',
    slug: 'hp',
    logoUrl: 'https://arkantech.net/wp-content/uploads/2025/03/hp.png.webp',
  },
];

const uploadsDir = path.resolve(process.cwd(), 'uploads', 'brands');

async function downloadLogo(url: string, slug: string) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = `${Date.now()}-${slug}.webp`;
  const target = path.join(uploadsDir, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  return `/uploads/brands/${filename}`;
}

async function main() {
  const keepSlugs = BRANDS.map((b) => b.slug);

  // Remove brands that are not on arkantech.net (unlink products first)
  await pool.query(
    `UPDATE products
     SET brand_id = NULL
     WHERE brand_id IN (
       SELECT id FROM brands WHERE slug <> ALL($1::text[])
     )`,
    [keepSlugs],
  );
  const removed = await pool.query(
    `DELETE FROM brands WHERE slug <> ALL($1::text[]) RETURNING id, name, slug`,
    [keepSlugs],
  );
  console.log(
    'removed:',
    removed.rows.map((r) => r.slug).join(', ') || '(none)',
  );

  for (const brand of BRANDS) {
    const logo = await downloadLogo(brand.logoUrl, brand.slug);
    const existing = await pool.query(`SELECT id FROM brands WHERE slug = $1`, [brand.slug]);
    if (existing.rowCount) {
      await pool.query(
        `UPDATE brands
         SET name = $1, logo = $2, is_active = TRUE, updated_at = NOW()
         WHERE id = $3`,
        [brand.name, logo, existing.rows[0].id],
      );
      console.log('updated:', brand.slug);
    } else {
      await pool.query(
        `INSERT INTO brands (name, slug, logo, is_active)
         VALUES ($1, $2, $3, TRUE)`,
        [brand.name, brand.slug, logo],
      );
      console.log('created:', brand.slug);
    }
  }

  const list = await pool.query(
    `SELECT id, name, slug, logo, is_active FROM brands ORDER BY name`,
  );
  console.log('brands now:');
  for (const row of list.rows) {
    console.log(`- ${row.name} (${row.slug}) ${row.logo}`);
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
