CREATE TABLE "auth_refresh_families" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" varchar(43) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_refresh_tokens" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_refresh_families" ADD CONSTRAINT "auth_refresh_families_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_refresh_tokens" ADD CONSTRAINT "auth_refresh_tokens_family_id_auth_refresh_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."auth_refresh_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_refresh_families_expires_at" ON "auth_refresh_families" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_refresh_tokens_family_id" ON "auth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_family_id_auth_refresh_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."auth_refresh_families"("id") ON DELETE cascade ON UPDATE no action;