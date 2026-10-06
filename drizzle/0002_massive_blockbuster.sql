DROP INDEX "one_audio_per_song";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "filename" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "one_audio_per_song" ON "attachments" USING btree ("song_id") WHERE "attachments"."kind" = 'audio' and "attachments"."deleted_at" is null;