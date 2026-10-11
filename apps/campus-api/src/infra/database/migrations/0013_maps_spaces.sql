CREATE TYPE "public"."audio_mode" AS ENUM('proximity', 'boundary', 'broadcast');--> statement-breakpoint
CREATE TYPE "public"."outsider_visibility" AS ENUM('hidden', 'avatars_visible', 'full');--> statement-breakpoint
CREATE TYPE "public"."publish_policy" AS ENUM('all', 'staff', 'grant_only');--> statement-breakpoint
CREATE TYPE "public"."space_access" AS ENUM('open', 'cohort', 'invite', 'request');--> statement-breakpoint
CREATE TYPE "public"."space_kind" AS ENUM('open', 'classroom', 'meeting_room', 'mentor_pod', 'live_coding', 'desk', 'town_hall', 'notice_board', 'stage', 'help_desk');--> statement-breakpoint
CREATE TABLE "maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"is_entry" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"cohort_track_id" uuid,
	"user_id" uuid,
	"granted_by" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_memberships_one_subject" CHECK (("space_memberships"."cohort_track_id" is null) <> ("space_memberships"."user_id" is null)),
	CONSTRAINT "space_memberships_valid_window" CHECK ("space_memberships"."valid_to" is null or "space_memberships"."valid_to" > "space_memberships"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"kind" "space_kind",
	"is_map_default" boolean DEFAULT false NOT NULL,
	"audio_mode" "audio_mode" NOT NULL,
	"access" "space_access" NOT NULL,
	"outsider_visibility" "outsider_visibility" DEFAULT 'avatars_visible' NOT NULL,
	"capacity" integer,
	"publish_policy" "publish_policy" DEFAULT 'all' NOT NULL,
	"audible_radius" numeric(6, 2),
	"subscribe_radius" numeric(6, 2),
	"hysteresis_factor" numeric(4, 2) DEFAULT '1.2' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_default_is_open" CHECK (not "spaces"."is_map_default" or "spaces"."access" = 'open'),
	CONSTRAINT "spaces_broadcast_restricts_publish" CHECK ("spaces"."audio_mode" <> 'broadcast' or "spaces"."publish_policy" <> 'all'),
	CONSTRAINT "spaces_capacity_positive" CHECK ("spaces"."capacity" is null or "spaces"."capacity" > 0)
);
--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_cohort_track_id_cohort_tracks_id_fk" FOREIGN KEY ("cohort_track_id") REFERENCES "public"."cohort_tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "maps_key_unique" ON "maps" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "maps_single_entry" ON "maps" USING btree ("is_entry") WHERE "maps"."is_entry" and "maps"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "space_memberships_space_idx" ON "space_memberships" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "space_memberships_user_idx" ON "space_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "space_memberships_cohort_track_idx" ON "space_memberships" USING btree ("cohort_track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_map_key_unique" ON "spaces" USING btree ("map_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_one_default_per_map" ON "spaces" USING btree ("map_id") WHERE "spaces"."is_map_default";--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_single_town_hall" ON "spaces" USING btree ("kind") WHERE "spaces"."kind" = 'town_hall' and "spaces"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_single_notice_board" ON "spaces" USING btree ("kind") WHERE "spaces"."kind" = 'notice_board' and "spaces"."retired_at" is null;