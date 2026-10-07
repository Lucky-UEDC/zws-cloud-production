-- A `guest-native` operation runs a `qm guest cmd` verb, so it has no shell at
-- all, and the admin editor deliberately stores NULL rather than an inert shell
-- that reads as though it constrained anything.
--
-- The column was NOT NULL, so every save of a guest automation template failed.
-- The four native operations (detect_os, detect_network, detect_filesystem,
-- guest_health) always serialise to a null shell, which is present on all
-- eleven shipped profiles -- so this was not an edge case, it was every save.
--
-- Widening a column to accept NULL is additive: no existing row changes, and
-- every reader already treats a null shell as "no shell" and falls back to the
-- engine default (see assertShellMatchesEngine callers in verification.ts and
-- validation.ts).

ALTER TABLE "guest_operation_templates" ALTER COLUMN "shell" DROP NOT NULL;