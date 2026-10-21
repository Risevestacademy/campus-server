-- Hand-edited: drizzle-kit adds a NOT NULL column in one step, which fails on
-- any row already there. Rows from before have no identity, so they get one
-- that names their own row, which keeps them unique too.
ALTER TABLE "session_participants" ADD COLUMN "provider_identity" varchar(128);--> statement-breakpoint
UPDATE "session_participants" SET "provider_identity" = "user_id"::text || ':before-' || "id"::text;--> statement-breakpoint
ALTER TABLE "session_participants" ALTER COLUMN "provider_identity" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_provider_identity_unique" ON "session_participants" USING btree ("provider_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_provider_room_unique" ON "sessions" USING btree ("provider_room_id");
