CREATE TYPE "public"."recording_status" AS ENUM('starting', 'active', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"started_by" uuid NOT NULL,
	"stopped_by" uuid,
	"provider_egress_id" varchar(128),
	"file_key" varchar(512) NOT NULL,
	"status" "recording_status" DEFAULT 'starting' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"size_bytes" bigint,
	"error" text,
	CONSTRAINT "recordings_ended_after_started" CHECK ("recordings"."ended_at" is null or "recordings"."started_at" is null or "recordings"."ended_at" >= "recordings"."started_at"),
	CONSTRAINT "recordings_measures_not_negative" CHECK (coalesce("recordings"."duration_ms", 0) >= 0 and coalesce("recordings"."size_bytes", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_stopped_by_users_id_fk" FOREIGN KEY ("stopped_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recordings_session_idx" ON "recordings" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_provider_egress_unique" ON "recordings" USING btree ("provider_egress_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_file_key_unique" ON "recordings" USING btree ("file_key");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_one_live_per_session" ON "recordings" USING btree ("session_id") WHERE "recordings"."status" in ('starting', 'active');