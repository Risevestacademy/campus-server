CREATE TABLE "room_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(16) NOT NULL,
	"cohort_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"title" varchar(128) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "room_links_revoke_window" CHECK ("room_links"."revoked_at" is null or "room_links"."revoked_at" >= "room_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_links_code_unique" ON "room_links" USING btree ("code");--> statement-breakpoint
CREATE INDEX "room_links_cohort_space_idx" ON "room_links" USING btree ("cohort_id","space_id");