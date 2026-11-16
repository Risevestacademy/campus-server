CREATE TABLE "google_calendar_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"resource_id" varchar(256) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_link_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_link_id" uuid NOT NULL,
	"organizer_id" uuid NOT NULL,
	"google_event_id" varchar(1024) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_link_instances_window" CHECK ("room_link_instances"."ends_at" > "room_link_instances"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_calendar_grants" ADD COLUMN "sync_token" text;--> statement-breakpoint
ALTER TABLE "google_calendar_grants" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "google_calendar_grants" ADD COLUMN "sync_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "google_calendar_grants" ADD COLUMN "sync_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "google_calendar_channels" ADD CONSTRAINT "google_calendar_channels_user_id_google_calendar_grants_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."google_calendar_grants"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_link_instances" ADD CONSTRAINT "room_link_instances_room_link_id_room_links_id_fk" FOREIGN KEY ("room_link_id") REFERENCES "public"."room_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_link_instances" ADD CONSTRAINT "room_link_instances_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "google_calendar_channels_user_idx" ON "google_calendar_channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "google_calendar_channels_expires_idx" ON "google_calendar_channels" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_link_instances_event_unique" ON "room_link_instances" USING btree ("organizer_id","google_event_id");--> statement-breakpoint
CREATE INDEX "room_link_instances_link_start_idx" ON "room_link_instances" USING btree ("room_link_id","starts_at");