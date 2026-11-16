ALTER TYPE "public"."media_kind" ADD VALUE 'notice_attachment';--> statement-breakpoint
ALTER TYPE "public"."media_kind" ADD VALUE 'feedback_attachment';--> statement-breakpoint
CREATE TABLE "feedback_attachments" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"feedback_id" uuid NOT NULL,
	"position" smallint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notice_attachments" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"notice_id" uuid NOT NULL,
	"position" smallint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "file_name" varchar(255);--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_attachments" ADD CONSTRAINT "notice_attachments_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_attachments" ADD CONSTRAINT "notice_attachments_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_attachments_feedback_idx" ON "feedback_attachments" USING btree ("feedback_id");--> statement-breakpoint
CREATE INDEX "notice_attachments_notice_idx" ON "notice_attachments" USING btree ("notice_id");