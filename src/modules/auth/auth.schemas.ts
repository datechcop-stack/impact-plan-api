import { z } from "zod";

export const chooseMethodSchema = z.object({
  token: z.string().min(20),
  method: z.enum(["PASSWORD", "OTP"]),
});

export const activatePasswordSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(10),
  confirmPassword: z.string().min(10),
});

export const requestOtpSchema = z.object({
  email: z.string().email().optional(),
  token: z.string().min(20).optional(),
  purpose: z.enum(["ACTIVATION", "LOGIN", "PASSWORD_RESET"]),
});

export const verifyOtpSchema = z.object({
  email: z.string().email().optional(),
  token: z.string().min(20).optional(),
  purpose: z.enum(["ACTIVATION", "LOGIN", "PASSWORD_RESET"]),
  code: z.string().regex(/^\d{6}$/),
});

export const loginPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const forgotPasswordResetSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(10),
  confirmPassword: z.string().min(10),
});

export const inviteLookupSchema = z.object({
  token: z.string().min(20),
});
