-- Ensure milestones.owner_user_id column exists and is properly configured
-- This migration is idempotent (safe to run multiple times)

-- Check if column exists, if not add it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestones' 
    AND column_name = 'owner_user_id'
  ) THEN
    ALTER TABLE public.milestones
    ADD COLUMN owner_user_id uuid REFERENCES auth.users(id);
  END IF;
END $$;

-- Ensure the column allows NULL (for unassigned milestones)
ALTER TABLE public.milestones
ALTER COLUMN owner_user_id DROP NOT NULL;

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_milestones_owner_user_id ON public.milestones(owner_user_id);

-- Add comment
COMMENT ON COLUMN public.milestones.owner_user_id IS 'Assigned user ID for this milestone. NULL means unassigned.';
