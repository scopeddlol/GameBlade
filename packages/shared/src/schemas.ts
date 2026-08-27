import { ACHIEVEMENT_COMPARATORS, ACHIEVEMENT_FORMATS } from './achievementRules.js';
import { BUG_SEVERITY, BUG_STATUS } from './constants.js';
import { z } from 'zod';
import type { DiscordActivityType } from './constants.js';
import { MESH_ENDPOINT_KINDS } from './mesh.js';
import { THEME_PRESETS } from './theme.js';
import {
  ACHIEVEMENT_SOURCE,
  API_SCOPES,
  ART_KIND,
  CATALOG_GAP,
  CLIENT_BUTTON_ICONS,
  CLIENT_BUTTON_PLACEMENT,
  COLLECTION_COLORS,
  DISCORD_ACTIVITY_TYPES,
  DISCORD_PRESENCE_STATUS,
  GAME_REQUEST_STATUS,
  MAX_CLIP_BYTES,
  MAX_COLLECTIONS_PER_USER,
  MAX_IMAGE_BYTES,
  POST_KIND,
  PRESENCE_STATUS,
  REACTIONS,
  ROLES,
  VISIBILITY,
} from './constants.js';

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

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'The reset link is missing its token'),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const createPasswordResetSchema = z.object({
  expiresInHours: z.number().int().min(1).max(168).default(24),
});
export type CreatePasswordResetInput = z.infer<typeof createPasswordResetSchema>;

