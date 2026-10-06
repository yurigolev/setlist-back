import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const LIBRARY_ID = '00000000-0000-4000-8000-000000000001'

export const libraries = pgTable('libraries', {
  id: uuid('id').primaryKey(),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [check('library_revision_nonnegative', sql`${table.revision} >= 0`)])

export const songs = pgTable('songs', {
  id: uuid('id').primaryKey(),
  libraryId: uuid('library_id').notNull().references(() => libraries.id),
  title: varchar('title', { length: 200 }).notNull(),
  artist: varchar('artist', { length: 200 }).notNull(),
  notes: text('notes').notNull().default(''),
  revision: integer('revision').notNull().default(1),
  createKey: varchar('create_key', { length: 200 }).notNull(),
  createHash: varchar('create_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  check('song_revision_positive', sql`${table.revision} > 0`),
  uniqueIndex('songs_library_create_key').on(table.libraryId, table.createKey),
  index('songs_library_id').on(table.libraryId),
])

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey(),
  libraryId: uuid('library_id').notNull().references(() => libraries.id),
  songId: uuid('song_id').notNull().references(() => songs.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 8 }).notNull(),
  mimeType: varchar('mime_type', { length: 32 }).notNull(),
  filename: varchar('filename', { length: 255 }).notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  objectKey: text('object_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  check('attachment_kind_valid', sql`${table.kind} in ('image', 'audio')`),
  check('attachment_size_positive', sql`${table.byteSize} > 0`),
  uniqueIndex('one_audio_per_song').on(table.songId).where(sql`${table.kind} = 'audio' and ${table.deletedAt} is null`),
  index('attachments_song_id').on(table.songId),
])
