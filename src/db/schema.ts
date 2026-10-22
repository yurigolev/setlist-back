import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const LIBRARY_ID = '00000000-0000-4000-8000-000000000001';

export const libraries = pgTable(
  'libraries',
  {
    id: uuid('id').primaryKey(),
    title: varchar('title', { length: 200 }).notNull().default('Мой сет-лист'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('library_revision_nonnegative', sql`${table.revision} >= 0`)],
);

export const songs = pgTable(
  'songs',
  {
    id: uuid('id').primaryKey(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id),
    title: varchar('title', { length: 200 }).notNull(),
    artist: varchar('artist', { length: 200 }).notNull(),
    notes: text('notes').notNull().default(''),
    revision: integer('revision').notNull().default(1),
    createKey: varchar('create_key', { length: 200 }).notNull(),
    createHash: varchar('create_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    check('song_revision_positive', sql`${table.revision} > 0`),
    uniqueIndex('songs_library_create_key').on(table.libraryId, table.createKey),
    index('songs_library_id').on(table.libraryId),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id),
    songId: uuid('song_id')
      .notNull()
      .references(() => songs.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 8 }).notNull(),
    mimeType: varchar('mime_type', { length: 32 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    checksum: varchar('checksum', { length: 64 }).notNull(),
    objectKey: text('object_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    check('attachment_kind_valid', sql`${table.kind} in ('image', 'audio')`),
    check('attachment_size_positive', sql`${table.byteSize} > 0`),
    uniqueIndex('one_audio_per_song')
      .on(table.songId)
      .where(sql`${table.kind} = 'audio' and ${table.deletedAt} is null`),
    index('attachments_song_id').on(table.songId),
  ],
);

export const authUsers = pgTable(
  'auth_users',
  {
    id: uuid('id').primaryKey(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    username: varchar('username', { length: 200 }),
    picture: text('picture'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('auth_users_identity').on(table.issuer, table.subject)],
);

export const authRefreshFamilies = pgTable(
  'auth_refresh_families',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    csrfToken: varchar('csrf_token', { length: 43 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('auth_refresh_families_expires_at').on(table.expiresAt)],
);

export const authRefreshTokens = pgTable(
  'auth_refresh_tokens',
  {
    tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => authRefreshFamilies.id, { onDelete: 'cascade' }),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [index('auth_refresh_tokens_family_id').on(table.familyId)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
    familyId: uuid('family_id').references(() => authRefreshFamilies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    csrfToken: varchar('csrf_token', { length: 43 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_sessions_user_id').on(table.userId),
    index('auth_sessions_expires_at').on(table.expiresAt),
  ],
);

export const authLoginAttempts = pgTable(
  'auth_login_attempts',
  {
    stateHash: varchar('state_hash', { length: 64 }).primaryKey(),
    browserHash: varchar('browser_hash', { length: 64 }).notNull(),
    verifier: varchar('verifier', { length: 43 }).notNull(),
    nonce: varchar('nonce', { length: 43 }).notNull(),
    returnTo: text('return_to').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('auth_login_attempts_expires_at').on(table.expiresAt)],
);

export const memberships = pgTable(
  'setlist_memberships',
  {
    setlistId: uuid('setlist_id')
      .notNull()
      .references(() => libraries.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id),
    role: varchar('role', { length: 6 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('setlist_membership_identity').on(table.setlistId, table.userId),
    check('membership_role_valid', sql`${table.role} in ('owner','editor','viewer')`),
  ],
);
export const invitations = pgTable(
  'setlist_invitations',
  {
    id: uuid('id').primaryKey(),
    setlistId: uuid('setlist_id')
      .notNull()
      .references(() => libraries.id),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    role: varchar('role', { length: 6 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [check('invitation_role_valid', sql`${table.role} in ('editor','viewer')`)],
);

export const legacyAdoptions = pgTable('legacy_adoptions', {
  setlistId: uuid('setlist_id')
    .primaryKey()
    .references(() => libraries.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => authUsers.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
