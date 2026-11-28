ALTER TABLE "maps" ADD COLUMN "synced_version" text;--> statement-breakpoint
ALTER TABLE "maps" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maps" ADD COLUMN "published_version" text;