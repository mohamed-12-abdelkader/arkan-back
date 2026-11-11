-- Up Migration: allow guest orders (buy-now / checkout without login)
ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;

-- Down Migration
-- ALTER TABLE orders ALTER COLUMN user_id SET NOT NULL;
