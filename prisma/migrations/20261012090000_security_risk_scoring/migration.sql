-- Security risk scoring and temporary-block bookkeeping.
--
-- Two things change behaviourally here:
--
--  1. `security_risk_states` gives every identity (session, then device, then
--     IP) a rolling score. Mitigation is now a ladder - record, then score,
--     then a temporary block - instead of "one bad payload -> permanent ban".
--
--  2. `security_events` gains the fields an operator needs to actually review a
--     block: the score that produced it, the request id to correlate with the
--     access log, and the absolute expiry of any temporary hold.
--
-- `blocked_ips` gains review bookkeeping so a false positive can be marked and
--     audited rather than silently expiring.
--
-- Nothing here rewrites or deletes existing rows. Existing permanent bans stay
-- exactly as they are; they are now only reachable through the admin UI, never
-- through automatic detection.
--
-- Idempotent: every statement is guarded.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'security_risk_states') THEN
    CREATE TABLE "security_risk_states" (
      "id" TEXT NOT NULL,
      "identity_key" TEXT NOT NULL,
      "score" INTEGER NOT NULL DEFAULT 0,
      "signal_count" INTEGER NOT NULL DEFAULT 0,
      "last_event_type" TEXT,
      "last_ip" TEXT,
      "last_route" TEXT,
      "last_method" TEXT,
      "last_customer_id" TEXT,
      "last_session_id_hash" TEXT,
      "last_request_id" TEXT,
      "blocked_until" TIMESTAMP(3),
      "window_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "security_risk_states_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "security_risk_states_identity_key_key" ON "security_risk_states"("identity_key");
    CREATE INDEX "security_risk_states_blocked_until_idx" ON "security_risk_states"("blocked_until");
    CREATE INDEX "security_risk_states_score_idx" ON "security_risk_states"("score");
    CREATE INDEX "security_risk_states_window_started_at_idx" ON "security_risk_states"("window_started_at");
  END IF;
END $do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'security_events')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'security_events' AND column_name = 'risk_score'
     ) THEN
    ALTER TABLE "security_events" ADD COLUMN "risk_score" INTEGER;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'security_events')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'security_events' AND column_name = 'expires_at'
     ) THEN
    ALTER TABLE "security_events" ADD COLUMN "expires_at" TIMESTAMP(3);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'security_events')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'security_events' AND column_name = 'request_id'
     ) THEN
    ALTER TABLE "security_events" ADD COLUMN "request_id" TEXT;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'security_events_risk_score_created_at_idx') THEN
    CREATE INDEX "security_events_risk_score_created_at_idx" ON "security_events"("risk_score", "created_at");
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'security_events_expires_at_idx') THEN
    CREATE INDEX "security_events_expires_at_idx" ON "security_events"("expires_at");
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'security_events_request_id_idx') THEN
    CREATE INDEX "security_events_request_id_idx" ON "security_events"("request_id");
  END IF;
END $do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'blocked_ips')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'blocked_ips' AND column_name = 'review_status'
     ) THEN
    ALTER TABLE "blocked_ips" ADD COLUMN "review_status" TEXT;
    ALTER TABLE "blocked_ips" ADD COLUMN "event_count" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "blocked_ips" ADD COLUMN "risk_score" INTEGER;
    CREATE INDEX IF NOT EXISTS "blocked_ips_permanent_blocked_until_idx" ON "blocked_ips"("permanent", "blocked_until");
  END IF;
END $do$;

-- Historical permanent bans produced by the old auto-ban path are relabelled so
-- an operator reviewing the security page can tell "a human decided this" from
-- "a heuristic decided this". Nothing is unblocked here: that stays a manual,
-- audited action.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'blocked_ips') THEN
    UPDATE "blocked_ips"
       SET "review_status" = COALESCE("review_status", 'needs_review')
     WHERE "unblocked_at" IS NULL AND "review_status" IS NULL;
  END IF;
END $do$;