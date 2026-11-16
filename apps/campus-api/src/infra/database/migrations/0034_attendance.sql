CREATE TYPE "public"."attendance_source" AS ENUM('derived', 'override');--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('present', 'partial', 'absent');--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"present_seconds" integer NOT NULL,
	"status" "attendance_status" NOT NULL,
	"source" "attendance_source" DEFAULT 'derived' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_present_seconds" CHECK ("attendance"."present_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attendance_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attendance_id" uuid NOT NULL,
	"changed_by" uuid NOT NULL,
	"old_status" "attendance_status" NOT NULL,
	"new_status" "attendance_status" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_overrides_reason_not_blank" CHECK (btrim("attendance_overrides"."reason") <> '')
);
--> statement-breakpoint
CREATE TABLE "attendance_tallies" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"tallied_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attendance_tallies_window" CHECK ("attendance_tallies"."ends_at" > "attendance_tallies"."starts_at"),
	CONSTRAINT "attendance_tallies_after_end" CHECK ("attendance_tallies"."tallied_at" >= "attendance_tallies"."ends_at")
);
--> statement-breakpoint
ALTER TABLE "room_links" ADD COLUMN "audience" varchar(16) DEFAULT 'cohort' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_links" ADD COLUMN "cohort_track_id" uuid;--> statement-breakpoint
ALTER TABLE "room_links" ADD COLUMN "mentorship_group_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_instance_id_attendance_tallies_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."attendance_tallies"("instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_overrides" ADD CONSTRAINT "attendance_overrides_attendance_id_attendance_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."attendance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_overrides" ADD CONSTRAINT "attendance_overrides_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_tallies" ADD CONSTRAINT "attendance_tallies_instance_id_room_link_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."room_link_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_instance_user_unique" ON "attendance" USING btree ("instance_id","user_id");--> statement-breakpoint
CREATE INDEX "attendance_user_idx" ON "attendance" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attendance_overrides_attendance_idx" ON "attendance_overrides" USING btree ("attendance_id");--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_cohort_track_fk" FOREIGN KEY ("cohort_track_id","cohort_id") REFERENCES "public"."cohort_tracks"("id","cohort_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_mentorship_group_fk" FOREIGN KEY ("mentorship_group_id","cohort_id") REFERENCES "public"."mentorship_groups"("id","cohort_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_links_cohort_track_idx" ON "room_links" USING btree ("cohort_track_id");--> statement-breakpoint
CREATE INDEX "room_links_mentorship_group_idx" ON "room_links" USING btree ("mentorship_group_id");--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_audience_known" CHECK ("room_links"."audience" in ('cohort', 'cohort-track', 'mentorship-group'));--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_track_matches_audience" CHECK (("room_links"."cohort_track_id" is null or "room_links"."audience" = 'cohort-track') and ("room_links"."audience" <> 'cohort-track' or "room_links"."cohort_track_id" is not null or "room_links"."revoked_at" is not null));--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_group_matches_audience" CHECK (("room_links"."mentorship_group_id" is null or "room_links"."audience" = 'mentorship-group') and ("room_links"."audience" <> 'mentorship-group' or "room_links"."mentorship_group_id" is not null or "room_links"."revoked_at" is not null));