CREATE TABLE "setlist_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"setlist_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"role" varchar(6) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	CONSTRAINT "setlist_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitation_role_valid" CHECK ("setlist_invitations"."role" in ('editor','viewer'))
);
--> statement-breakpoint
CREATE TABLE "setlist_memberships" (
	"setlist_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_role_valid" CHECK ("setlist_memberships"."role" in ('owner','editor','viewer'))
);
--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "title" varchar(200) DEFAULT 'Мой сет-лист' NOT NULL;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "setlist_invitations" ADD CONSTRAINT "setlist_invitations_setlist_id_libraries_id_fk" FOREIGN KEY ("setlist_id") REFERENCES "public"."libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setlist_memberships" ADD CONSTRAINT "setlist_memberships_setlist_id_libraries_id_fk" FOREIGN KEY ("setlist_id") REFERENCES "public"."libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setlist_memberships" ADD CONSTRAINT "setlist_memberships_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "setlist_membership_identity" ON "setlist_memberships" USING btree ("setlist_id","user_id");