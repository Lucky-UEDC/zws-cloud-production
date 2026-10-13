-- Separates "registered" from "converted" on a referral visit.
--
-- `converted_at` was being set when the signup was linked, which made a
-- registered account count as a purchase in the funnel. The two are different
-- events with very different value, so they get separate columns:
--
--   registered_at  the visit produced a real account
--   converted_at   that account went on to make a qualifying purchase
--
-- Existing rows are backfilled from `converted_at` so no historical visit
-- silently changes meaning.
--
-- Idempotent: every statement is guarded.

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_visits')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'referral_visits' AND column_name = 'registered_at'
     ) THEN
    ALTER TABLE "referral_visits" ADD COLUMN "registered_at" TIMESTAMP(3);
    UPDATE "referral_visits" SET "registered_at" = "converted_at" WHERE "customer_id" IS NOT NULL AND "registered_at" IS NULL;
    CREATE INDEX IF NOT EXISTS "referral_visits_registered_at_idx" ON "referral_visits"("registered_at");
  END IF;
END $do$;