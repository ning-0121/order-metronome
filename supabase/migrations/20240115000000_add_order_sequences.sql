-- Migration: Add order_sequences table for system-generated order numbers
-- Purpose: Control order number generation in a transaction-safe, concurrent-safe manner
-- This table ensures order numbers are unique and sequential per day

-- Create order_sequences table
CREATE TABLE IF NOT EXISTS public.order_sequences (
  date_key date PRIMARY KEY,
  current_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_order_sequences_date_key ON public.order_sequences(date_key);

-- Add comment for documentation
COMMENT ON TABLE public.order_sequences IS 'System-controlled order number sequence table. Each row represents one day, current_seq tracks the last used sequence number for that day.';
COMMENT ON COLUMN public.order_sequences.date_key IS 'Date key (YYYY-MM-DD) for the sequence';
COMMENT ON COLUMN public.order_sequences.current_seq IS 'Current sequence number for this date. Incremented atomically in transactions.';

-- Updated_at trigger (reuse existing function)
DROP TRIGGER IF EXISTS trg_order_sequences_updated_at ON public.order_sequences;
CREATE TRIGGER trg_order_sequences_updated_at
  BEFORE UPDATE ON public.order_sequences
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- RLS: This table should only be accessible by service role or authenticated users
-- In practice, only the repository layer should access this table
ALTER TABLE public.order_sequences ENABLE ROW LEVEL SECURITY;

-- Policy: Only authenticated users can read (for debugging/monitoring)
DROP POLICY IF EXISTS "order_sequences_select_authenticated" ON public.order_sequences;
CREATE POLICY "order_sequences_select_authenticated" ON public.order_sequences
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Policy: Only authenticated users can insert/update (via repository layer)
DROP POLICY IF EXISTS "order_sequences_insert_authenticated" ON public.order_sequences;
CREATE POLICY "order_sequences_insert_authenticated" ON public.order_sequences
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "order_sequences_update_authenticated" ON public.order_sequences;
CREATE POLICY "order_sequences_update_authenticated" ON public.order_sequences
  FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- ⚠️ CRITICAL: This table should NEVER be deleted or rolled back
-- Order numbers are permanent and must not be reused
-- DO NOT add DELETE policy - this table is append-only

-- Create PostgreSQL function for atomic order number generation
-- This function ensures transaction safety and prevents concurrent duplicates
-- Uses INSERT ... ON CONFLICT DO UPDATE to atomically increment sequence
CREATE OR REPLACE FUNCTION public.generate_order_sequence(_date_key date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  _next_seq integer;
BEGIN
  -- Insert with current_seq = 0, or update existing row by incrementing
  -- ON CONFLICT ensures atomic operation even under concurrent access
  INSERT INTO public.order_sequences (date_key, current_seq)
  VALUES (_date_key, 0)
  ON CONFLICT (date_key) DO UPDATE
  SET current_seq = order_sequences.current_seq + 1,
      updated_at = now()
  RETURNING current_seq INTO _next_seq;
  
  -- If _next_seq = 0, it means a new row was inserted
  -- Update it to 1 and return 1
  IF _next_seq = 0 THEN
    UPDATE public.order_sequences
    SET current_seq = 1, updated_at = now()
    WHERE date_key = _date_key;
    RETURN 1;
  ELSE
    -- Existing row was updated, return the incremented value
    RETURN _next_seq;
  END IF;
END;
$$;

-- Add comment
COMMENT ON FUNCTION public.generate_order_sequence IS 'Atomically generates the next sequence number for a given date. Thread-safe and concurrent-safe.';
