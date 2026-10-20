CREATE TYPE "public"."media_provider" AS ENUM('livekit');--> statement-breakpoint
CREATE TABLE "session_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"video_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "session_participants_left_after_joined" CHECK ("session_participants"."left_at" is null or "session_participants"."left_at" >= "session_participants"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"provider" "media_provider" DEFAULT 'livekit' NOT NULL,
	"provider_room_id" varchar(128) NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "sessions_closed_after_opened" CHECK ("sessions"."closed_at" is null or "sessions"."closed_at" >= "sessions"."opened_at")
);
--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_participants_session_idx" ON "session_participants" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_participants_user_idx" ON "session_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_one_open_per_person" ON "session_participants" USING btree ("session_id","user_id") WHERE "session_participants"."left_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_cohort_idx" ON "sessions" USING btree ("cohort_id");--> statement-breakpoint
CREATE INDEX "sessions_space_idx" ON "sessions" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_open_per_cohort_space" ON "sessions" USING btree ("cohort_id","space_id") WHERE "sessions"."closed_at" is null;