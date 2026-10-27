ALTER TABLE "tags" ADD COLUMN "color" varchar(7);--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tag_color_hex" CHECK ("tags"."color" ~ '^#[0-9A-F]{6}$');