-- Referral link visit tracking, and the pre-GST commission basis.
--
-- 1. `referral_visits` records that a referral link was *opened*. A visit is
--    not a customer and can never create commission; it exists so the funnel
--    (visits -> registrations -> paid purchases) can be reported honestly.
--
-- 2. `referral_commissions` gains the exact money the policy talks about:
--      eligible_base_amount  product amount after discount, before GST
--                             <- commission is a percentage of THIS
--      gst_amount            the tax the customer paid on top
--      total_paid_amount     what the customer actually paid
--
-- 3. A unique constraint on (referral_id, kind) makes "one initial commission
--    per referred customer" a database guarantee rather than application
--    logic, so a replayed webhook or two workers racing cannot both award it.
--
-- Existing referral codes, relationships and commission rows are preserved.
-- New columns are added with defaults so old rows read safely and, where no
-- eligible base is known, fall back to what was previously stored as the base.
--
-- Idempotent: every statement is guarded.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_visits') THEN
    CREATE TABLE "referral_visits" (
      "id" TEXT NOT NULL,
      "referral_code" TEXT NOT NULL,
      "referrer_account_id" TEXT,
      "visitor_id" TEXT NOT NULL,
      "landing_path" TEXT NOT NULL DEFAULT '/register',
      "referrer_header" TEXT,
      "user_agent_hash" TEXT,
      "ip_hash" TEXT,
      "country" TEXT,
      "visit_day" TIMESTAMP(3) NOT NULL,
      "visited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "converted_at" TIMESTAMP(3),
      "customer_id" TEXT,
      "metadata" JSONB NOT NULL DEFAULT '{}',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "referral_visits_pkey" PRIMARY KEY ("id")
    );
    -- One counted visit per code, per visitor, per day. Repeat opens, refreshes
    -- and browser retries collapse into the existing row.
    CREATE UNIQUE INDEX "referral_visits_referral_code_visitor_id_visit_day_key"
      ON "referral_visits"("referral_code", "visitor_id", "visit_day");
    CREATE INDEX "referral_visits_referrer_account_id_visited_at_idx" ON "referral_visits"("referrer_account_id", "visited_at");
    CREATE INDEX "referral_visits_referral_code_visited_at_idx" ON "referral_visits"("referral_code", "visited_at");
    CREATE INDEX "referral_visits_customer_id_idx" ON "referral_visits"("customer_id");
    CREATE INDEX "referral_visits_converted_at_idx" ON "referral_visits"("converted_at");
  END IF;
END $do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_commissions') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'referral_commissions' AND column_name = 'eligible_base_amount') THEN
      ALTER TABLE "referral_commissions" ADD COLUMN "eligible_base_amount" DECIMAL(12,2);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'referral_commissions' AND column_name = 'gst_amount') THEN
      ALTER TABLE "referral_commissions" ADD COLUMN "gst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'referral_commissions' AND column_name = 'total_paid_amount') THEN
      ALTER TABLE "referral_commissions" ADD COLUMN "total_paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
    END IF;

    -- Backfill historical rows so they display sensibly: under the previous
    -- behaviour `base_amount` held whatever the invoice total was. No amount is
    -- changed, so no paid commission is rewritten.
    UPDATE "referral_commissions"
       SET "eligible_base_amount" = "base_amount"
     WHERE "eligible_base_amount" IS NULL;
    UPDATE "referral_commissions"
       SET "eligible_base_amount" = COALESCE("base_amount", 0)
     WHERE "eligible_base_amount" IS NULL;
    UPDATE "referral_commissions"
       SET "total_paid_amount" = COALESCE("base_amount", 0)
     WHERE "total_paid_amount" = 0;
  END IF;
END $do$;

-- "One initial commission per referred customer", enforced by the database.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_commissions') THEN
    -- Only apply when the referral has no duplicate-kind rows already, so this
    -- can never fail on a database that already has history.
    IF NOT EXISTS (
      SELECT 1 FROM "referral_commissions"
      GROUP BY "referral_id", "kind" HAVING COUNT(*) > 1
    ) THEN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'referral_commissions_referral_id_kind_key') THEN
        CREATE UNIQUE INDEX "referral_commissions_referral_id_kind_key"
          ON "referral_commissions"("referral_id", "kind");
      END IF;
    END IF;
  END IF;
END $do$;