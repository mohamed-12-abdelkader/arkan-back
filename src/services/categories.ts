import pool from '../db/pool';
import { HttpError } from '../utils';

export async function countCategoryChildren(categoryId: number) {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS c FROM categories WHERE parent_id = $1',
    [categoryId],
  );
  return Number(result.rows[0]?.c || 0);
}

export async function countCategoryProducts(categoryId: number) {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS c FROM products WHERE category_id = $1',
    [categoryId],
  );
  return Number(result.rows[0]?.c || 0);
}

/**
 * Products may only be assigned to leaf categories (no subcategories).
 * Example: Accessories > Keyboards — product goes on Keyboards, not Accessories.
 */
export async function assertLeafCategoryForProduct(categoryId: number | null | undefined) {
  if (categoryId == null) return;

  const category = await pool.query(`SELECT id, name FROM categories WHERE id = $1`, [categoryId]);
  if (!category.rowCount) {
    throw new HttpError(400, 'التصنيف غير موجود');
  }

  const children = await countCategoryChildren(categoryId);
  if (children > 0) {
    throw new HttpError(
      400,
      `لا يمكن إضافة منتج لتصنيف رئيسي فيه أصناف فرعية («${category.rows[0].name}»). اختر التصنيف الفرعي مثل: كيبوردات أو ماوسات تحت إكسسوارات.`,
    );
  }
}

/**
 * A parent category that already has products cannot gain subcategories
 * until those products are moved to leaf categories.
 */
export async function assertParentCanHaveSubcategory(parentId: number) {
  const parent = await pool.query(`SELECT id, name FROM categories WHERE id = $1`, [parentId]);
  if (!parent.rowCount) {
    throw new HttpError(400, 'التصنيف الأب غير موجود');
  }

  const products = await countCategoryProducts(parentId);
  if (products > 0) {
    throw new HttpError(
      400,
      `التصنيف «${parent.rows[0].name}» فيه منتجات. انقل المنتجات لأصناف فرعية أولاً قبل إضافة تصنيف فرعي.`,
    );
  }
}
