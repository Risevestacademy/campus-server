ALTER TABLE "invites" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;