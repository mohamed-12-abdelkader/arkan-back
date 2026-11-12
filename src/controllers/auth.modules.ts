import { z } from 'zod';

/** Customer signup: name + phone + password (email optional) */
export const RegisterUser = z.object({
  name: z.string().min(1),
  phone: z.string().regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number'),
  password: z.string().min(6),
  email: z.string().email().optional(),
});

export const Login = z
  .object({
    email: z.string().email().optional(),
    phone: z
      .string()
      .regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number')
      .optional(),
    password: z.string(),
  })
  .refine((data) => data.email || data.phone, {
    message: 'Either email or phone must be provided',
  });

export const ForgotPassword = z.object({
  email: z.string().email(),
});

export const ResetPassword = z.object({
  token: z.string(),
  password: z.string().min(6),
});

export const ChangePassword = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(8).optional(),
    new_password: z.string().min(6),
  })
  .refine((data) => data.email || data.phone, {
    message: 'Either email or phone is required',
  });

export const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(20),
});

export const ChangeOwnPassword = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6),
});
