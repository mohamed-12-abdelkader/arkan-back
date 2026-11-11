import pool from '../../db/pool';

export type CompatStatus = 'compatible' | 'incompatible' | 'uncertain' | 'needs_verification';

export interface CompatIssue {
  rule_code: string;
  severity: string;
  status: CompatStatus;
  left_product_id: number;
  right_product_id: number;
  left_component_type: string;
  right_component_type: string;
  message: string;
  suggestion?: string;
}

function readSpec(specs: Record<string, unknown>, key: string): unknown {
  return specs?.[key];
}

function compare(op: string, left: unknown, right: unknown): boolean | null {
  if (left == null || right == null || left === '' || right === '') return null;

  switch (op) {
    case 'eq':
      return String(left).toLowerCase() === String(right).toLowerCase();
    case 'neq':
      return String(left).toLowerCase() !== String(right).toLowerCase();
    case 'contains': {
      const hay = String(left).toLowerCase();
      const needle = String(right).toLowerCase();
      return hay.split(/[,|/]/).map((s) => s.trim()).includes(needle) || hay.includes(needle);
    }
    case 'lte':
      return Number(left) <= Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'gt':
      return Number(left) > Number(right);
    default:
      return null;
  }
}

export async function checkBuildCompatibility(
  items: Array<{ product_id: number; component_type?: string | null; specs?: any }>,
): Promise<{ overall: CompatStatus; issues: CompatIssue[] }> {
  if (items.length < 2) {
    return { overall: 'compatible', issues: [] };
  }

  const productIds = items.map((i) => i.product_id);
  const products = await pool.query(
    `SELECT id, name, component_type, specs FROM products WHERE id = ANY($1::int[])`,
    [productIds],
  );
  const byId = new Map(products.rows.map((p) => [p.id, p]));

  const overrides = await pool.query(
    `SELECT * FROM compatibility_overrides
     WHERE left_product_id = ANY($1::int[]) AND right_product_id = ANY($1::int[])`,
    [productIds],
  );
  const overrideMap = new Map(
    overrides.rows.map((o) => [`${o.left_product_id}:${o.right_product_id}`, o]),
  );

  const rules = await pool.query(`SELECT * FROM compatibility_rules WHERE is_active = TRUE`);
  const issues: CompatIssue[] = [];

  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const left = byId.get(items[a].product_id);
      const right = byId.get(items[b].product_id);
      if (!left || !right) continue;

      const override =
        overrideMap.get(`${left.id}:${right.id}`) || overrideMap.get(`${right.id}:${left.id}`);
      if (override) {
        if (override.result === 'incompatible') {
          issues.push({
            rule_code: 'manual_override',
            severity: 'error',
            status: 'incompatible',
            left_product_id: left.id,
            right_product_id: right.id,
            left_component_type: left.component_type,
            right_component_type: right.component_type,
            message: `Manual override: incompatible. Reason: ${override.reason}`,
          });
        }
        continue;
      }

      for (const rule of rules.rows) {
        const pair =
          left.component_type === rule.left_component_type &&
          right.component_type === rule.right_component_type
            ? { L: left, R: right }
            : left.component_type === rule.right_component_type &&
                right.component_type === rule.left_component_type
              ? { L: right, R: left }
              : null;
        if (!pair) continue;

        const leftVal = readSpec(pair.L.specs || {}, rule.left_spec_key);
        const rightVal = readSpec(pair.R.specs || {}, rule.right_spec_key);
        const result = compare(rule.operator, leftVal, rightVal);

        if (result === null) {
          issues.push({
            rule_code: rule.code,
            severity: 'info',
            status: 'uncertain',
            left_product_id: pair.L.id,
            right_product_id: pair.R.id,
            left_component_type: pair.L.component_type,
            right_component_type: pair.R.component_type,
            message: `Cannot confirm ${rule.name}: missing specification data (${rule.left_spec_key} / ${rule.right_spec_key}).`,
            suggestion: 'Add complete specs or mark as needs verification.',
          });
        } else if (!result) {
          issues.push({
            rule_code: rule.code,
            severity: rule.severity,
            status: 'incompatible',
            left_product_id: pair.L.id,
            right_product_id: pair.R.id,
            left_component_type: pair.L.component_type,
            right_component_type: pair.R.component_type,
            message: `${rule.name}: ${pair.L.name} is incompatible with ${pair.R.name}.`,
            suggestion: rule.description,
          });
        }
      }
    }
  }

  // Power estimate (PSU vs estimated draw)
  const psu = products.rows.find((p) => p.component_type === 'psu');
  if (psu) {
    const wattage = Number(psu.specs?.wattage ?? 0);
    let estimated = 0;
    let missingPowerData = false;
    for (const p of products.rows) {
      if (p.component_type === 'cpu' || p.component_type === 'gpu') {
        const tdp = Number(p.specs?.tdp_w ?? p.specs?.recommended_psu_w ?? NaN);
        if (Number.isNaN(tdp)) missingPowerData = true;
        else estimated += tdp;
      }
    }
    const marginRes = await pool.query(
      `SELECT value FROM store_settings WHERE key = 'psu_safety_margin_percent'`,
    );
    const margin = Number(marginRes.rows[0]?.value ?? 20);
    const required = Math.ceil(estimated * (1 + margin / 100)) + 100; // +100W baseline board/drives

    if (!wattage) {
      issues.push({
        rule_code: 'psu_wattage_missing',
        severity: 'info',
        status: 'uncertain',
        left_product_id: psu.id,
        right_product_id: psu.id,
        left_component_type: 'psu',
        right_component_type: 'system',
        message: 'PSU wattage specification is missing; cannot validate power requirements.',
      });
    } else if (missingPowerData) {
      issues.push({
        rule_code: 'psu_estimate_uncertain',
        severity: 'warning',
        status: 'uncertain',
        left_product_id: psu.id,
        right_product_id: psu.id,
        left_component_type: 'psu',
        right_component_type: 'system',
        message: `Estimated system draw is incomplete. PSU is ${wattage}W; treat power check as uncertain.`,
      });
    } else if (wattage < required) {
      issues.push({
        rule_code: 'psu_insufficient',
        severity: 'error',
        status: 'incompatible',
        left_product_id: psu.id,
        right_product_id: psu.id,
        left_component_type: 'psu',
        right_component_type: 'system',
        message: `PSU ${wattage}W may be insufficient (estimated need ~${required}W with ${margin}% safety margin).`,
        suggestion: 'Choose a higher wattage PSU.',
      });
    }
  }

  let overall: CompatStatus = 'compatible';
  if (issues.some((i) => i.status === 'incompatible' && i.severity === 'error')) {
    overall = 'incompatible';
  } else if (issues.some((i) => i.status === 'uncertain' || i.status === 'needs_verification')) {
    overall = 'uncertain';
  } else if (issues.some((i) => i.severity === 'warning')) {
    overall = 'needs_verification';
  }

  return { overall, issues };
}
