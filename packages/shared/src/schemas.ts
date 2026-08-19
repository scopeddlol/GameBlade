import { z } from 'zod';
import {
  ACHIEVEMENT_SOURCE,
  ART_KIND,
  CATALOG_GAP,
  CLIENT_BUTTON_ICONS,
  CLIENT_BUTTON_PLACEMENT,
  MAX_CLIP_BYTES,
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
  includeMissing: z.coerce.boolean().default(false),
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
});
export type ProviderSettingsInput = z.infer<typeof providerSettingsSchema>;

/* ------------------------------------------------------------------ profiles */

/** Hex color used as the profile accent throughout the desktop client. */
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color such as #7c5cff');

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(48).optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  accentColor: hexColor.optional(),
  country: z.string().trim().max(2).nullable().optional(),
  visibility: z.enum(VISIBILITY).optional(),
  showActivity: z.boolean().optional(),
  avatarMediaId: z.string().trim().max(64).nullable().optional(),
  bannerMediaId: z.string().trim().max(64).nullable().optional(),
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
});
export type AnnouncementInput = z.infer<typeof announcementSchema>;

export const scanRequestSchema = z.object({
  libraryId: z.string().trim().max(64).optional(),
  /** Re-read every entry instead of trusting size/mtime. */
  force: z.boolean().default(false),
  /** Look up metadata for newly discovered games. */
  fetchMetadata: z.boolean().default(true),
});
export type ScanRequestInput = z.infer<typeof scanRequestSchema>;

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
