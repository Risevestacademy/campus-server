ALTER TABLE "cohort_members" DROP CONSTRAINT "cohort_members_dismissal_reason";--> statement-breakpoint
-- The reason now keys off left_at rather than a status list. A dismissed row
-- written under the old rule could carry a reason with no end date; give it
-- the end it was recorded without, before the stricter check goes on.
UPDATE "cohort_members" SET "left_at" = "updated_at" WHERE "dismissal_reason" IS NOT NULL AND "left_at" IS NULL;--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_dismissal_reason" CHECK ("cohort_members"."dismissal_reason" is null or "cohort_members"."left_at" is not null);