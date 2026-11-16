ALTER TYPE "public"."desk_release_reason" ADD VALUE 'account_suspended';--> statement-breakpoint
ALTER TYPE "public"."desk_release_reason" ADD VALUE 'admin_role_removed';--> statement-breakpoint
ALTER TABLE "desk_claims" DROP CONSTRAINT "desk_claims_cohort_member_fk";
