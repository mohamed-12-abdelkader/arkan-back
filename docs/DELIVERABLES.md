# Final Deliverables — Arkan PC Store Backend

## 1. Implemented modules

| Module | Status | Notes |
|--------|--------|-------|
| Auth (login/logout/refresh/reset/change password) | Done | Access + refresh tokens, rate limit, lockout |
| RBAC roles & permissions | Done | 8 seeded roles, assign API, last-super-admin guard |
| Categories (hierarchical) | Done | Cycle prevention, safe delete |
| Brands | Done | |
| Products + variants + specs JSONB | Done | Server-side pricing, archive-on-delete |
| Spec definitions seed | Done | CPU/MB/RAM/GPU/Storage/PSU/Case/Cooler |
| Compatibility engine | Done | Rule-based + PSU estimate + overrides |
| Custom PC builder | Done | Templates, slots, save/share/duplicate, price recalc |
| Cart (guest + auth) | Done | Coupon, merge, builds as lines |
| Checkout / Orders | Done | Transactions, stock decrement, snapshots, status workflow |
| Inventory adjustments + movements | Done | Mandatory reason, no negative stock |
| Coupons | Done | Fixed / % / free shipping |
| Dashboard analytics | Done | Revenue definitions, trends, low stock, builds |
| Store settings | Done | Public vs admin; secrets rejected |
| Audit logs | Done | Written on sensitive actions |
| Payments abstraction | Partial | COD / bank_transfer records; no live gateway |
| Shipping methods | Partial | Config + rate in cart; no carrier API |
| Suppliers / PO / returns / reviews / wishlist / notifications / MFA | Not in this pass | Schema hooks exist for reviews/wishlists; APIs deferred |

## 2. Database

- `migrations/1681229663482_create-tables.sql` — base users/catalog/cart/orders
- `migrations/1760680000000_pc-store-expansion.sql` — RBAC, builder, inventory, payments, coupons, settings, specs, compatibility

## 3. API docs

See [`docs/API.md`](./API.md). Base path: `/api/v1` (legacy `/api` alias).

## 4. Auth & permissions

- JWT access token (`typ: access`) + opaque hashed refresh tokens
- Permissions checked via `requirePermission(...)`; legacy `role=admin` = full access
- Seeded permission codes listed in expansion migration

## 5. Environment

See [`.env.example`](../.env.example). Never commit real secrets.

## 6. Local development

```bash
cp .env.example .env
npm install
npm run dev
```

## 7. Tests

```bash
npm test -- --run
```

Current automated coverage: money helpers + compatibility operators (6 passing). Broader integration/E2E suites are the next QA priority.

## 8. External integrations needing credentials

- Cloudinary (images) — `CLOUDINARY_URL`
- SMTP email — password reset
- Payment gateway (Paymob / Stripe / etc.) — not wired
- SMS / WhatsApp — not wired
- Shipping carriers — not wired

## 9. Incomplete / assumptions

- Single warehouse / no stock transfers API yet
- Cancelled orders do not auto-restock (by design); return restock workflow API pending
- OpenAPI UI (Swagger UI) not embedded; markdown API doc provided
- Staff users currently use `role=admin` + RBAC; finer `is_staff` without admin enum can be refined
- Guest checkout requires `guest_email`; order `user_id` nullable after expansion migration

## 10. Recommended next steps (priority)

1. Integration tests for checkout concurrency, coupons, builder incompatibilities
2. Payment provider adapter + idempotent webhooks
3. Returns / warranty / restock inspection APIs
4. Suppliers & purchase orders
5. Embed Swagger UI from OpenAPI JSON
6. Background job runner for reservation expiry + notification retries
7. CSV product import/export
