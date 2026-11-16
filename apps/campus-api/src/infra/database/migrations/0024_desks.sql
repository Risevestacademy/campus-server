CREATE TYPE "public"."desk_release_reason" AS ENUM('released', 'freed_by_admin', 'enrolment_ended', 'desk_retired');--> statement-breakpoint
CREATE TABLE "desk_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"desk_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" "desk_release_reason",
	CONSTRAINT "desk_claims_release_reason" CHECK (("desk_claims"."released_at" is null) = ("desk_claims"."release_reason" is null)),
	CONSTRAINT "desk_claims_release_window" CHECK ("desk_claims"."released_at" is null or "desk_claims"."released_at" >= "desk_claims"."claimed_at")
);
--> statement-breakpoint
CREATE TABLE "desks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desk_claims" ADD CONSTRAINT "desk_claims_desk_id_desks_id_fk" FOREIGN KEY ("desk_id") REFERENCES "public"."desks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_claims" ADD CONSTRAINT "desk_claims_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_claims" ADD CONSTRAINT "desk_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_claims" ADD CONSTRAINT "desk_claims_cohort_member_fk" FOREIGN KEY ("cohort_id","user_id") REFERENCES "public"."cohort_members"("cohort_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desks" ADD CONSTRAINT "desks_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desk_claims_one_holder" ON "desk_claims" USING btree ("desk_id","cohort_id") WHERE "desk_claims"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "desk_claims_one_desk" ON "desk_claims" USING btree ("user_id","cohort_id") WHERE "desk_claims"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "desks_key_unique" ON "desks" USING btree ("key");