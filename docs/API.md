# Arkan PC Store — API Documentation

Base URL: `/api/v1` (also available under `/api`)

Auth header: `Authorization: Bearer <access_token>`

Standard success response:

```json
{ "success": true, "data": {} }
```

Paginated:

```json
{ "success": true, "data": [], "meta": { "total": 0, "page": 1, "limit": 20, "totalPages": 0 } }
```

## Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/login` | — | Login (email or phone + password). Returns `access_token` + `refresh_token` |
| POST | `/refresh` | — | Rotate refresh token |
| POST | `/logout` | yes | Revoke refresh tokens / session |
| POST | `/forgot-password` | — | Request reset email |
| POST | `/reset-password` | — | Reset with token |
| POST | `/change-password` | yes | Change own password |
| POST | `/user/register` | — | Customer registration (name + phone + password) |
| GET | `/user/me` | yes | Current profile + permissions |
| PUT | `/user/me` | yes | Update profile |
| GET | `/user` | admin + `customers.manage` | List users |

## Catalog

| Method | Path | Auth | Permission |
|--------|------|------|------------|
| GET/POST | `/categories` | write: admin | `categories.manage` |
| GET/PUT/DELETE | `/categories/:id` | write: admin | `categories.manage` |
| GET `/categories?tree=true` | — | Category tree |
| GET/POST | `/brands` | write: admin | `brands.manage` |
| GET/POST | `/products` | write: admin | `products.manage` |
| GET/PUT/DELETE | `/products/:id` | write: admin | `products.manage` |
| POST | `/products/:id/variants` | admin | `products.manage` |

## PC Builder

| Method | Path | Description |
|--------|------|-------------|
| GET | `/builder/templates` | Build templates + slots |
| POST | `/builder` | Create build (user or guest_token) |
| GET | `/builder/:id` | Get build + price + compatibility |
| POST | `/builder/:id/items` | Add/replace component |
| DELETE | `/builder/:id/items/:itemId` | Remove component |
| POST | `/builder/:id/validate` | Recalculate + compatibility |
| POST | `/builder/:id/duplicate` | Duplicate build |
| GET | `/builder/share/:token` | Public share |
| POST | `/builder/compatibility/overrides` | Admin override |

Compatibility statuses: `compatible` | `incompatible` | `uncertain` | `needs_verification`

## Cart & Checkout

| Method | Path | Description |
|--------|------|-------------|
| GET | `/cart` | Get cart (`guest_token` query for guests) |
| POST | `/cart/items` | Add product or build |
| PATCH | `/cart/items/:id` | Update qty |
| DELETE | `/cart/items/:id` | Remove line |
| POST/DELETE | `/cart/coupon` | Apply/remove coupon |
| POST | `/cart/merge` | Merge guest cart after login |
| POST | `/orders/checkout` | Place cart order (guest or logged-in; COD) |
| POST | `/orders/buy-now` | Buy one product directly (no cart) |
| GET | `/orders/track` | Track by `order_number` + `phone` |

See also:
- [CUSTOMER_COMMERCE_APIS.md](./CUSTOMER_COMMERCE_APIS.md) — توثيق تفصيلي (تسجيل · سلة · طلب · تتبع)
- [CUSTOMER_ORDERS_APIS.md](./CUSTOMER_ORDERS_APIS.md) — ملخص سريع

## Orders (customer)

| Method | Path |
|--------|------|
| GET | `/orders/me` |
| GET | `/orders/me/:id` |
| GET | `/orders/track` |
| POST | `/orders/buy-now` |

## Orders (admin)

| Method | Path | Permission |
|--------|------|------------|
| GET | `/orders` | `orders.read` |
| GET | `/orders/:id` | `orders.read` |
| PATCH | `/orders/:id/status` | `orders.manage` |

## Inventory / Dashboard / Settings / Coupons

| Method | Path | Permission |
|--------|------|------------|
| GET | `/inventory/low-stock` | `inventory.manage` |
| GET | `/inventory/movements` | `inventory.manage` |
| POST | `/inventory/adjust` | `inventory.manage` |
| GET | `/dashboard/overview` | `dashboard.read` |
| GET | `/dashboard/sales-trend` | `dashboard.read` |
| GET | `/settings/public` | — |
| GET/PUT | `/settings` | `settings.manage` |
| GET/POST | `/coupons` | `coupons.manage` |

## Roles & Permissions

Seeded roles: `super_admin`, `store_manager`, `product_manager`, `inventory_manager`, `order_manager`, `customer_support`, `marketing_manager`, `finance_manager`.

Legacy `users.role = 'admin'` still grants full permission set. Staff should also have rows in `user_roles`.
