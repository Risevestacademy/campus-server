CREATE TABLE "mentorship_group_students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mentorship_group_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"cohort_member_id" uuid NOT NULL,
	"member_role" "cohort_role" GENERATED ALWAYS AS ('student'::cohort_role) STORED NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentorship_group_students_unique" UNIQUE("mentorship_group_id","cohort_member_id"),
	CONSTRAINT "mentorship_group_students_one_per_cohort" UNIQUE("cohort_id","cohort_member_id")
);
--> statement-breakpoint
CREATE TABLE "mentorship_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"mentor_member_id" uuid NOT NULL,
	"mentor_role" "cohort_role" GENERATED ALWAYS AS ('mentor'::cohort_role) STORED NOT NULL,
	"space_id" uuid,
	"name" varchar(128) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentorship_groups_id_cohort_id_key" UNIQUE("id","cohort_id"),
	CONSTRAINT "mentorship_groups_name_not_blank" CHECK (btrim("mentorship_groups"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_id_cohort_id_role_key" UNIQUE("id","cohort_id","role");--> statement-breakpoint
ALTER TABLE "mentorship_group_students" ADD CONSTRAINT "mentorship_group_students_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_group_students" ADD CONSTRAINT "mentorship_group_students_member_fk" FOREIGN KEY ("cohort_member_id") REFERENCES "public"."cohort_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_group_students" ADD CONSTRAINT "mentorship_group_students_group_fk" FOREIGN KEY ("mentorship_group_id","cohort_id") REFERENCES "public"."mentorship_groups"("id","cohort_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_group_students" ADD CONSTRAINT "mentorship_group_students_student_in_cohort" FOREIGN KEY ("cohort_member_id","cohort_id","member_role") REFERENCES "public"."cohort_members"("id","cohort_id","role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_groups" ADD CONSTRAINT "mentorship_groups_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_groups" ADD CONSTRAINT "mentorship_groups_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_groups" ADD CONSTRAINT "mentorship_groups_mentor_member_id_cohort_members_id_fk" FOREIGN KEY ("mentor_member_id") REFERENCES "public"."cohort_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentorship_groups" ADD CONSTRAINT "mentorship_groups_mentor_in_cohort" FOREIGN KEY ("mentor_member_id","cohort_id","mentor_role") REFERENCES "public"."cohort_members"("id","cohort_id","role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mentorship_group_students_group_idx" ON "mentorship_group_students" USING btree ("mentorship_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mentorship_groups_cohort_name_unique" ON "mentorship_groups" USING btree ("cohort_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "mentorship_groups_one_per_mentor" ON "mentorship_groups" USING btree ("cohort_id","mentor_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mentorship_groups_space_unique" ON "mentorship_groups" USING btree ("space_id") WHERE "mentorship_groups"."space_id" is not null;--> statement-breakpoint
CREATE INDEX "mentorship_groups_cohort_idx" ON "mentorship_groups" USING btree ("cohort_id");--> statement-breakpoint
UPDATE "invites" SET "mentorship_group_id" = NULL WHERE "mentorship_group_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_mentorship_group_id_mentorship_groups_id_fk" FOREIGN KEY ("mentorship_group_id") REFERENCES "public"."mentorship_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_mentorship_group_cohort_fk" FOREIGN KEY ("mentorship_group_id","cohort_id") REFERENCES "public"."mentorship_groups"("id","cohort_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_mentorship_group_student" CHECK ("invites"."mentorship_group_id" is null or "invites"."cohort_role" = 'student');