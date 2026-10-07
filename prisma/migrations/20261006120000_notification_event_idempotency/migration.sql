-- Durable idempotency for lifecycle notifications.
--
-- Problem: a WhatsApp (or email) "server is active" / "order paid" message could
-- be sent more than once. The queue set a BullMQ jobId from the caller's dedupe
-- key, but BullMQ removes completed jobs, so that key only covered duplicates
-- arriving while the job was still pending. A worker restart, a retry after a
-- timeout, or the same event firing again later all re-sent the message.
--
-- Fix: claim a deterministic event key in the database before sending. The first
-- caller wins the INSERT and sends; concurrent callers hit the unique index and
-- are told the event was already handled.
--
-- The key lives in rule_key because that column is already indexed with
-- event_type and channel, which is exactly the tuple the claim needs. No new
-- table and no new column: existing delivery logs become the durable record, and
-- historical rows are unaffected because their rule_key values are NULL or
-- unrelated.
--
-- Idempotent: IF NOT EXISTS on the index, and a partial index so the many rows
-- that carry no event key (every non-idempotent send) are not indexed at all.

CREATE UNIQUE INDEX IF NOT EXISTS "notification_delivery_logs_event_key_uniq"
  ON "notification_delivery_logs" ("rule_key", "event_type", "channel")
  WHERE "rule_key" IS NOT NULL;
