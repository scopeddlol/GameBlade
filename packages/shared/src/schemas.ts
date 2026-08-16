import { z } from 'zod';
import { ROLES } from './constants.js';

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use only letters, numbers, dots, underscores and hyphens');

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(256, 'Password must be at most 256 characters');

export const emailSchema = z.string().trim().email('Enter a valid email address').max(254);

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username'),
  password: z.string().min(1, 'Enter your password'),
  /** Desktop clients ask for a long-lived device token instead of a cookie. */
  deviceName: z.string().trim().min(1).max(64).optional(),
  devicePlatform: z.string().trim().max(64).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: emailSchema.optional().or(z.literal('')),
  inviteCode: z.string().trim().min(1, 'An invite code is required').optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const createInviteSchema = z.object({
  role: z.enum(ROLES).default('user'),
  note: z.string().trim().max(200).optional(),
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(14),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const updateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  email: emailSchema.nullable().optional(),
  /** Admin-initiated password reset. */
  password: passwordSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const createLibrarySchema = z.object({
  name: z.string().trim().min(1).max(64),
  path: z.string().trim().min(1).max(4096),
  enabled: z.boolean().default(true),
});
export type CreateLibraryInput = z.infer<typeof createLibrarySchema>;

export const updateLibrarySchema = createLibrarySchema.partial();
export type UpdateLibraryInput = z.infer<typeof updateLibrarySchema>;

export const gameQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  genre: z.string().trim().max(64).optional(),
  platform: z.string().trim().max(64).optional(),
  libraryId: z.string().trim().max(64).optional(),
  matchStatus: z.enum(['unmatched', 'auto', 'manual', 'skipped']).optional(),
  favoritesOnly: z.coerce.boolean().optional(),
  includeMissing: z.coerce.boolean().default(false),
  sort: z
    .enum(['title', 'added', 'released', 'size', 'rating'])
    .default('title'),
  order: z.enum(['asc', 'desc']).default('asc'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
export type GameQuery = z.infer<typeof gameQuerySchema>;

export const matchGameSchema = z.object({
  igdbId: z.number().int().positive().nullable(),
  /** Re-fetch artwork from SteamGridDB after applying the match. */
  refreshArtwork: z.boolean().default(true),
});
export type MatchGameInput = z.infer<typeof matchGameSchema>;

export const providerSettingsSchema = z.object({
  serverName: z.string().trim().min(1).max(64).optional(),
  allowSelfRegistration: z.boolean().optional(),
  igdbClientId: z.string().trim().max(200).nullable().optional(),
  igdbClientSecret: z.string().trim().max(200).nullable().optional(),
  steamGridDbKey: z.string().trim().max(200).nullable().optional(),
});
export type ProviderSettingsInput = z.infer<typeof providerSettingsSchema>;

export const scanRequestSchema = z.object({
  libraryId: z.string().trim().max(64).optional(),
  /** Re-read every entry instead of trusting size/mtime. */
  force: z.boolean().default(false),
  /** Look up metadata for newly discovered games. */
  fetchMetadata: z.boolean().default(true),
});
export type ScanRequestInput = z.infer<typeof scanRequestSchema>;
