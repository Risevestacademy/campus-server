-- audit_log is append-only. Nothing in the application updates or deletes an
-- entry, and this makes the database refuse it from anything that tries:
-- a row trigger, so it holds for every role, the table's owner included.
--
-- TRUNCATE is not covered. It is not a row operation, it needs ownership of
-- the table, and it cannot be mistaken for an edit.
CREATE FUNCTION audit_log_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
