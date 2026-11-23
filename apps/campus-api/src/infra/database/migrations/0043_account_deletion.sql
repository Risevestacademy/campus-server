ALTER TYPE "public"."desk_release_reason" ADD VALUE 'account_deleted' BEFORE 'admin_role_removed';--> statement-breakpoint
ALTER TYPE "public"."user_status" ADD VALUE 'deleted';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "analytics_erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deleted_at_with_status" CHECK (("users"."status"::text = 'deleted') = ("users"."deleted_at" is not null));