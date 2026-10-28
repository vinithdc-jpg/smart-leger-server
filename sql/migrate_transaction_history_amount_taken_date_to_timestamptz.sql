BEGIN;

-- Legacy rows hold India-local calendar dates without timezone metadata.
ALTER TABLE transaction_history
  ALTER COLUMN amount_taken_date TYPE TIMESTAMPTZ
  USING amount_taken_date AT TIME ZONE 'Asia/Kolkata';

COMMIT;
