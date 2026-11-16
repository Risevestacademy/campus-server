CREATE TABLE "room_link_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_link_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_links" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_links" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_link_passes" ADD CONSTRAINT "room_link_passes_room_link_id_room_links_id_fk" FOREIGN KEY ("room_link_id") REFERENCES "public"."room_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_link_passes" ADD CONSTRAINT "room_link_passes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_link_passes_link_user_unique" ON "room_link_passes" USING btree ("room_link_id","user_id");--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_window" CHECK (("room_links"."starts_at" is null and "room_links"."ends_at" is null) or ("room_links"."starts_at" is not null and "room_links"."ends_at" is not null and "room_links"."ends_at" > "room_links"."starts_at"));