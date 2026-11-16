ALTER TYPE "public"."media_kind" ADD VALUE 'call_chat_attachment';--> statement-breakpoint
CREATE TABLE "call_chat_attachments" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_chat_attachments" ADD CONSTRAINT "call_chat_attachments_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_chat_attachments" ADD CONSTRAINT "call_chat_attachments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_chat_attachments_session_idx" ON "call_chat_attachments" USING btree ("session_id");