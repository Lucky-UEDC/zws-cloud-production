-- Referral reporting: referrer -> referred customer relationships, and a
-- commission ledger keyed to the qualifying order transaction.
--
-- Nothing here rewrites existing rows. Referral is new bookkeeping that sits
-- alongside customers/orders/invoices/vps_instances and never replaces them:
--   * referral_accounts     one row per customer that can refer
--   * referrals             referrer -> referred customer (first touch, enforced
--                           by the unique index on referred_customer_id)
--   * referral_commissions  one row per qualifying order (renewals included,
--                           because lib/renewals.ts writes a fresh
--                           orderType="renewal" order each period)
--   * referral_programs     the live commission rule, so the percentage is not
--                           a hardcoded constant
--
-- Idempotent: every statement is guarded so re-running is a no-op.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_programs') THEN
    CREATE TABLE "referral_programs" (
      "id" TEXT NOT NULL,
      "name" TEXT NOT NULL DEFAULT 'Default',
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 10,
      "hold_days" INTEGER NOT NULL DEFAULT 30,
      "minimum_order_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
      "allow_self_referral" BOOLEAN NOT NULL DEFAULT false,
      "metadata" JSONB NOT NULL DEFAULT '{}',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "referral_programs_pkey" PRIMARY KEY ("id")
    );
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_accounts') THEN
    CREATE TABLE "referral_accounts" (
      "id" TEXT NOT NULL,
      "customer_id" TEXT NOT NULL,
      "code" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'active',
      "display_name" TEXT,
      "notes" TEXT,
      "metadata" JSONB NOT NULL DEFAULT '{}',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "referral_accounts_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "referral_accounts_customer_id_key" UNIQUE ("customer_id"),
      CONSTRAINT "referral_accounts_code_key" UNIQUE ("code")
    );
    CREATE INDEX "referral_accounts_status_idx" ON "referral_accounts"("status");
    CREATE INDEX "referral_accounts_code_idx" ON "referral_accounts"("code");
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referrals') THEN
    CREATE TABLE "referrals" (
      "id" TEXT NOT NULL,
      "referrer_account_id" TEXT NOT NULL,
      "referrer_customer_id" TEXT NOT NULL,
      "referred_customer_id" TEXT NOT NULL,
      "code" TEXT NOT NULL,
      "source" TEXT NOT NULL DEFAULT 'link',
      "status" TEXT NOT NULL DEFAULT 'registered',
      "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "first_purchase_at" TIMESTAMP(3),
      "latest_purchase_at" TIMESTAMP(3),
      "converted_at" TIMESTAMP(3),
      "notes" TEXT,
      "metadata" JSONB NOT NULL DEFAULT '{}',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "referrals_referred_customer_id_key" ON "referrals"("referred_customer_id");
    CREATE INDEX "referrals_referrer_account_id_registered_at_idx" ON "referrals"("referrer_account_id", "registered_at");
    CREATE INDEX "referrals_referrer_customer_id_registered_at_idx" ON "referrals"("referrer_customer_id", "registered_at");
    CREATE INDEX "referrals_status_idx" ON "referrals"("status");
    CREATE INDEX "referrals_registered_at_idx" ON "referrals"("registered_at");
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_commissions') THEN
    CREATE TABLE "referral_commissions" (
      "id" TEXT NOT NULL,
      "referral_id" TEXT NOT NULL,
      "order_id" TEXT NOT NULL,
      "invoice_id" TEXT,
      "referrer_account_id" TEXT NOT NULL,
      "referrer_customer_id" TEXT NOT NULL,
      "referred_customer_id" TEXT NOT NULL,
      "product_id" TEXT,
      "service_id" TEXT,
      "kind" TEXT NOT NULL DEFAULT 'initial',
      "base_amount" DECIMAL(12,2) NOT NULL,
      "rate_percent" DECIMAL(5,2) NOT NULL,
      "amount" DECIMAL(12,2) NOT NULL,
      "currency" TEXT NOT NULL DEFAULT 'INR',
      "status" TEXT NOT NULL DEFAULT 'pending',
      "earned_at" TIMESTAMP(3) NOT NULL,
      "hold_until" TIMESTAMP(3),
      "paid_at" TIMESTAMP(3),
      "paid_by" TEXT,
      "reversed_at" TIMESTAMP(3),
      "reversal_reason" TEXT,
      "notes" TEXT,
      "metadata" JSONB NOT NULL DEFAULT '{}',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "referral_commissions_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "referral_commissions_order_id_key" ON "referral_commissions"("order_id");
    CREATE INDEX "referral_commissions_referral_id_status_idx" ON "referral_commissions"("referral_id", "status");
    CREATE INDEX "referral_commissions_referrer_customer_id_earned_at_idx" ON "referral_commissions"("referrer_customer_id", "earned_at");
    CREATE INDEX "referral_commissions_referred_customer_id_earned_at_idx" ON "referral_commissions"("referred_customer_id", "earned_at");
    CREATE INDEX "referral_commissions_status_earned_at_idx" ON "referral_commissions"("status", "earned_at");
    CREATE INDEX "referral_commissions_earned_at_idx" ON "referral_commissions"("earned_at");
    CREATE INDEX "referral_commissions_product_id_idx" ON "referral_commissions"("product_id");
  END IF;
END $do$;

-- Foreign keys are added separately so the guarded CREATE TABLE blocks above
-- stay safe on a database that already has a partial install.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_accounts')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'referral_accounts_customer_id_fkey' AND conrelid = 'referral_accounts'::regclass
     ) THEN
    ALTER TABLE "referral_accounts"
      ADD CONSTRAINT "referral_accounts_customer_id_fkey"
      FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referrals')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'referrals_referrer_account_id_fkey' AND conrelid = 'referrals'::regclass
     ) THEN
    ALTER TABLE "referrals"
      ADD CONSTRAINT "referrals_referrer_account_id_fkey"
      FOREIGN KEY ("referrer_account_id") REFERENCES "referral_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referrals')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'referrals_referrer_customer_id_fkey' AND conrelid = 'referrals'::regclass
     ) THEN
    ALTER TABLE "referrals"
      ADD CONSTRAINT "referrals_referrer_customer_id_fkey"
      FOREIGN KEY ("referrer_customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referrals')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'referrals_referred_customer_id_fkey' AND conrelid = 'referrals'::regclass
     ) THEN
    ALTER TABLE "referrals"
      ADD CONSTRAINT "referrals_referred_customer_id_fkey"
      FOREIGN KEY ("referred_customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_commissions')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'referral_commissions_referral_id_fkey' AND conrelid = 'referral_commissions'::regclass
     ) THEN
    ALTER TABLE "referral_commissions"
      ADD CONSTRAINT "referral_commissions_referral_id_fkey"
      FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'referral_commissions')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'referral_commissions_referrer_account_id_fkey' AND conrelid = 'referral_commissions'::regclass
     ) THEN
    ALTER TABLE "referral_commissions"
      ADD CONSTRAINT "referral_commissions_referrer_account_id_fkey"
      FOREIGN KEY ("referrer_account_id") REFERENCES "referral_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $do$;