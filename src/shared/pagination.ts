import { z } from 'zod';

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof PaginationQuery>;

export function getOffset(page: number, limit: number) {
  return (page - 1) * limit;
}
