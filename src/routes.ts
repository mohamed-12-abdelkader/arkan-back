import { Router } from 'express';

import { router as authRouter } from './controllers/auth';
import { router as userRouter } from './controllers/user';
import { router as utilsRouter } from './controllers/utils';
import { router as categoriesRouter } from './modules/categories/routes';
import { router as brandsRouter } from './modules/brands/routes';
import { router as productsRouter } from './modules/products/routes';
import { router as builderRouter } from './modules/builder/routes';
import { router as cartRouter } from './modules/cart/routes';
import { router as ordersRouter } from './modules/orders/routes';
import { router as paymentsRouter } from './modules/payments/routes';
import { router as inventoryRouter } from './modules/inventory/routes';
import { router as dashboardRouter } from './modules/dashboard/routes';
import { router as settingsRouter } from './modules/settings/routes';
import { router as couponsRouter } from './modules/coupons/routes';
import { router as rolesRouter } from './modules/roles/routes';
import { router as assistantRouter } from './modules/assistant/routes';
import { router as whatsappRouter } from './modules/whatsapp/routes';
import { router as webhooksRouter } from './modules/webhooks/routes';

export const router = Router();

// Auth & users
router.use('/', authRouter);
router.use('/user', userRouter);
router.use('/utils', utilsRouter);

// Catalog
router.use('/categories', categoriesRouter);
router.use('/brands', brandsRouter);
router.use('/products', productsRouter);

// PC Builder
router.use('/builder', builderRouter);

// Commerce
router.use('/cart', cartRouter);
router.use('/orders', ordersRouter);
router.use('/payments', paymentsRouter);
router.use('/coupons', couponsRouter);

// Admin ops
router.use('/inventory', inventoryRouter);
router.use('/dashboard', dashboardRouter);
router.use('/settings', settingsRouter);
router.use('/roles', rolesRouter);

// AI Sales Assistant
router.use('/assistant', assistantRouter);

// WhatsApp order follow-up
router.use('/whatsapp', whatsappRouter);
router.use('/webhooks', webhooksRouter);
