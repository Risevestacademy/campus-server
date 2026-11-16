-- Hand-edited: drizzle-kit drops and recreates an enum it shrinks, which
-- fails while a column still uses it, and moves no rows. Each enum is
-- renamed aside, recreated, and the column converted with every old value
-- mapped to a new one; spaces that admitted the cohort get the list that
-- says so before their access setting changes.
ALTER TABLE "space_memberships" DROP CONSTRAINT "space_memberships_one_subject";--> statement-breakpoint
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_default_is_open";--> statement-breakpoint
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_broadcast_restricts_publish";--> statement-breakpoint
ALTER TABLE "space_memberships" ADD COLUMN "cohort_role" "cohort_role";--> statement-breakpoint
ALTER TABLE "space_memberships" ADD COLUMN "system_role" "system_role";--> statement-breakpoint
-- `cohort` admitted every live member of the cohort but its guests: as a
-- list, students, professors and mentors. Written with no granter, as the
-- sync writes a kind's starting list.
INSERT INTO "space_memberships" ("space_id", "cohort_role", "valid_from")
SELECT "spaces"."id", "roles"."role"::"cohort_role", now()
FROM "spaces"
CROSS JOIN (VALUES ('student'), ('professor'), ('mentor')) AS "roles"("role")
WHERE "spaces"."access" = 'cohort';--> statement-breakpoint
ALTER TYPE "public"."space_access" RENAME TO "space_access_old";--> statement-breakpoint
CREATE TYPE "public"."space_access" AS ENUM('normal', 'designated');--> statement-breakpoint
-- `open` is normal. `cohort`, `invite` and `request` are designated: their
-- grants stay as the list, and a cohort space has just been given its roles.
ALTER TABLE "spaces" ALTER COLUMN "access" SET DATA TYPE "public"."space_access" USING (
  CASE "access"::text WHEN 'open' THEN 'normal' ELSE 'designated' END
)::"public"."space_access";--> statement-breakpoint
DROP TYPE "public"."space_access_old";--> statement-breakpoint
ALTER TYPE "public"."audio_mode" RENAME TO "audio_mode_old";--> statement-breakpoint
CREATE TYPE "public"."audio_mode" AS ENUM('proximity', 'boundary');--> statement-breakpoint
-- A broadcast space was a room with a few speakers: now everybody in it
-- hears everybody, and an admin speaks to the campus another way.
ALTER TABLE "spaces" ALTER COLUMN "audio_mode" SET DATA TYPE "public"."audio_mode" USING (
  CASE "audio_mode"::text WHEN 'broadcast' THEN 'boundary' ELSE "audio_mode"::text END
)::"public"."audio_mode";--> statement-breakpoint
DROP TYPE "public"."audio_mode_old";--> statement-breakpoint
ALTER TABLE "spaces" DROP COLUMN "outsider_visibility";--> statement-breakpoint
ALTER TABLE "spaces" DROP COLUMN "publish_policy";--> statement-breakpoint
DROP TYPE "public"."outsider_visibility";--> statement-breakpoint
DROP TYPE "public"."publish_policy";--> statement-breakpoint
ALTER TABLE "space_memberships" ADD CONSTRAINT "space_memberships_one_subject" CHECK (num_nonnulls("space_memberships"."user_id", "space_memberships"."cohort_track_id", "space_memberships"."cohort_role", "space_memberships"."system_role") = 1);--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_default_is_normal" CHECK (not "spaces"."is_map_default" or "spaces"."access" = 'normal');
