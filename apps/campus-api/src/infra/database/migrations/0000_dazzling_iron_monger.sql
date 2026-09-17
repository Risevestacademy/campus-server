CREATE TYPE "public"."system_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar NOT NULL,
	"provider" varchar DEFAULT 'google' NOT NULL,
	"provider_id" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"display_name" varchar,
	"phone" varchar,
	"bio" text,
	"avatar_url" varchar,
	"sprite_key" varchar,
	"system_role" "system_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
