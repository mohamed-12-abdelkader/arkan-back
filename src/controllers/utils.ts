import { Router } from 'express';

export const router = Router();

router.get('/health-check', async (_req, res) => {
  res.send('Healthy!');
});
