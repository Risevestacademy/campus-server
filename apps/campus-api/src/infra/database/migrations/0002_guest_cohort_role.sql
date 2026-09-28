ALTER TYPE "public"."cohort_role" ADD VALUE 'guest';--> statement-breakpoint
ALTER TABLE "cohort_members" ADD COLUMN "access_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "guest_access_expires_at" timestamp with time zone;--> statement-breakpoint
-- A reason is about a dismissal. Any left on a row that is not dismissed
-- predates the constraint below and would abort it; they describe a state
-- the row is no longer in, so they are cleared rather than kept.
UPDATE "cohort_members" SET "dismissal_reason" = NULL WHERE "dismissal_reason" IS NOT NULL AND "status" IS DISTINCT FROM 'dismissed';--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_dismissal_reason" CHECK ("cohort_members"."dismissal_reason" is null or "cohort_members"."status" = 'dismissed');--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_guest_expiry" CHECK (("cohort_members"."role"::text = 'guest') = ("cohort_members"."access_expires_at" is not null));--> statement-breakpoint
-- Invites created before guests became a cohort role: no cohort, no admin
-- role, so accepting one enrolled the holder into nothing and left the
-- sign-in gate unable to tell them from a stranger. They cannot be honoured
-- under the new model, so the live ones are closed as revoked — which also
-- frees each address under invites_email_pending_unique, so the holder can
-- be re-invited properly. Settled rows are left alone and the constraint
-- below exempts them: they record something that did happen.
UPDATE "invites" SET "status" = 'revoked', "updated_at" = now() WHERE "status" = 'pending' AND "cohort_id" IS NULL AND "system_role" <> 'admin';--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_cohortless_is_admin" CHECK ("invites"."status" is distinct from 'pending' or "invites"."cohort_id" is not null or "invites"."system_role" = 'admin');--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_guest_has_expiry" CHECK (("invites"."cohort_role"::text is distinct from 'guest') = ("invites"."guest_access_expires_at" is null));
