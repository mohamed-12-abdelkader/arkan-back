import { z } from 'zod';

export const UserRole = z.enum(['user', 'admin']);
export type UserRole = z.infer<typeof UserRole>;

export const UserBase = z.object({
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  password: z.string().min(6).optional(),
  name: z.string().min(1),
});

export const User = UserBase.extend({
  id: z.number(),
  role: UserRole,
  avatar: z.string().nullable().optional(),
  jti: z.string().nullable().optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
  is_staff: z.boolean().optional(),
  permissions: z.array(z.string()).optional(),
  created_at: z.union([z.string(), z.date()]).optional(),
});

export type User = z.infer<typeof User>;
