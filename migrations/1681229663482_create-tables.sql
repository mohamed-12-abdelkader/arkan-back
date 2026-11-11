-- Up Migration
CREATE TYPE user_role AS ENUM ('user', 'admin');

CREATE TYPE order_status AS ENUM (
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled'
);

CREATE TABLE
    users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE,
        phone TEXT UNIQUE,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT,
        role user_role NOT NULL DEFAULT 'user',
        jti TEXT,
        created_at TIMESTAMP DEFAULT NOW (),
        CONSTRAINT email_or_phone_check CHECK (
            email IS NOT NULL
            OR phone IS NOT NULL
        )
    );

CREATE TABLE
    password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL DEFAULT (NOW () + INTERVAL '1 hour'),
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW ()
    );

CREATE TABLE
    categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        image TEXT,
        parent_id INTEGER REFERENCES categories (id) ON DELETE SET NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW ()
    );

CREATE TABLE
    products (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES categories (id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
        compare_at_price NUMERIC(10, 2) CHECK (compare_at_price IS NULL OR compare_at_price >= 0),
        stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
        sku TEXT UNIQUE,
        image TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW (),
        updated_at TIMESTAMP DEFAULT NOW ()
    );

CREATE TABLE
    product_images (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE
    cart_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        created_at TIMESTAMP DEFAULT NOW (),
        updated_at TIMESTAMP DEFAULT NOW (),
        UNIQUE (user_id, product_id)
    );

CREATE TABLE
    orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        status order_status NOT NULL DEFAULT 'pending',
        total NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (total >= 0),
        shipping_address TEXT,
        phone TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW (),
        updated_at TIMESTAMP DEFAULT NOW ()
    );

CREATE TABLE
    order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products (id) ON DELETE SET NULL,
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        price NUMERIC(10, 2) NOT NULL CHECK (price >= 0)
    );

CREATE INDEX idx_products_category ON products (category_id);
CREATE INDEX idx_products_active ON products (is_active);
CREATE INDEX idx_orders_user ON orders (user_id);
CREATE INDEX idx_cart_items_user ON cart_items (user_id);

-- Down Migration
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cart_items;
DROP TABLE IF EXISTS product_images;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS users;
DROP TYPE IF EXISTS order_status;
DROP TYPE IF EXISTS user_role;
