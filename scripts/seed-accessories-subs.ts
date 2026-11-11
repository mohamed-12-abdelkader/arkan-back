import pool from '../src/db/pool';
import {
  assertLeafCategoryForProduct,
  assertParentCanHaveSubcategory,
} from '../src/services/categories';

async function main() {
  let parent = await pool.query(`SELECT id FROM categories WHERE slug = 'accessories' LIMIT 1`);
  if (!parent.rowCount) {
    parent = await pool.query(
      `INSERT INTO categories (name, slug, description, is_active, display_order)
       VALUES ('اكسسوارات', 'accessories', 'تصنيف رئيسي للإكسسوارات', TRUE, 50)
       RETURNING id`,
    );
  }
  const parentId = parent.rows[0].id;

  const kids: Array<[string, string, number]> = [
    ['كيبوردات', 'keyboards', 1],
    ['ماوسات', 'mice', 2],
    ['كراسي', 'chairs', 3],
  ];

  for (const [name, slug, order] of kids) {
    const exists = await pool.query(`SELECT id FROM categories WHERE slug = $1`, [slug]);
    if (!exists.rowCount) {
      await pool.query(
        `INSERT INTO categories (name, slug, parent_id, is_active, display_order)
         VALUES ($1, $2, $3, TRUE, $4)`,
        [name, slug, parentId, order],
      );
    } else {
      await pool.query(
        `UPDATE categories
         SET parent_id = $1, name = $2, is_active = TRUE, display_order = $3
         WHERE id = $4`,
        [parentId, name, order, exists.rows[0].id],
      );
    }
  }

  try {
    await assertLeafCategoryForProduct(parentId);
    throw new Error('expected parent category to reject products');
  } catch (error: any) {
    console.log('parent_blocked:', error.message);
  }

  try {
    await assertParentCanHaveSubcategory(parentId);
    console.log('parent_can_add_more_subs: ok (no direct products)');
  } catch (error: any) {
    console.log('parent_sub_blocked:', error.message);
  }

  const keyboard = await pool.query(`SELECT id FROM categories WHERE slug = 'keyboards'`);
  await assertLeafCategoryForProduct(keyboard.rows[0].id);
  console.log('keyboard_accepts_products:', keyboard.rows[0].id);

  const detail = await fetch('http://localhost:8000/api/v1/categories/accessories').then((r) =>
    r.json(),
  );
  console.log(
    'api_children:',
    detail.data.children.map((c: { name: string }) => c.name).join(', '),
  );
  console.log('api_accepts_products:', detail.data.accepts_products);

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
