-- Up Migration: PC Store expansion (additive, non-destructive)

-- ========== Enums ==========
DO $$ BEGIN
  CREATE TYPE account_status AS ENUM ('active', 'suspended', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE product_status AS ENUM ('draft', 'active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE product_condition AS ENUM ('new', 'refurbished', 'used');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fulfillment_status AS ENUM (
    'unfulfilled', 'partial', 'ready_for_shipment', 'shipped', 'delivered', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_movement_type AS ENUM (
    'purchase_receive', 'sale', 'reservation', 'release', 'adjustment',
    'return_restock', 'damage', 'transfer'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE compatibility_result AS ENUM (
    'compatible', 'incompatible', 'uncertain', 'needs_verification'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE build_status AS ENUM ('draft', 'ready', 'ordered', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE coupon_type AS ENUM ('fixed', 'percentage', 'free_shipping');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Expand order_status safely
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'pending_payment';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'awaiting_confirmation';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'ready_for_shipment';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'return_requested';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'returned';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'partially_refunded';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'refunded';

-- ========== Users / Auth expansions ==========
ALTER TABLE users ADD COLUMN IF NOT EXISTS status account_status NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

UPDATE users SET is_staff = TRUE WHERE role = 'admin';

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_info TEXT,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  module TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  assigned_at TIMESTAMP DEFAULT NOW(),
  assigned_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  before_data JSONB,
  after_data JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource_type, resource_id);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label TEXT,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  governorate TEXT,
  city TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  postal_code TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== Catalog ==========
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_title TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_description TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  logo TEXT,
  website TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands (id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12, 2) CHECK (cost_price IS NULL OR cost_price >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12, 2) CHECK (sale_price IS NULL OR sale_price >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_starts_at TIMESTAMP;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_ends_at TIMESTAMP;
ALTER TABLE products ADD COLUMN IF NOT EXISTS status product_status NOT NULL DEFAULT 'draft';
ALTER TABLE products ADD COLUMN IF NOT EXISTS condition product_condition NOT NULL DEFAULT 'new';
ALTER TABLE products ADD COLUMN IF NOT EXISTS component_type TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS length_mm NUMERIC(10, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS width_mm NUMERIC(10, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS height_mm NUMERIC(10, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_months INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_terms TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_number TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_inventory BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5;
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order_qty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS max_order_qty INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_title TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS seo_description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_keywords TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reserved_stock INTEGER NOT NULL DEFAULT 0 CHECK (reserved_stock >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS specs JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE products SET status = 'active' WHERE is_active = TRUE AND status = 'draft';

CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  price NUMERIC(12, 2),
  cost_price NUMERIC(12, 2),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  reserved_stock INTEGER NOT NULL DEFAULT 0 CHECK (reserved_stock >= 0),
  barcode TEXT,
  image TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spec_definitions (
  id SERIAL PRIMARY KEY,
  component_type TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  unit TEXT,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (component_type, key)
);

-- ========== Compatibility ==========
CREATE TABLE IF NOT EXISTS compatibility_rules (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  left_component_type TEXT NOT NULL,
  right_component_type TEXT NOT NULL,
  left_spec_key TEXT NOT NULL,
  right_spec_key TEXT NOT NULL,
  operator TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compatibility_overrides (
  id SERIAL PRIMARY KEY,
  left_product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  right_product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  result compatibility_result NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (left_product_id, right_product_id)
);

-- ========== PC Builder ==========
CREATE TABLE IF NOT EXISTS build_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS build_slots (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES build_templates (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  component_type TEXT NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  allow_multiple BOOLEAN NOT NULL DEFAULT FALSE,
  min_quantity INTEGER NOT NULL DEFAULT 1,
  max_quantity INTEGER NOT NULL DEFAULT 1,
  can_skip BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS pc_builds (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  guest_token TEXT,
  template_id INTEGER REFERENCES build_templates (id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT 'My Build',
  share_token TEXT UNIQUE,
  status build_status NOT NULL DEFAULT 'draft',
  notes TEXT,
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pc_builds_user ON pc_builds (user_id);
CREATE INDEX IF NOT EXISTS idx_pc_builds_share ON pc_builds (share_token);

CREATE TABLE IF NOT EXISTS pc_build_items (
  id SERIAL PRIMARY KEY,
  build_id INTEGER NOT NULL REFERENCES pc_builds (id) ON DELETE CASCADE,
  slot_id INTEGER REFERENCES build_slots (id) ON DELETE SET NULL,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  variant_id INTEGER REFERENCES product_variants (id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (build_id, slot_id, product_id, variant_id)
);

-- ========== Cart refactor ==========
CREATE TABLE IF NOT EXISTS carts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  guest_token TEXT UNIQUE,
  coupon_code TEXT,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT cart_owner_check CHECK (user_id IS NOT NULL OR guest_token IS NOT NULL)
);

-- New cart_items shape (keep old table; migrate data then replace usage in app)
CREATE TABLE IF NOT EXISTS cart_lines (
  id SERIAL PRIMARY KEY,
  cart_id INTEGER NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products (id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants (id) ON DELETE SET NULL,
  build_id INTEGER REFERENCES pc_builds (id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT cart_line_item_check CHECK (
    (product_id IS NOT NULL AND build_id IS NULL) OR (build_id IS NOT NULL AND product_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_cart_lines_cart ON cart_lines (cart_id);

-- ========== Inventory ==========
CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products (id) ON DELETE SET NULL,
  variant_id INTEGER REFERENCES product_variants (id) ON DELETE SET NULL,
  movement_type stock_movement_type NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT,
  reference_type TEXT,
  reference_id TEXT,
  actor_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants (id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  cart_id INTEGER REFERENCES carts (id) ON DELETE CASCADE,
  order_id INTEGER,
  expires_at TIMESTAMP NOT NULL,
  released_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== Orders expansion ==========
ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status payment_status NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status fulfillment_status NOT NULL DEFAULT 'unfulfilled';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_total NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_total NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_total NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'EGP';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_address JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address_json JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_notes TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_email TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id INTEGER REFERENCES product_variants (id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS build_id INTEGER;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS build_snapshot JSONB;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS specs_snapshot JSONB;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS line_total NUMERIC(12, 2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS order_status_history (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  actor_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== Payments ==========
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  status payment_status NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  idempotency_key TEXT UNIQUE,
  raw_payload JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== Coupons ==========
CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type coupon_type NOT NULL,
  value NUMERIC(12, 2) NOT NULL CHECK (value >= 0),
  min_order_amount NUMERIC(12, 2),
  max_discount NUMERIC(12, 2),
  starts_at TIMESTAMP,
  ends_at TIMESTAMP,
  usage_limit INTEGER,
  per_customer_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  first_order_only BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id SERIAL PRIMARY KEY,
  coupon_id INTEGER NOT NULL REFERENCES coupons (id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== Shipping ==========
CREATE TABLE IF NOT EXISTS shipping_methods (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  base_rate NUMERIC(12, 2) NOT NULL DEFAULT 0,
  free_above NUMERIC(12, 2),
  estimated_days_min INTEGER,
  estimated_days_max INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS shipments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  carrier TEXT,
  tracking_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  shipped_at TIMESTAMP,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== Store settings ==========
CREATE TABLE IF NOT EXISTS store_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ========== Reviews ==========
CREATE TABLE IF NOT EXISTS product_reviews (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  is_verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (product_id, user_id)
);

-- ========== Wishlists ==========
CREATE TABLE IF NOT EXISTS wishlists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);

-- ========== Seed RBAC ==========
INSERT INTO roles (name, slug, description, is_system) VALUES
  ('Super Admin', 'super_admin', 'Full system access', TRUE),
  ('Store Manager', 'store_manager', 'Store operations', TRUE),
  ('Product Manager', 'product_manager', 'Catalog management', TRUE),
  ('Inventory Manager', 'inventory_manager', 'Stock control', TRUE),
  ('Order Manager', 'order_manager', 'Order fulfillment', TRUE),
  ('Customer Support', 'customer_support', 'Customer assistance', TRUE),
  ('Marketing Manager', 'marketing_manager', 'Promotions and content', TRUE),
  ('Finance Manager', 'finance_manager', 'Payments and reports', TRUE)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO permissions (code, module, description) VALUES
  ('dashboard.read', 'dashboard', 'View dashboard analytics'),
  ('categories.manage', 'categories', 'Manage categories'),
  ('brands.manage', 'brands', 'Manage brands'),
  ('products.manage', 'products', 'Manage products'),
  ('products.price', 'products', 'Change product prices'),
  ('inventory.manage', 'inventory', 'Adjust inventory'),
  ('orders.read', 'orders', 'View orders'),
  ('orders.manage', 'orders', 'Update order status'),
  ('orders.refund', 'orders', 'Process refunds'),
  ('customers.manage', 'customers', 'Manage customers'),
  ('coupons.manage', 'coupons', 'Manage coupons'),
  ('builder.manage', 'builder', 'Manage PC builder templates and rules'),
  ('compatibility.override', 'builder', 'Override compatibility checks'),
  ('payments.configure', 'payments', 'Configure payment methods'),
  ('shipping.manage', 'shipping', 'Manage shipping'),
  ('settings.manage', 'settings', 'Manage store settings'),
  ('roles.manage', 'roles', 'Manage roles and permissions'),
  ('reports.financial', 'reports', 'View financial reports'),
  ('audit.read', 'audit', 'View audit logs'),
  ('reviews.moderate', 'reviews', 'Moderate reviews')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.slug = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN (
  'dashboard.read','categories.manage','brands.manage','products.manage','products.price',
  'inventory.manage','orders.read','orders.manage','customers.manage','coupons.manage',
  'builder.manage','shipping.manage','reviews.moderate'
)
WHERE r.slug = 'store_manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('categories.manage','brands.manage','products.manage','products.price','builder.manage')
WHERE r.slug = 'product_manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('inventory.manage','products.manage','dashboard.read')
WHERE r.slug = 'inventory_manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('orders.read','orders.manage','customers.manage','dashboard.read')
WHERE r.slug = 'order_manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('orders.read','customers.manage','reviews.moderate')
WHERE r.slug = 'customer_support'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('coupons.manage','products.manage','dashboard.read')
WHERE r.slug = 'marketing_manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.code IN ('dashboard.read','orders.read','orders.refund','reports.financial','payments.configure')
WHERE r.slug = 'finance_manager'
ON CONFLICT DO NOTHING;

-- Assign super_admin to existing admins
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u
CROSS JOIN roles r
WHERE u.role = 'admin' AND r.slug = 'super_admin'
ON CONFLICT DO NOTHING;

-- Default store settings
INSERT INTO store_settings (key, value) VALUES
  ('currency', '"EGP"'::jsonb),
  ('tax_rate', '0'::jsonb),
  ('timezone', '"Africa/Cairo"'::jsonb),
  ('store_name', '"Arkan PC Store"'::jsonb),
  ('psu_safety_margin_percent', '20'::jsonb),
  ('allow_backorders', 'false'::jsonb),
  ('reservation_minutes', '15'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Spec definitions (extensible)
INSERT INTO spec_definitions (component_type, key, label, value_type, unit, is_required, sort_order) VALUES
  ('cpu', 'socket', 'Socket', 'string', NULL, TRUE, 1),
  ('cpu', 'tdp_w', 'TDP', 'number', 'W', FALSE, 2),
  ('cpu', 'memory_type', 'Memory Type', 'string', NULL, FALSE, 3),
  ('cpu', 'max_memory_gb', 'Max Memory', 'number', 'GB', FALSE, 4),
  ('cpu', 'integrated_graphics', 'Integrated Graphics', 'boolean', NULL, FALSE, 5),
  ('motherboard', 'socket', 'CPU Socket', 'string', NULL, TRUE, 1),
  ('motherboard', 'form_factor', 'Form Factor', 'string', NULL, TRUE, 2),
  ('motherboard', 'ram_type', 'RAM Type', 'string', NULL, TRUE, 3),
  ('motherboard', 'ram_slots', 'RAM Slots', 'number', NULL, TRUE, 4),
  ('motherboard', 'max_ram_gb', 'Max RAM', 'number', 'GB', TRUE, 5),
  ('motherboard', 'm2_slots', 'M.2 Slots', 'number', NULL, FALSE, 6),
  ('motherboard', 'sata_ports', 'SATA Ports', 'number', NULL, FALSE, 7),
  ('ram', 'capacity_gb', 'Capacity', 'number', 'GB', TRUE, 1),
  ('ram', 'ddr_generation', 'DDR Generation', 'string', NULL, TRUE, 2),
  ('ram', 'speed_mhz', 'Speed', 'number', 'MHz', FALSE, 3),
  ('ram', 'modules', 'Modules', 'number', NULL, FALSE, 4),
  ('ram', 'form_factor', 'Form Factor', 'string', NULL, FALSE, 5),
  ('gpu', 'length_mm', 'Length', 'number', 'mm', FALSE, 1),
  ('gpu', 'tdp_w', 'Board Power', 'number', 'W', FALSE, 2),
  ('gpu', 'recommended_psu_w', 'Recommended PSU', 'number', 'W', FALSE, 3),
  ('gpu', 'power_connectors', 'Power Connectors', 'string', NULL, FALSE, 4),
  ('storage', 'capacity_gb', 'Capacity', 'number', 'GB', TRUE, 1),
  ('storage', 'interface', 'Interface', 'string', NULL, TRUE, 2),
  ('storage', 'form_factor', 'Form Factor', 'string', NULL, FALSE, 3),
  ('psu', 'wattage', 'Wattage', 'number', 'W', TRUE, 1),
  ('psu', 'efficiency', 'Efficiency', 'string', NULL, FALSE, 2),
  ('psu', 'modular', 'Modular', 'string', NULL, FALSE, 3),
  ('case', 'motherboard_form_factors', 'Supported Form Factors', 'string', NULL, TRUE, 1),
  ('case', 'max_gpu_length_mm', 'Max GPU Length', 'number', 'mm', FALSE, 2),
  ('case', 'max_cooler_height_mm', 'Max Cooler Height', 'number', 'mm', FALSE, 3),
  ('cooler', 'type', 'Cooling Type', 'string', NULL, TRUE, 1),
  ('cooler', 'supported_sockets', 'Supported Sockets', 'string', NULL, TRUE, 2),
  ('cooler', 'height_mm', 'Height', 'number', 'mm', FALSE, 3)
ON CONFLICT (component_type, key) DO NOTHING;

-- Default compatibility rules
INSERT INTO compatibility_rules (code, name, description, left_component_type, right_component_type, left_spec_key, right_spec_key, operator, severity) VALUES
  ('cpu_mb_socket', 'CPU / Motherboard socket', 'CPU socket must match motherboard socket', 'cpu', 'motherboard', 'socket', 'socket', 'eq', 'error'),
  ('ram_mb_type', 'RAM / Motherboard type', 'RAM generation must match motherboard', 'ram', 'motherboard', 'ddr_generation', 'ram_type', 'eq', 'error'),
  ('case_mb_ff', 'Case / Motherboard form factor', 'Case must support motherboard form factor', 'case', 'motherboard', 'motherboard_form_factors', 'form_factor', 'contains', 'error'),
  ('gpu_case_length', 'GPU / Case clearance', 'GPU length must fit in case', 'gpu', 'case', 'length_mm', 'max_gpu_length_mm', 'lte', 'error'),
  ('cooler_cpu_socket', 'Cooler / CPU socket', 'Cooler must support CPU socket', 'cooler', 'cpu', 'supported_sockets', 'socket', 'contains', 'error'),
  ('cooler_case_height', 'Cooler / Case height', 'Cooler height must fit in case', 'cooler', 'case', 'height_mm', 'max_cooler_height_mm', 'lte', 'warning')
ON CONFLICT (code) DO NOTHING;

-- Default build template
INSERT INTO build_templates (name, slug, description, display_order)
VALUES ('Custom PC', 'custom-pc', 'Full custom PC configuration', 1)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO build_slots (template_id, name, component_type, is_required, allow_multiple, min_quantity, max_quantity, can_skip, display_order)
SELECT t.id, s.name, s.component_type, s.is_required, s.allow_multiple, s.min_qty, s.max_qty, s.can_skip, s.ord
FROM build_templates t
CROSS JOIN (VALUES
  ('CPU', 'cpu', TRUE, FALSE, 1, 1, FALSE, 1),
  ('Motherboard', 'motherboard', TRUE, FALSE, 1, 1, FALSE, 2),
  ('RAM', 'ram', TRUE, TRUE, 1, 4, FALSE, 3),
  ('GPU', 'gpu', FALSE, FALSE, 0, 1, TRUE, 4),
  ('Storage', 'storage', TRUE, TRUE, 1, 4, FALSE, 5),
  ('Power Supply', 'psu', TRUE, FALSE, 1, 1, FALSE, 6),
  ('Case', 'case', TRUE, FALSE, 1, 1, FALSE, 7),
  ('CPU Cooler', 'cooler', FALSE, FALSE, 0, 1, TRUE, 8)
) AS s(name, component_type, is_required, allow_multiple, min_qty, max_qty, can_skip, ord)
WHERE t.slug = 'custom-pc'
AND NOT EXISTS (SELECT 1 FROM build_slots bs WHERE bs.template_id = t.id);

INSERT INTO shipping_methods (name, code, description, base_rate, free_above, estimated_days_min, estimated_days_max)
VALUES
  ('Standard Delivery', 'standard', 'Standard shipping within Egypt', 50, 5000, 2, 5),
  ('Express Delivery', 'express', 'Faster delivery', 100, NULL, 1, 2)
ON CONFLICT (code) DO NOTHING;

-- Down Migration (partial — keeps data-safe; full teardown not auto-run)
-- DROP TABLE IF EXISTS wishlists, product_reviews, store_settings, shipments, shipping_methods,
--   coupon_redemptions, coupons, refunds, payments, order_status_history, inventory_reservations,
--   stock_movements, cart_lines, carts, pc_build_items, pc_builds, build_slots, build_templates,
--   compatibility_overrides, compatibility_rules, spec_definitions, product_variants, brands,
--   customer_addresses, audit_logs, user_roles, role_permissions, permissions, roles, refresh_tokens;
