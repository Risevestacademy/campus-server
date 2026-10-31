CREATE TYPE "public"."analytics_consent" AS ENUM('granted', 'denied');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "analytics_consent" "analytics_consent";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "analytics_consent_at" timestamp with time zone;