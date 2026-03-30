-- Migration: Add milestone_logs table for event tracking
-- Purpose: Track all milestone state transitions and actions for accountability and review
-- This table enables:
-- 1. Audit trail of who did what and when
-- 2. Review of milestone progression history
-- 3. Debugging of state transition issues

-- Create milestone_logs table
CREATE TABLE IF NOT EXISTS public.milestone_logs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  milestone_id uuid NOT NULL REFERENCES public.milestones(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL, -- e.g., 'create', 'status_transition', 'update'
  from_status text, -- Previous status (for transitions)
  to_status text, -- New status (for transitions)
  note text, -- Optional note/description
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_milestone_logs_milestone_id ON public.milestone_logs(milestone_id);
CREATE INDEX IF NOT EXISTS idx_milestone_logs_order_id ON public.milestone_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_milestone_logs_actor_user_id ON public.milestone_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_milestone_logs_created_at ON public.milestone_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_milestone_logs_action ON public.milestone_logs(action);

-- Enable RLS
ALTER TABLE public.milestone_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see logs for orders they own
-- Using the existing is_order_owner function
DROP POLICY IF EXISTS "milestone_logs_select_own" ON public.milestone_logs;
CREATE POLICY "milestone_logs_select_own" ON public.milestone_logs
  FOR SELECT
  USING (public.is_order_owner(order_id));

-- RLS Policy: System can insert logs (via service role or authenticated users)
-- In practice, logs are inserted by the repository layer after authentication
DROP POLICY IF EXISTS "milestone_logs_insert_authenticated" ON public.milestone_logs;
CREATE POLICY "milestone_logs_insert_authenticated" ON public.milestone_logs
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL AND
    public.is_order_owner(order_id)
  );

-- Add comment for documentation
COMMENT ON TABLE public.milestone_logs IS 'Event log for milestone state transitions and actions. Used for audit trail and review.';
COMMENT ON COLUMN public.milestone_logs.action IS 'Action type: create, status_transition, update, etc.';
COMMENT ON COLUMN public.milestone_logs.from_status IS 'Previous status (for status_transition actions)';
COMMENT ON COLUMN public.milestone_logs.to_status IS 'New status (for status_transition actions)';
