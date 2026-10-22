ALTER TABLE "setlist_invitations" ALTER COLUMN "expires_at" DROP NOT NULL;
UPDATE "setlist_invitations" SET "expires_at" = NULL;
