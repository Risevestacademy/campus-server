-- Until now nothing in the database kept a cohort's dates in order; the
-- service did, under a row lock. A cohort saved with its end before its
-- start would abort the constraint below, and with it the deploy. Which of
-- the two dates was the mistake cannot be told from here, so the end is
-- cleared and the cohort is left open-ended for an admin to set again.
UPDATE "cohorts" SET "end_date" = NULL WHERE "end_date" < "start_date";--> statement-breakpoint
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_dates_in_order" CHECK ("cohorts"."start_date" is null or "cohorts"."end_date" is null or "cohorts"."end_date" >= "cohorts"."start_date");