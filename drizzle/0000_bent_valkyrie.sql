CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"song_id" uuid NOT NULL,
	"kind" varchar(8) NOT NULL,
	"mime_type" varchar(32) NOT NULL,
	"byte_size" bigint NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "attachment_kind_valid" CHECK ("attachments"."kind" in ('image', 'audio')),
	CONSTRAINT "attachment_size_positive" CHECK ("attachments"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_revision_nonnegative" CHECK ("libraries"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "songs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"artist" varchar(200) NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"create_key" varchar(200) NOT NULL,
	"create_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "song_revision_positive" CHECK ("songs"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_song_id_songs_id_fk" FOREIGN KEY ("song_id") REFERENCES "public"."songs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "songs" ADD CONSTRAINT "songs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_audio_per_song" ON "attachments" USING btree ("song_id") WHERE "attachments"."kind" = 'audio';--> statement-breakpoint
CREATE INDEX "attachments_song_id" ON "attachments" USING btree ("song_id");--> statement-breakpoint
CREATE UNIQUE INDEX "songs_library_create_key" ON "songs" USING btree ("library_id","create_key");--> statement-breakpoint
CREATE INDEX "songs_library_id" ON "songs" USING btree ("library_id");
--> statement-breakpoint
INSERT INTO "libraries" ("id", "revision") VALUES ('00000000-0000-4000-8000-000000000001', 0);
