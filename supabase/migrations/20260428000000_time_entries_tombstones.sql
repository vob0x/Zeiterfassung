-- ─────────────────────────────────────────────────────────────────────────
-- Soft-delete tombstones for time_entries
-- ─────────────────────────────────────────────────────────────────────────
-- Background: today's data-loss incident exposed the tension between
-- (a) preserving local-only entries when sync fails, and (b) propagating
-- intentional deletes across devices. Without tombstones, the merge has
-- to choose: aggressive cleanup (data loss) or aggressive preservation
-- (zombies). Tombstones break the dilemma by making "deleted" an
-- explicit state instead of an absence — devices can sync the deletion
-- without depending on the entry being absent from the result set.
--
-- delete() now does an UPDATE setting deleted_at, never a real DELETE.
-- Reads include tombstones (so other devices learn about the deletion);
-- the client filters them out for display.
--
-- Hard-deletion remains possible for admin cleanup (purge tombstones
-- older than X days), but that's a separate operation.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;

-- Partial index for the most common access path: active entries per user.
CREATE INDEX IF NOT EXISTS time_entries_active_idx
  ON public.time_entries(user_id, date DESC)
  WHERE deleted_at IS NULL;

-- Comment for clarity
COMMENT ON COLUMN public.time_entries.deleted_at IS
  'Soft-delete timestamp. NULL = active entry. Set when user deletes; the row remains so other devices can learn about the deletion via pull. Hard purge is admin-only.';
