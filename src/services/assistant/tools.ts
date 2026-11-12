import pool from '../../db/pool';
import { effectiveProductPrice, toMoney, addMoney } from '../../shared/money';
import { checkBuildCompatibility } from '../../modules/compatibility/engine';
import { config } from '../../utils';

export type AssistantProductCard = {
  id: number;
  name: string;
  slug: string;
  price: string;
  effective_price: string;
  image: string | null;
  brand_name: string | null;
  category_name: string | null;
  available_stock: number;
  href: string;
  short_specs?: string;
};

function mapProduct(row: any): AssistantProductCard {
  const available = Math.max(0, Number(row.stock || 0) - Number(row.reserved_stock || 0));
  const specs = row.specs && typeof row.specs === 'object' ? row.specs : {};
  const short = Object.entries(specs)
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    price: toMoney(row.price),
    effective_price: effectiveProductPrice(row),
    image: row.image || null,
    brand_name: row.brand_name || null,
    category_name: row.category_name || null,
    available_stock: available,
    href: `/products/${row.slug || row.id}`,
    short_specs: short || undefined,
  };
}

export const assistantToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'search_products',
      description:
        'Search store products by text/category/budget. Excludes PC builder component parts.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          category_slug: { type: 'string' },
          max_price: { type: 'number' },
          min_price: { type: 'number' },
          limit: { type: 'number' },
          include_components: {
            type: 'boolean',
            description: 'Include PC builder parts (GPU/CPU/...). Default true.',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_product_details',
      description: 'Get one product by id or slug with real price and stock.',
      parameters: {
        type: 'object',
        properties: {
          id_or_slug: { type: 'string' },
        },
        required: ['id_or_slug'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'compare_products',
      description: 'Compare two products by id or slug.',
      parameters: {
        type: 'object',
        properties: {
          left: { type: 'string' },
          right: { type: 'string' },
        },
        required: ['left', 'right'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_categories',
      description: 'List active categories and subcategories.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'recommend_build',
      description:
        'Recommend a compatible PC build from real builder components within a budget and usage profile.',
      parameters: {
        type: 'object',
        properties: {
          budget: { type: 'number' },
          usage: {
            type: 'string',
            enum: ['gaming', 'editing', 'programming', 'office', 'mixed'],
          },
          include_monitor: { type: 'boolean' },
        },
        required: ['budget', 'usage'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_store_policies',
      description: 'Get shipping/warranty/store policy text from settings when available.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

async function findProduct(idOrSlug: string) {
  const result = await pool.query(
    `SELECT p.*, b.name AS brand_name, c.name AS category_name
     FROM products p
     LEFT JOIN brands b ON b.id = p.brand_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE (p.id::text = $1 OR p.slug = $1)
       AND p.status = 'active' AND p.is_active = TRUE
     LIMIT 1`,
    [idOrSlug],
  );
  return result.rows[0] || null;
}

export async function runAssistantTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; cards?: AssistantProductCard[]; buildPlan?: any }> {
  switch (name) {
    case 'search_products': {
      const q = String(args.q || '').trim();
      const limit = Math.min(Number(args.limit || 6), 12);
      const values: unknown[] = [];
      const includeComponents = args.include_components !== false;
      const where = [`p.status = 'active'`, `p.is_active = TRUE`];
      // Default: search storefront products AND builder parts (GPUs, CPUs, etc.)
      if (!includeComponents) {
        where.push(`p.component_type IS NULL`);
      }
      let i = 1;
      if (q) {
        where.push(
          `(p.name ILIKE $${i} OR p.sku ILIKE $${i} OR COALESCE(p.search_keywords,'') ILIKE $${i} OR COALESCE(p.description,'') ILIKE $${i} OR COALESCE(p.component_type,'') ILIKE $${i})`,
        );
        values.push(`%${q}%`);
        i++;
      }
      if (args.category_slug) {
        where.push(
          `p.category_id IN (
             WITH RECURSIVE tree AS (
               SELECT id FROM categories WHERE slug = $${i}
               UNION ALL
               SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
             ) SELECT id FROM tree
           )`,
        );
        values.push(String(args.category_slug));
        i++;
      }
      if (args.min_price != null) {
        where.push(`p.price >= $${i++}`);
        values.push(Number(args.min_price));
      }
      if (args.max_price != null) {
        where.push(`p.price <= $${i++}`);
        values.push(Number(args.max_price));
      }
      values.push(limit);
      const rows = await pool.query(
        `SELECT p.*, b.name AS brand_name, c.name AS category_name
         FROM products p
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${where.join(' AND ')}
         ORDER BY p.is_featured DESC, p.created_at DESC
         LIMIT $${i}`,
        values,
      );
      const cards = rows.rows.map(mapProduct);
      return {
        result: {
          count: cards.length,
          products: cards.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
            effective_price: c.effective_price,
            available_stock: c.available_stock,
            brand_name: c.brand_name,
            category_name: c.category_name,
            href: c.href,
            short_specs: c.short_specs,
          })),
        },
        cards,
      };
    }
    case 'get_product_details': {
      const row = await findProduct(String(args.id_or_slug || ''));
      if (!row) return { result: { found: false } };
      const card = mapProduct(row);
      return {
        result: {
          found: true,
          product: {
            ...card,
            description: row.description,
            specs: row.specs,
            component_type: row.component_type,
          },
        },
        cards: [card],
      };
    }
    case 'compare_products': {
      const left = await findProduct(String(args.left || ''));
      const right = await findProduct(String(args.right || ''));
      if (!left || !right) return { result: { found: false } };
      const cards = [mapProduct(left), mapProduct(right)];
      return {
        result: {
          left: { ...cards[0], specs: left.specs, description: left.description },
          right: { ...cards[1], specs: right.specs, description: right.description },
        },
        cards,
      };
    }
    case 'get_categories': {
      const rows = await pool.query(
        `SELECT id, name, slug, parent_id,
                (SELECT COUNT(*)::int FROM categories ch WHERE ch.parent_id = c.id AND ch.is_active) AS children_count
         FROM categories c
         WHERE c.is_active = TRUE
         ORDER BY display_order, name`,
      );
      return {
        result: {
          categories: rows.rows.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
            parent_id: c.parent_id,
            is_leaf: Number(c.children_count) === 0,
          })),
        },
      };
    }
    case 'recommend_build': {
      const budget = Number(args.budget || 0);
      const usage = String(args.usage || 'gaming');
      if (!budget || budget <= 0) {
        return { result: { ok: false, message: 'budget_required' } };
      }

      const template = await pool.query(
        `SELECT id FROM build_templates WHERE slug = 'custom-pc' AND is_active = TRUE LIMIT 1`,
      );
      if (!template.rowCount) return { result: { ok: false, message: 'no_template' } };

      const slots = await pool.query(
        `SELECT id, name, component_type, is_required, display_order, max_quantity
         FROM build_slots WHERE template_id = $1 ORDER BY display_order`,
        [template.rows[0].id],
      );
      const parts = await pool.query(
        `SELECT p.*, b.name AS brand_name, c.name AS category_name
         FROM products p
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.status = 'active' AND p.is_active = TRUE
           AND p.component_type IS NOT NULL
           AND (p.stock - COALESCE(p.reserved_stock, 0)) > 0
         ORDER BY p.price ASC`,
      );

      const byType = new Map<string, any[]>();
      for (const p of parts.rows) {
        const list = byType.get(p.component_type) || [];
        list.push(p);
        byType.set(p.component_type, list);
      }

      // Prefer stronger GPU/CPU when usage is gaming/editing and budget allows.
      const preferHighPerf = usage === 'gaming' || usage === 'editing';
      const needsGpu = usage === 'gaming' || usage === 'editing' || usage === 'mixed';
      const isForced = (slot: any) =>
        Boolean(slot.is_required) || (needsGpu && slot.component_type === 'gpu');
      const requiredSlots = slots.rows.filter((s: any) => isForced(s));
      const optionalSlots = slots.rows.filter((s: any) => !isForced(s));
      const pickForType = (type: string, maxPrice: number, preferHigh: boolean) => {
        const list = (byType.get(type) || []).filter(
          (p) => Number(effectiveProductPrice(p)) <= maxPrice,
        );
        if (!list.length) return null;
        if (preferHigh && (type === 'gpu' || type === 'cpu')) {
          return list[list.length - 1];
        }
        // balanced: around mid of affordable options
        return list[Math.min(list.length - 1, Math.floor(list.length * 0.55))];
      };

      let remaining = budget;
      const selected: Array<{
        slot_id: number;
        slot_name: string;
        component_type: string;
        product: any;
        reason: string;
      }> = [];

      // GPU early for gaming so budget is reserved for it.
      const ordered = [
        ...requiredSlots.filter(
          (s: any) =>
            s.component_type === 'cpu' ||
            s.component_type === 'motherboard' ||
            s.component_type === 'gpu',
        ),
        ...requiredSlots.filter(
          (s: any) => !['cpu', 'motherboard', 'gpu'].includes(s.component_type),
        ),
        ...optionalSlots,
      ];
      for (let idx = 0; idx < ordered.length; idx++) {
        const slot = ordered[idx];
        if (
          !isForced(slot) &&
          usage === 'office' &&
          (slot.component_type === 'gpu' || slot.component_type === 'cooler')
        ) {
          continue;
        }
        const remainingForced = ordered.slice(idx + 1).filter((s) => isForced(s)).length;
        const reserveFloor = remainingForced * 1200;
        const maxForThis = Math.max(500, remaining - reserveFloor);
        const product = pickForType(
          slot.component_type,
          maxForThis,
          preferHighPerf && (slot.component_type === 'gpu' || slot.component_type === 'cpu'),
        );
        if (!product) {
          if (isForced(slot)) {
            // last try: cheapest available for this type within remaining
            const cheapest = pickForType(slot.component_type, remaining, false);
            if (!cheapest) {
              return {
                result: {
                  ok: false,
                  message: `no_affordable_${slot.component_type}`,
                  budget,
                },
              };
            }
            const price = Number(effectiveProductPrice(cheapest));
            remaining -= price;
            selected.push({
              slot_id: slot.id,
              slot_name: slot.name,
              component_type: slot.component_type,
              product: cheapest,
              reason: 'أقل خيار متاح لإبقاء التجميعة ضمن الميزانية',
            });
            continue;
          }
          continue;
        }
        const price = Number(effectiveProductPrice(product));
        remaining -= price;
        selected.push({
          slot_id: slot.id,
          slot_name: slot.name,
          component_type: slot.component_type,
          product,
          reason:
            slot.component_type === 'cpu'
              ? 'متوافق مع الميزانية والاستخدام'
              : slot.component_type === 'gpu'
                ? usage === 'gaming'
                  ? 'أداء ألعاب مناسب ضمن الميزانية'
                  : 'اختياري حسب الاستخدام'
                : 'توازن بين السعر والأداء',
        });
      }

      const compat = await checkBuildCompatibility(
        selected.map((s) => ({
          product_id: s.product.id,
          component_type: s.product.component_type,
          specs: s.product.specs,
        })),
      );

      // If incompatible, try simple socket-aligned rematch for motherboard/cpu
      if (compat.overall === 'incompatible') {
        const cpu = selected.find((s) => s.component_type === 'cpu');
        const mb = selected.find((s) => s.component_type === 'motherboard');
        if (cpu && mb) {
          const socket = cpu.product.specs?.socket;
          const altMb = (byType.get('motherboard') || []).find(
            (p) =>
              String(p.specs?.socket || '').toLowerCase() === String(socket || '').toLowerCase() &&
              Number(effectiveProductPrice(p)) <=
                Number(effectiveProductPrice(mb.product)) +
                  remaining +
                  Number(effectiveProductPrice(mb.product)),
          );
          if (altMb) {
            remaining += Number(effectiveProductPrice(mb.product));
            remaining -= Number(effectiveProductPrice(altMb));
            mb.product = altMb;
            mb.reason = 'تم اختيار لوحة متوافقة مع سوكيت المعالج';
          }
        }
      }

      const finalCompat = await checkBuildCompatibility(
        selected.map((s) => ({
          product_id: s.product.id,
          component_type: s.product.component_type,
          specs: s.product.specs,
        })),
      );

      let total = '0.00';
      const components = selected.map((s) => {
        const card = mapProduct(s.product);
        total = addMoney(total, card.effective_price);
        return {
          slot_id: s.slot_id,
          slot_name: s.slot_name,
          component_type: s.component_type,
          product_id: s.product.id,
          reason: s.reason,
          ...card,
        };
      });

      const buildPlan = {
        budget,
        usage,
        total,
        remaining: toMoney(Math.max(0, budget - Number(total))),
        compatibility: finalCompat.overall,
        issues: finalCompat.issues.slice(0, 5),
        components,
      };

      return {
        result: {
          ok: true,
          ...buildPlan,
          note:
            finalCompat.overall === 'incompatible'
              ? 'بعض المكونات قد تحتاج تعديل يدوي في صفحة التجميعة'
              : 'التجميعة متوافقة ضمن البيانات المتاحة',
        },
        cards: components.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          price: c.price,
          effective_price: c.effective_price,
          image: c.image,
          brand_name: c.brand_name,
          category_name: c.category_name,
          available_stock: c.available_stock,
          href: c.href,
          short_specs: c.short_specs,
        })),
        buildPlan,
      };
    }
    case 'get_store_policies': {
      const rows = await pool.query(
        `SELECT key, value FROM store_settings
         WHERE key = ANY($1::text[])`,
        [['store_name', 'currency', 'assistant_config', 'shipping_policy', 'warranty_policy']],
      );
      const settings: Record<string, unknown> = {};
      for (const row of rows.rows) settings[row.key] = row.value;
      return {
        result: {
          store_name: settings.store_name ?? 'Arkan',
          currency: settings.currency ?? config.STORE_CURRENCY,
          shipping_policy: settings.shipping_policy ?? null,
          warranty_policy: settings.warranty_policy ?? null,
        },
      };
    }
    default:
      return { result: { error: `unknown_tool:${name}` } };
  }
}
