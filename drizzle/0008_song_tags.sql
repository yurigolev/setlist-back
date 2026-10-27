CREATE TABLE "song_tags" (
	"library_id" uuid NOT NULL,
	"song_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "song_tags_library_id_song_id_tag_id_pk" PRIMARY KEY("library_id","song_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"name" varchar(40) NOT NULL,
	"normalized_name" text NOT NULL,
	CONSTRAINT "tag_name_length" CHECK (char_length("tags"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tags_library_name" ON "tags" USING btree ("library_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_library_identity" ON "tags" USING btree ("library_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "songs_library_identity" ON "songs" USING btree ("library_id","id");--> statement-breakpoint
ALTER TABLE "song_tags" ADD CONSTRAINT "song_tags_song_fk" FOREIGN KEY ("library_id","song_id") REFERENCES "public"."songs"("library_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_tags" ADD CONSTRAINT "song_tags_tag_fk" FOREIGN KEY ("library_id","tag_id") REFERENCES "public"."tags"("library_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "song_tags_library_tag" ON "song_tags" USING btree ("library_id","tag_id");
