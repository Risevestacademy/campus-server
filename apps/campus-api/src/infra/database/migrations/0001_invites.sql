CREATE TYPE "public"."cohort_role" AS ENUM('student', 'professor', 'mentor');--> statement-breakpoint
CREATE TYPE "public"."cohort_status" AS ENUM('upcoming', 'active', 'completed');--> statement-breakpoint
CREATE TYPE "public"."invite_status" AS ENUM('pending', 'accepted', 'declined', 'revoked', 'expired');--> statement-breakpoint
CREATE TABLE "cohort_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohort_tracks_id_cohort_id_key" UNIQUE("id","cohort_id")
);
--> statement-breakpoint
CREATE TABLE "cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"code" varchar NOT NULL,
	"start_date" date,
	"end_date" date,
	"status" "cohort_status" DEFAULT 'upcoming' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar NOT NULL,
	"cohort_id" uuid,
	"cohort_track_id" uuid,
	"mentorship_group_id" uuid,
	"cohort_role" "cohort_role",
	"system_role" "system_role" DEFAULT 'user' NOT NULL,
	"token_hash" varchar NOT NULL,
	"status" "invite_status" DEFAULT 'pending' NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_email_lowercase" CHECK ("invites"."email" = lower("invites"."email")),
	CONSTRAINT "invites_cohort_scope" CHECK ("invites"."cohort_id" is not null or ("invites"."cohort_track_id" is null and "invites"."cohort_role" is null)),
	CONSTRAINT "invites_student_requires_track" CHECK ("invites"."cohort_role" is distinct from 'student' or "invites"."cohort_track_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"code" varchar NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cohort_tracks" ADD CONSTRAINT "cohort_tracks_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_tracks" ADD CONSTRAINT "cohort_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_cohort_track_fk" FOREIGN KEY ("cohort_track_id","cohort_id") REFERENCES "public"."cohort_tracks"("id","cohort_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cohorts_code_unique" ON "cohorts" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_unique" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_email_pending_unique" ON "invites" USING btree ("email") WHERE "invites"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_code_unique" ON "tracks" USING btree ("code");