import { z } from 'zod';
import { OTP_PURPOSE } from '../config/constants';
import { email, gstNumber, indianMobile, password, text } from './common.validator';

export const registerSchema = z
  .object({
    name: text(120, 'Name'),
    email,
    mobile: indianMobile,
    password,
    confirmPassword: z.string().optional(),
    businessName: z.string().trim().max(160).optional(),
    gstNumber: gstNumber.optional(),
  })
  .refine((data) => !data.confirmPassword || data.confirmPassword === data.password, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

/**
 * Login accepts an email or a mobile number in one field. Parts dealers
 * remember one or the other, rarely both, and forcing a choice up front is
 * friction for no benefit.
 */
export const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or mobile number').max(200),
  password: z.string().min(1, 'Enter your password'),
  device: z.string().trim().max(200).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20, 'Missing refresh token'),
});

export const logoutSchema = z.object({
  refreshToken: z.string().optional(),
  allDevices: z.boolean().optional(),
});

export const requestOtpSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or mobile number').max(200),
  purpose: z.nativeEnum(OTP_PURPOSE).default(OTP_PURPOSE.FORGOT_PASSWORD),
});

export const verifyOtpSchema = z.object({
  reference: z.string().trim().min(10, 'Invalid verification reference'),
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'Enter the code from your message'),
});

export const resetPasswordSchema = z
  .object({
    reference: z.string().trim().min(10),
    verificationToken: z.string().trim().min(20),
    newPassword: password,
    confirmPassword: z.string().optional(),
  })
  .refine((data) => !data.confirmPassword || data.confirmPassword === data.newPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: password,
    confirmPassword: z.string().optional(),
  })
  .refine((data) => !data.confirmPassword || data.confirmPassword === data.newPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'Your new password must be different',
    path: ['newPassword'],
  });

export const updateProfileSchema = z.object({
  name: text(120, 'Name').optional(),
  businessName: z.string().trim().max(160).optional().or(z.literal('')),
  gstNumber: gstNumber.optional().or(z.literal('')),
  email: email.optional(),
  mobile: indianMobile.optional(),
});

export const pushTokenSchema = z.object({
  pushToken: z.string().trim().min(10, 'Invalid push token').max(300),
});
