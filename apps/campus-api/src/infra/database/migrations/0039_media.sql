CREATE TYPE "public"."media_bucket" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('avatar');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('pending', 'ready', 'removed', 'purged');--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "media_kind" NOT NULL,
	"bucket" "media_bucket" NOT NULL,
	"upload_key" varchar(512) NOT NULL,
	"key" varchar(512),
	"uploaded_by" uuid NOT NULL,
	"content_type" varchar(128) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" "media_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "media_size_positive" CHECK ("media"."size_bytes" > 0),
	CONSTRAINT "media_verified_has_key" CHECK ("media"."verified_at" is null or "media"."key" is not null),
	CONSTRAINT "media_status_dates" CHECK (("media"."status" <> 'ready' or ("media"."ready_at" is not null and "media"."verified_at" is not null))
        and ("media"."status" <> 'removed' or "media"."removed_at" is not null)
        and ("media"."status" <> 'purged' or "media"."purged_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_upload_key_unique" ON "media" USING btree ("upload_key");--> statement-breakpoint
CREATE UNIQUE INDEX "media_key_unique" ON "media" USING btree ("key");--> statement-breakpoint
CREATE INDEX "media_pending_idx" ON "media" USING btree ("uploaded_by","created_at") WHERE "media"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "media_purge_idx" ON "media" USING btree ("purge_after") WHERE "media"."status" = 'removed';