ALTER TABLE "invites" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "flag_message" text;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_flag_fields" CHECK (("invites"."flagged_at" is null) = ("invites"."flag_message" is null));