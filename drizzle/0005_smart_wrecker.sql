CREATE TABLE "legacy_adoptions" (
	"setlist_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_adoptions" ADD CONSTRAINT "legacy_adoptions_setlist_id_libraries_id_fk" FOREIGN KEY ("setlist_id") REFERENCES "public"."libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_adoptions" ADD CONSTRAINT "legacy_adoptions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;