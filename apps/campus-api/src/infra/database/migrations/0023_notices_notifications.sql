CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"scope" varchar(16) NOT NULL,
	"cohort_id" uuid,
	"cohort_track_id" uuid,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notices_cohort_matches_scope" CHECK (("notices"."scope" = 'campus') = ("notices"."cohort_id" is null)),
	CONSTRAINT "notices_track_matches_scope" CHECK (("notices"."scope" = 'cohort-track') = ("notices"."cohort_track_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"reference_type" varchar(64) NOT NULL,
	"reference_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_cohort_track_fk" FOREIGN KEY ("cohort_track_id","cohort_id") REFERENCES "public"."cohort_tracks"("id","cohort_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notices_scope_created_idx" ON "notices" USING btree ("scope","created_at");--> statement-breakpoint
CREATE INDEX "notices_cohort_idx" ON "notices" USING btree ("cohort_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_recipient_kind_reference_unique" ON "notifications" USING btree ("recipient_id","kind","reference_type","reference_id");