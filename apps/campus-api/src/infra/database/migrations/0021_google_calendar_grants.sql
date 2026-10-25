CREATE TABLE "google_calendar_grants" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sealed_refresh_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_calendar_grants" ADD CONSTRAINT "google_calendar_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;