export const createInviteSchema = z.object({
  role: z.enum(ROLES).default('user'),
  note: z.string().trim().max(200).optional(),
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(14),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

/** Self-service equivalent of updateUserSchema — no role or isActive; those stay admin-only. */
export const updateAccountSchema = z.object({
  username: usernameSchema.optional(),
  email: emailSchema.nullable().optional(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const updateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  email: emailSchema.nullable().optional(),
  /** Admin-initiated password reset. */
  password: passwordSchema.optional(),
  /**
   * Monthly download allowance in MB for this account, overriding the server
   * default. Null restores the default; 0 makes this account unlimited.
   */
  monthlyQuotaMb: z.number().int().min(0).max(100_000_000).nullable().optional(),
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
  developer: z.string().trim().max(128).optional(),
  libraryId: z.string().trim().max(64).optional(),
  matchStatus: z.enum(['unmatched', 'auto', 'manual', 'skipped']).optional(),
  /**
   * Narrows to entries missing something — no launch executable, no cloud-save
   * rule, no artwork. This is the admin catalog's "what still needs work"
   * filter, and it is a server-side condition rather than a client-side sift so
   * it stays correct across pagination.
   */
  missing: z.enum(CATALOG_GAP).optional(),
  favoritesOnly: z.coerce.boolean().optional(),
  /** Restrict to games the caller has added (Library) or excluded them (Store). */
  scope: z.enum(['all', 'library', 'not-in-library']).default('all'),
  /** Narrows to one of the caller's own groups. */
  collectionId: z.string().trim().max(64).optional(),
  includeMissing: z.coerce.boolean().default(false),
  /** Only entries whose source files disappeared since the last library scan. */
  missingFilesOnly: z.coerce.boolean().default(false),
  sort: z
    .enum(['title', 'added', 'released', 'size', 'rating', 'played', 'playtime'])
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
  tagline: z.string().trim().max(200).optional(),
  allowSelfRegistration: z.boolean().optional(),
  downloadUrl: z.string().trim().url().max(500).nullable().optional().or(z.literal('')),
  clientVersion: z.string().trim().max(32).nullable().optional(),
  igdbClientId: z.string().trim().max(200).nullable().optional(),
  igdbClientSecret: z.string().trim().max(200).nullable().optional(),
  steamGridDbKey: z.string().trim().max(200).nullable().optional(),
  steamApiKey: z.string().trim().max(200).nullable().optional(),
  /** Ceiling on one download stream, in KB/s. 0 disables the limit. */
  downloadSpeedLimitKbps: z.number().int().min(0).max(10_000_000).optional(),
  /** Default monthly transfer allowance per account, in MB. 0 disables it. */
  monthlyQuotaMb: z.number().int().min(0).max(100_000_000).optional(),
  /** Whether clients may fetch game data from mesh nodes rather than the origin. */
  meshEnabled: z.boolean().optional(),
  /** Whether clients may serve chunks they hold to other clients. */
  meshSeedingEnabled: z.boolean().optional(),
});
export type ProviderSettingsInput = z.infer<typeof providerSettingsSchema>;

/* ---------------------------------------------------------------------- mesh */

/**
 * An address a node believes it might be reachable on.
 *
 * Validated tightly because these come from an agent and are fed to a
 * connection attempt: a hostname here would mean the coordinator resolving
 * names on a node's say-so, so only literals are accepted.
 */
export const meshEndpointSchema = z.object({
  kind: z.enum(MESH_ENDPOINT_KINDS),
  address: z.string().trim().min(2).max(45),
  port: z.number().int().min(1).max(65_535),
});

export const meshRegisterSchema = z.object({
  enrolmentToken: z.string().trim().min(8).max(200),
  publicKey: z.string().trim().min(32).max(200),
  agentVersion: z.string().trim().max(64).optional(),
  endpoints: z.array(meshEndpointSchema).max(16).default([]),
});
export type MeshRegisterInput = z.infer<typeof meshRegisterSchema>;

export const meshHeartbeatSchema = z.object({
  endpoints: z.array(meshEndpointSchema).max(16).default([]),
  /**
   * What this node currently holds. Capped because a heartbeat is a small,
   * frequent message and a node with a large library should send its catalog
   * in one and then stop repeating it in full.
   */
  games: z
    .array(
      z.object({
        gameId: z.string().trim().min(1).max(64),
        contentHash: z.string().trim().length(64),
      }),
    )
    .max(5_000)
    .optional(),
});
export type MeshHeartbeatInput = z.infer<typeof meshHeartbeatSchema>;

/**
 * The candidate addresses a client offers when asking where a game is.
 *
 * Its reflexive address is the one that matters: a node has to punch toward the
 * external address of the client's *UDP* socket, and the coordinator can only
 * see where its TCP request came from — a different mapping, on a different
 * port.
 */
export const meshResolveSchema = z.object({
  endpoints: z.array(meshEndpointSchema).max(8).default([]),
});
export type MeshResolveInput = z.infer<typeof meshResolveSchema>;

export const meshReportSchema = z.object({
  nonce: z.string().trim().min(4).max(64),
  bytesServed: z.number().int().min(0),
});
export type MeshReportInput = z.infer<typeof meshReportSchema>;

export const meshEnrolmentSchema = z.object({
  label: z.string().trim().min(1).max(64),
  role: z.enum(['origin', 'mirror']),
});
export type MeshEnrolmentInput = z.infer<typeof meshEnrolmentSchema>;

export const meshPeerRegisterSchema = z.object({
  publicKey: z.string().trim().min(32).max(200),
  label: z.string().trim().min(1).max(64),
  endpoints: z.array(meshEndpointSchema).max(16).default([]),
  agentVersion: z.string().trim().max(64).optional(),
});
export type MeshPeerRegisterInput = z.infer<typeof meshPeerRegisterSchema>;

/* ------------------------------------------------------------------ profiles */

/** Hex color used as the profile accent throughout the desktop client. */
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color such as #7c5cff');

/** How many labelled links a profile may carry. */
export const MAX_PROFILE_LINKS = 5;

/**
 * One link on a profile.
 *
 * The scheme is checked rather than trusted: this string ends up in an
 * `href`, and `javascript:` there is a script somebody else wrote running on
 * the page of whoever opened their profile.
 */
export const profileLinkSchema = z.object({
  label: z.string().trim().min(1).max(24),
  url: z
    .string()
    .trim()
    .max(300)
    .refine((value) => /^https?:\/\//i.test(value), 'A link has to start with http:// or https://'),
});
export type ProfileLinkInput = z.infer<typeof profileLinkSchema>;

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(48).optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  accentColor: hexColor.optional(),
  country: z.string().trim().max(2).nullable().optional(),
  visibility: z.enum(VISIBILITY).optional(),
  showActivity: z.boolean().optional(),
  avatarMediaId: z.string().trim().max(64).nullable().optional(),
  bannerMediaId: z.string().trim().max(64).nullable().optional(),
  pronouns: z.string().trim().max(32).nullable().optional(),
  tagline: z.string().trim().max(80).nullable().optional(),
  /** Where the banner is cropped, as a percentage down the source image. */
  bannerPosition: z.coerce.number().int().min(0).max(100).optional(),
  links: z.array(profileLinkSchema).max(MAX_PROFILE_LINKS).nullable().optional(),
  favoriteGameId: z.string().trim().max(64).nullable().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/* ------------------------------------------------------------------- friends */

export const friendRequestSchema = z.object({
  /** Either side may be given; the server resolves whichever is present. */
  userId: z.string().trim().max(64).optional(),
  username: usernameSchema.optional(),
});
export type FriendRequestInput = z.infer<typeof friendRequestSchema>;

export const friendSearchSchema = z.object({
  query: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type FriendSearchInput = z.infer<typeof friendSearchSchema>;

/** Browsing every member on the server, rather than searching for one by name. */
export const memberQuerySchema = z.object({
  query: z.string().trim().max(64).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});
export type MemberQuery = z.infer<typeof memberQuerySchema>;

/* -------------------------------------------------------------------- social */

export const createPostSchema = z
  .object({
    kind: z.enum(POST_KIND).default('text'),
    title: z.string().trim().max(120).nullable().optional(),
    body: z.string().trim().max(8000).nullable().optional(),
    gameId: z.string().trim().max(64).nullable().optional(),
    visibility: z.enum(VISIBILITY).default('friends'),
    mediaIds: z.array(z.string().trim().max(64)).max(8).default([]),
  })
  .refine((v) => Boolean(v.body?.trim()) || v.mediaIds.length > 0, {
    message: 'Write something or attach a screenshot or clip',
    path: ['body'],
  });
export type CreatePostInput = z.infer<typeof createPostSchema>;

export const updatePostSchema = z.object({
  title: z.string().trim().max(120).nullable().optional(),
  body: z.string().trim().max(8000).nullable().optional(),
  visibility: z.enum(VISIBILITY).optional(),
});
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1, 'Write a comment').max(2000),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const reactionSchema = z.object({
  /** Null clears the caller's existing reaction. */
  reaction: z.enum(REACTIONS).nullable(),
});
export type ReactionInput = z.infer<typeof reactionSchema>;

export const feedQuerySchema = z.object({
  scope: z.enum(['friends', 'mine', 'everyone']).default('friends'),
  /** One kind, or `not-announcement` to read the ordinary feed without them. */
  kind: z.enum([...POST_KIND, 'not-announcement']).optional(),
  gameId: z.string().trim().max(64).optional(),
  before: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/* --------------------------------------------------------------------- media */

export const mediaUploadSchema = z.object({
  kind: z.enum(['avatar', 'banner', 'image', 'clip']),
  contentType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().min(1),
  width: z.number().int().min(1).max(16_384).nullable().optional(),
  height: z.number().int().min(1).max(16_384).nullable().optional(),
  durationMs: z.number().int().min(0).nullable().optional(),
});
export type MediaUploadInput = z.infer<typeof mediaUploadSchema>;

/** Rejects an upload before a byte is written when it is obviously too large. */
export function maxBytesForMedia(kind: MediaUploadInput['kind']): number {
  return kind === 'clip' ? MAX_CLIP_BYTES : MAX_IMAGE_BYTES;
}

/* ---------------------------------------------------------------- play time */

export const startPlaySessionSchema = z.object({
  gameId: z.string().trim().min(1).max(64),
  /**
   * Whether this machine publishes what is being played.
   *
   * Per session rather than per account, because the client's switch is a
   * per-machine one: someone can be quiet on a work laptop and visible on the
   * machine in the front room. Absent from an older client, which means yes.
   */
  shareActivity: z.boolean().default(true),
});
export type StartPlaySessionInput = z.infer<typeof startPlaySessionSchema>;

export const endPlaySessionSchema = z.object({
  /** Client-measured duration; the server clamps it to wall-clock elapsed time. */
  seconds: z.number().int().min(0).max(86_400),
});
export type EndPlaySessionInput = z.infer<typeof endPlaySessionSchema>;

export const presenceSchema = z.object({
  status: z.enum(PRESENCE_STATUS),
  gameId: z.string().trim().max(64).nullable().optional(),
});
export type PresenceInput = z.infer<typeof presenceSchema>;

/* -------------------------------------------------------------- achievements */

export const unlockAchievementSchema = z.object({
  /** The provider key, so clients never need the internal row id. */
  key: z.string().trim().min(1).max(190),
  progress: z.number().int().min(0).max(100).nullable().optional(),
});
export type UnlockAchievementInput = z.infer<typeof unlockAchievementSchema>;

export const achievementDefinitionSchema = z.object({
  key: z.string().trim().min(1).max(190),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  iconUrl: z.string().trim().url().max(1000).nullable().optional().or(z.literal('')),
  points: z.number().int().min(0).max(1000).default(10),
  hidden: z.boolean().default(false),
  globalPercent: z.number().min(0).max(100).nullable().optional(),
  source: z.enum(ACHIEVEMENT_SOURCE).default('manual'),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type AchievementDefinitionInput = z.infer<typeof achievementDefinitionSchema>;

export const importAchievementsSchema = z.object({
  /** Steam app id whose public achievement schema should be imported. */
  steamAppId: z.number().int().positive(),
  /** Wipe existing definitions for the game instead of merging by key. */
  replace: z.boolean().default(false),
});
export type ImportAchievementsInput = z.infer<typeof importAchievementsSchema>;

/** Whether an automatic Steam import replaces previously imported Steam entries. */
export const autoImportAchievementsSchema = z.object({
  replace: z.boolean().default(false),
});
export type AutoImportAchievementsInput = z.infer<typeof autoImportAchievementsSchema>;

/**
 * How many games one bulk-import request may carry.
 *
 * Deliberately small. Every game in the batch is two or three round trips to
 * Steam, so a request covering a whole catalog would sit open for minutes,
 * report nothing on the way, and lose everything if the connection dropped.
 * The client sends batches of this size and shows progress between them, which
 * also gives it somewhere to put a Stop button.
 */
export const BULK_ACHIEVEMENT_BATCH = 8;

/** One slice of a bulk achievement import. */
export const bulkImportAchievementsSchema = z.object({
  gameIds: z.array(z.string().trim().min(1).max(64)).min(1).max(BULK_ACHIEVEMENT_BATCH),
  /** Wipe previously imported Steam entries instead of merging by key. */
  replace: z.boolean().default(false),
  /** Also write the unlock rules, without which an imported list never fires. */
  generateRules: z.boolean().default(true),
  /** Skip a game that already has achievements rather than re-importing it. */
  skipExisting: z.boolean().default(true),
});
export type BulkImportAchievementsInput = z.infer<typeof bulkImportAchievementsSchema>;

/** What became of one game in a bulk import. */
export interface BulkImportResult {
  gameId: string;
  title: string;
  status: 'imported' | 'skipped' | 'failed';
  steamAppId: number | null;
  imported: number;
  /** Rules written, or null when rule generation was not asked for or could not run. */
  rules: number | null;
  /** Always set — for a success it says what happened, for a failure why not. */
  message: string;
}

/** Many definitions written to one game at once, from a pasted list. */
export const bulkAchievementDefinitionsSchema = z.object({
  achievements: z.array(achievementDefinitionSchema).min(1).max(2000),
  /** Wipe every existing definition for the game first. */
  replace: z.boolean().default(false),
});
export type BulkAchievementDefinitionsInput = z.infer<typeof bulkAchievementDefinitionsSchema>;

/* ---------------------------------------------------------------- cloud saves */

export const saveSlotSchema = z.object({
  gameId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(64).default('default'),
});
export type SaveSlotInput = z.infer<typeof saveSlotSchema>;

export const saveUploadSchema = z.object({
  gameId: z.string().trim().min(1).max(64),
  slotName: z.string().trim().min(1).max(64).default('default'),
  sha256: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, 'Expected a hex SHA-256 digest'),
  sizeBytes: z.number().int().min(1),
  fileCount: z.number().int().min(1).max(100_000),
  capturedAt: z.string().trim().min(1).max(40),
  /** Digest the client last synced, so the server can detect a conflict. */
  baseSha256: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
  /** Set once the user has picked a side in a conflict prompt. */
  force: z.boolean().default(false),
});
export type SaveUploadInput = z.infer<typeof saveUploadSchema>;

export const saveRuleSchema = z.object({
  pathTemplate: z.string().trim().min(1).max(500),
  include: z.string().trim().max(500).nullable().optional(),
  exclude: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});
export type SaveRuleInput = z.infer<typeof saveRuleSchema>;

export const launchRuleSchema = z.object({
  executable: z.string().trim().max(500).nullable().optional(),
  args: z.string().trim().max(500).nullable().optional(),
  workingDir: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});
export type LaunchRuleInput = z.infer<typeof launchRuleSchema>;

/* ------------------------------------------------------------------ featured */

export const featuredSchema = z.object({
  gameId: z.string().trim().min(1).max(64),
  headline: z.string().trim().max(120).nullable().optional(),
  blurb: z.string().trim().max(400).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});
export type FeaturedInput = z.infer<typeof featuredSchema>;

export const reorderFeaturedSchema = z.object({
  /** Ids in their new display order. */
  ids: z.array(z.string().trim().max(64)).max(50),
});
export type ReorderFeaturedInput = z.infer<typeof reorderFeaturedSchema>;

/* --------------------------------------------------- admin metadata editing */

/**
 * Every field is optional so the editor can send only what changed. Explicit
 * nulls clear a value, which is why these are nullable rather than just absent.
 */
export const editGameSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  sortTitle: z.string().trim().max(300).nullable().optional(),
  summary: z.string().trim().max(8000).nullable().optional(),
  storyline: z.string().trim().max(8000).nullable().optional(),
  releaseDate: z.string().trim().max(40).nullable().optional(),
  rating: z.number().int().min(0).max(100).nullable().optional(),
  developers: z.array(z.string().trim().max(120)).max(30).nullable().optional(),
  publishers: z.array(z.string().trim().max(120)).max(30).nullable().optional(),
  genres: z.array(z.string().trim().max(60)).max(30).nullable().optional(),
  platforms: z.array(z.string().trim().max(60)).max(30).nullable().optional(),
  screenshots: z.array(z.string().trim().url().max(1000)).max(30).nullable().optional(),
  videos: z.array(z.string().trim().max(200)).max(20).nullable().optional(),
  steamAppId: z.number().int().positive().nullable().optional(),
  /** Marks the entry as hand-curated so a rescan will not overwrite it. */
  matchStatus: z.enum(['unmatched', 'auto', 'manual', 'skipped']).optional(),
});
export type EditGameInput = z.infer<typeof editGameSchema>;

/** Browses provider artwork for one slot before anything is applied. */
export const artworkSearchSchema = z.object({
  kind: z.enum(ART_KIND),
  query: z.string().trim().min(1).max(200),
  /** SteamGridDB style filter, e.g. `white` for a text-only wordmark. */
  style: z.string().trim().max(40).nullable().optional(),
});
export type ArtworkSearchInput = z.infer<typeof artworkSearchSchema>;

/** Replaces one artwork slot with an arbitrary URL the admin supplies. */
export const setArtworkSchema = z.object({
  kind: z.enum(ART_KIND),
  url: z.string().trim().url().max(1000).nullable(),
});
export type SetArtworkInput = z.infer<typeof setArtworkSchema>;

/** Appends one screenshot, downloaded into the local cache before it is stored. */
export const setScreenshotSchema = z.object({
  url: z.string().trim().url().max(1000),
});
export type SetScreenshotInput = z.infer<typeof setScreenshotSchema>;

/**
 * Overrides the hero image of one carousel slot. Separate from `featuredSchema`
 * because the URL has to be downloaded into the local cache before it can be
 * stored, which the plain upsert has no business doing.
 */
export const featuredArtworkSchema = z.object({
  url: z.string().trim().url().max(1000).nullable(),
});
export type FeaturedArtworkInput = z.infer<typeof featuredArtworkSchema>;

/* ------------------------------------------------------------------- theming */

export const themeSettingsSchema = z.object({
  preset: z.enum(THEME_PRESETS),
  /** Null uses the preset's own accent. */
  accent: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #2bb7f5')
    .nullable()
    .optional(),
});
export type ThemeSettingsInput = z.infer<typeof themeSettingsSchema>;

/* ----------------------------------------------------------------- api keys */

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name the key so you can recognise it later').max(60),
  scopes: z.array(z.enum(API_SCOPES)).min(1, 'Pick at least one permission'),
  /** Null means it never expires; an integration key usually should. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(365),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/* ------------------------------------------------- the external v1 API */

/**
 * Provisioning an account from outside.
 *
 * The password is optional: an external service creating accounts in bulk
 * usually wants the server to generate one and hand it back, rather than
 * inventing (and having to transmit) its own.
 */
export const apiCreateUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema.optional(),
  email: emailSchema.nullable().optional(),
  role: z.enum(ROLES).default('user'),
});
export type ApiCreateUserInput = z.infer<typeof apiCreateUserSchema>;

export const apiUpdateUserSchema = z.object({
  email: emailSchema.nullable().optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
});
export type ApiUpdateUserInput = z.infer<typeof apiUpdateUserSchema>;

export const apiListUsersSchema = z.object({
  query: z.string().trim().max(64).optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.coerce.boolean().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ApiListUsersQuery = z.infer<typeof apiListUsersSchema>;

/* ------------------------------------------------- desktop client buttons */

/**
 * An operator-defined link shown in the desktop client.
 *
 * The URL is restricted to http(s) rather than accepting any scheme: the
 * client hands it to the OS opener, and a `file:` or custom-scheme URL pushed
 * from the server would be a way to make every player's machine launch
 * something local.
 */
export const clientButtonSchema = z.object({
  label: z.string().trim().min(1, 'Give the button a label').max(40),
  url: z
    .string()
    .trim()
    .url('Enter a full URL, including https://')
    .max(500)
    .refine((value) => /^https?:\/\//i.test(value), 'Only http and https links are allowed'),
  icon: z.enum(CLIENT_BUTTON_ICONS).default('link'),
  placement: z.enum(CLIENT_BUTTON_PLACEMENT).default('sidebar'),
  description: z.string().trim().max(160).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});
export type ClientButtonInput = z.infer<typeof clientButtonSchema>;

export const reorderClientButtonsSchema = z.object({
  ids: z.array(z.string().trim().max(64)).max(50),
});
export type ReorderClientButtonsInput = z.infer<typeof reorderClientButtonsSchema>;

/* --------------------------------------------------- linking local installs */

/**
 * Folder names found on a player's machine, matched against catalog titles so
 * an already-installed copy can be linked instead of downloaded again.
 *
 * Matching runs on the server because that is where the title-normalisation
 * and similarity scoring already live; duplicating them in the client is how
 * the two drift into disagreeing about what counts as a match.
 */
export const matchLocalSchema = z.object({
  names: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  /** Below this similarity a suggestion is noise rather than a candidate. */
  threshold: z.number().min(0).max(1).default(0.5),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
export type MatchLocalInput = z.infer<typeof matchLocalSchema>;

export const announcementSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(2000).nullable().optional(),
  /** A short emoji, e.g. "🎉" — kept as plain text; no icon upload pipeline. */
  icon: z.string().trim().max(8).nullable().optional(),
  /** Empty targets everyone. */
  userIds: z.array(z.string().trim().max(64)).max(500).default([]),
  /**
   * Also publish it to the News page, where it stays and can be replied to.
   *
   * On by default: a notification is read once and gone, which is the whole
   * reason announcements felt like they went nowhere. Turned off for the
   * genuinely transient ones ("back up in five minutes"), and forced off when
   * the announcement is aimed at named accounts rather than everyone — a
   * public page is the wrong place for a message to three people.
   */
  publish: z.boolean().default(true),
});
export type AnnouncementInput = z.infer<typeof announcementSchema>;

/** Confirmed save-path suggestions, as the operator saw them on screen. */
export const applySaveSuggestionsSchema = z.object({
  rules: z
    .array(
      z.object({
        gameId: z.string().trim().min(1).max(64),
        pathTemplate: z.string().trim().min(1).max(500),
        include: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(2000),
});
export type ApplySaveSuggestionsInput = z.infer<typeof applySaveSuggestionsSchema>;

/** One achievement rule, as an administrator writes it. */
export const achievementRuleSchema = z.object({
  achievementKey: z.string().trim().min(1).max(120),
  sourceTemplate: z.string().trim().min(1).max(500),
  format: z.enum(ACHIEVEMENT_FORMATS),
  selector: z.string().trim().min(1).max(300),
  comparator: z.enum(ACHIEVEMENT_COMPARATORS),
  value: z.string().trim().max(120).nullable().optional(),
  /** Operator labels, so several rules for one achievement stay tellable apart. */
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});
export type AchievementRuleInput = z.infer<typeof achievementRuleSchema>;

/** A game's rules, replaced wholesale. */
export const achievementRulesSchema = z.object({
  rules: z.array(achievementRuleSchema).max(500),
});
export type AchievementRulesInput = z.infer<typeof achievementRulesSchema>;

/** What the client reports after reading a game's files. */
export const reportUnlocksSchema = z.object({
  keys: z.array(z.string().trim().min(1).max(120)).max(500),
});
export type ReportUnlocksInput = z.infer<typeof reportUnlocksSchema>;

/* -------------------------------------------------------------------- bugs */

/**
 * A bug report, as the reporter sends it.
 *
 * The diagnostics are gathered by the client rather than asked for: a reporter
 * should not have to know their client version, and a report that omits it is
 * one an operator has to go back and ask about.
 */
export const bugReportSchema = z.object({
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(4000),
  severity: z.enum(BUG_SEVERITY),
  /** The game it happened in, when it happened in one. */
  gameId: z.string().trim().max(64).nullable().optional(),
  clientVersion: z.string().trim().max(40).nullable().optional(),
  platform: z.string().trim().max(120).nullable().optional(),
  /** Recent client-side errors, gathered automatically. */
  diagnostics: z.string().trim().max(8000).nullable().optional(),
});
export type BugReportInput = z.infer<typeof bugReportSchema>;

export const bugTriageSchema = z.object({
  status: z.enum(BUG_STATUS),
  /** Shown to the reporter, so "fixed" can say what was fixed. */
  reply: z.string().trim().max(2000).nullable().optional(),
});
export type BugTriageInput = z.infer<typeof bugTriageSchema>;

export const bugQuerySchema = z.object({
  status: z.enum(BUG_STATUS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type BugQuery = z.infer<typeof bugQuerySchema>;

export const scanRequestSchema = z.object({
  libraryId: z.string().trim().max(64).optional(),
  /** Re-read every entry instead of trusting size/mtime. */
  force: z.boolean().default(false),
  /** Look up metadata for newly discovered games. */
  fetchMetadata: z.boolean().default(true),
});
export type ScanRequestInput = z.infer<typeof scanRequestSchema>;

/** Upkeep run from the panel rather than waiting for the hourly one. */
export const databaseMaintenanceSchema = z.object({
  /**
   * Rewrite the file with its pages in order.
   *
   * Off by default because it is the expensive half: it needs room for a
   * second copy of the database on the same disk and holds a write lock for
   * as long as it takes. Worth it after a large deletion, and not otherwise.
   */
  vacuum: z.boolean().default(false),
});
export type DatabaseMaintenanceInput = z.infer<typeof databaseMaintenanceSchema>;

export const purgeMissingSchema = z.object({
  /**
   * Only purge entries missing for at least this long. The default of 0 means
   * "everything currently flagged", which is what someone clicking a button
   * called "remove missing" is asking for; a grace period is available for a
   * scheduled clean-up that should tolerate a share being briefly offline.
   */
  olderThanDays: z.coerce.number().int().min(0).max(3650).default(0),
});
export type PurgeMissingInput = z.infer<typeof purgeMissingSchema>;

/* --------------------------------------------------------- game requests */

/**
 * A player asking for a game to be added.
 *
 * Only a title is required. Anything more structured — a store link, a
 * platform, a version — is guesswork the operator has to check anyway, so the
 * free-text note carries it instead of six fields that are usually blank.
 */
export const createGameRequestSchema = z.object({
  title: z.string().trim().min(2, 'Name the game').max(120),
  note: z.string().trim().max(500).nullable().optional(),
});
export type CreateGameRequestInput = z.infer<typeof createGameRequestSchema>;

export const gameRequestQuerySchema = z.object({
  status: z.enum(GAME_REQUEST_STATUS).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(['votes', 'newest', 'title']).default('votes'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type GameRequestQuery = z.infer<typeof gameRequestQuerySchema>;

/**
 * An operator's decision on a request.
 *
 * `gameId` links a fulfilled request to the catalog entry that satisfied it,
 * which is what lets the client show "you asked for this, here it is" rather
 * than just marking the row done.
 */
export const decideGameRequestSchema = z.object({
  status: z.enum(GAME_REQUEST_STATUS),
  adminNote: z.string().trim().max(500).nullable().optional(),
  gameId: z.string().trim().max(64).nullable().optional(),
});
export type DecideGameRequestInput = z.infer<typeof decideGameRequestSchema>;

/* ----------------------------------------------------------- collections */

export const collectionSchema = z.object({
  name: z.string().trim().min(1, 'Name the group').max(60),
  color: z.enum(COLLECTION_COLORS).default('blade'),
});
export type CollectionInput = z.infer<typeof collectionSchema>;

export const collectionGamesSchema = z.object({
  gameIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
});
export type CollectionGamesInput = z.infer<typeof collectionGamesSchema>;

export const reorderCollectionsSchema = z.object({
  ids: z.array(z.string().trim().max(64)).max(MAX_COLLECTIONS_PER_USER),
});
export type ReorderCollectionsInput = z.infer<typeof reorderCollectionsSchema>;

/* ------------------------------------------------------------------ Discord */

/**
 * The operator's Discord configuration.
 *
 * Secrets are write-only and therefore optional: an omitted one means "leave
 * what is stored alone", which is what lets the form be saved without
 * re-typing a token every time. Clearing one goes through its own route.
 */
export const discordSettingsSchema = z.object({
  clientId: z.string().trim().max(64).optional(),
  clientSecret: z.string().trim().max(200).optional(),
  botToken: z.string().trim().max(200).optional(),
  guildId: z.string().trim().max(64).optional(),
  inviteUrl: z.string().trim().max(400).optional(),
  channelId: z.string().trim().max(64).optional(),
  publicUrl: z.string().trim().max(400).optional(),
  announceNewGames: z.boolean().optional(),
  announceRequests: z.boolean().optional(),
  requireGuild: z.boolean().optional(),
});
export type DiscordSettingsInput = z.infer<typeof discordSettingsSchema>;

/** Roles handed out automatically, either on join or on a reaction. */
export const discordRoleSettingsSchema = z.object({
  /** Empty string clears it; the privileged Members intent goes with it. */
  autoRoleId: z.string().trim().max(64).optional(),
  reactionRolesEnabled: z.boolean().optional(),
});
export type DiscordRoleSettingsInput = z.infer<typeof discordRoleSettingsSchema>;

/** One emoji on one message, granting one role. */
export const discordReactionRoleSchema = z.object({
  channelId: z.string().trim().min(1).max(64),
  messageId: z.string().trim().min(1).max(64),
  /**
   * A bare unicode character, or `name:id` for a custom emoji — the shape the
   * gateway reports, so the comparison at dispatch time is a string equality.
   */
  emoji: z.string().trim().min(1).max(100),
  roleId: z.string().trim().min(1).max(64),
  note: z.string().trim().max(200).optional(),
});
export type DiscordReactionRoleInput = z.infer<typeof discordReactionRoleSchema>;

/** A post the operator is sending to the Discord by hand. */
export const discordAnnounceSchema = z.object({
  title: z.string().trim().max(200).default(''),
  /**
   * Optional once an image can carry the post on its own — a screenshot with
   * no caption is a perfectly ordinary announcement.
   */
  message: z.string().trim().max(1800).default(''),
  /** An embed reads as the server speaking; plain text reads as a person. */
  asEmbed: z.boolean().default(true),
  /** Where it goes. Blank uses the configured announcement channel. */
  channelId: z.string().trim().max(64).optional(),
  /** A media id already uploaded to this server, attached to the message. */
  imageMediaId: z.string().trim().max(64).optional(),
  /**
   * Repeat the embed's mentions above it, so they actually notify.
   *
   * Discord renders `<@&id>` inside an embed as a role pill and notifies
   * nobody — that is its rule, not a formatting mistake. The only way an
   * embed addressed to a role reaches that role is a content line carrying
   * the same tokens, which is what this asks for. Meaningless without an
   * embed, and ignored there: plain content already notifies.
   */
  pingMentions: z.boolean().default(true),
  /**
   * Permit `@everyone` and `@here`.
   *
   * Off unless asked for, and separate from the mentions above, because it is
   * the one mention nobody should be able to send by accident.
   */
  allowEveryone: z.boolean().default(false),
});
export type DiscordAnnounceInput = z.infer<typeof discordAnnounceSchema>;

/** How the bot presents itself in the member list. */
export const discordPresenceSchema = z.object({
  status: z.enum(DISCORD_PRESENCE_STATUS).optional(),
  activityType: z
    .number()
    .int()
    .refine((value): value is DiscordActivityType =>
      (DISCORD_ACTIVITY_TYPES as readonly number[]).includes(value),
    )
    .optional(),
  /** Blank means no activity line at all, just the coloured dot. */
  activityName: z.string().trim().max(128).optional(),
});
export type DiscordPresenceInput = z.infer<typeof discordPresenceSchema>;

/** Everything the ticket system needs to know about this server. */
export const discordTicketSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  supportChannelId: z.string().trim().max(64).optional(),
  categoryId: z.string().trim().max(64).optional(),
  staffRoleId: z.string().trim().max(64).optional(),
  panelTitle: z.string().trim().max(200).optional(),
  panelMessage: z.string().trim().max(1500).optional(),
});
export type DiscordTicketSettingsInput = z.infer<typeof discordTicketSettingsSchema>;
