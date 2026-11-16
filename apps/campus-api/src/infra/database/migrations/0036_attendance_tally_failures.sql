CREATE TABLE "attendance_tally_failures" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_failed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_tally_failures" ADD CONSTRAINT "attendance_tally_failures_instance_id_room_link_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."room_link_instances"("id") ON DELETE no action ON UPDATE no action;