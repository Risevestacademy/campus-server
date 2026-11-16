CREATE TYPE "public"."feedback_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."feedback_type" AS ENUM('bug', 'idea', 'report');--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "feedback_type" NOT NULL,
	"title" varchar(120) NOT NULL,
	"details" text NOT NULL,
	"about" varchar(200),
	"reported_user_id" uuid,
	"submitted_by" uuid NOT NULL,
	"cohort_id" uuid,
	"context" jsonb,
	"user_agent" varchar(512),
	"status" "feedback_status" DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_title_not_blank" CHECK ("feedback"."title" ~ '[^ \t\n\r\f\v]'),
	CONSTRAINT "feedback_details_not_blank" CHECK ("feedback"."details" ~ '[^ \t\n\r\f\v]'),
	CONSTRAINT "feedback_details_length" CHECK (length("feedback"."details") <= 4000),
	CONSTRAINT "feedback_reported_user_on_reports" CHECK ("feedback"."reported_user_id" is null or "feedback"."type" = 'report'),
	CONSTRAINT "feedback_resolution" CHECK (("feedback"."status" = 'resolved') = ("feedback"."resolved_at" is not null) and ("feedback"."resolved_at" is null) = ("feedback"."resolved_by" is null))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_reported_user_id_users_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feedback_type_status_idx" ON "feedback" USING btree ("type","status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_submitted_by_idx" ON "feedback" USING btree ("submitted_by","created_at");