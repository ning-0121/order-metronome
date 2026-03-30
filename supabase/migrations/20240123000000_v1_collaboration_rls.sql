-- V1 Collaboration RLS: Allow all authenticated users to read orders and milestones
-- Updates: Only restrict writes based on role (enforced in UI for V1, TODO: tighten at DB level later)

-- ============================================
-- Orders Table RLS
-- ============================================

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
DROP POLICY IF EXISTS "orders_insert_own" ON public.orders;
DROP POLICY IF EXISTS "orders_update_own" ON public.orders;

-- V1: All authenticated users can read orders (collaboration)
CREATE POLICY "orders_select_authenticated" ON public.orders
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- V1: All authenticated users can create orders
CREATE POLICY "orders_insert_authenticated" ON public.orders
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- V1: Order owner can update (TODO: Later add role-based update restrictions)
CREATE POLICY "orders_update_own" ON public.orders
  FOR UPDATE
  USING (
    auth.uid() IS NOT NULL AND
    (created_by = auth.uid() OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
      AND p.role = 'admin'
    ))
  );

-- ============================================
-- Milestones Table RLS
-- ============================================

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "milestones_select_own" ON public.milestones;
DROP POLICY IF EXISTS "milestones_insert_own" ON public.milestones;
DROP POLICY IF EXISTS "milestones_update_own" ON public.milestones;

-- V1: All authenticated users can read milestones (collaboration)
CREATE POLICY "milestones_select_authenticated" ON public.milestones
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- V1: System can insert milestones (via init_order_milestones function)
-- Regular users can also insert (enforced in UI/Repository layer)
CREATE POLICY "milestones_insert_authenticated" ON public.milestones
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- V1: Updates restricted to owner_role match or admin (enforced in UI for V1)
-- TODO: Later tighten this at DB level with role matching
CREATE POLICY "milestones_update_authenticated" ON public.milestones
  FOR UPDATE
  USING (
    auth.uid() IS NOT NULL
    -- Note: Role-based restrictions enforced in UI/Repository layer for V1
    -- TODO: Add DB-level role check when user_roles table is implemented
  );

-- ============================================
-- Milestone Logs RLS
-- ============================================

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "milestone_logs_select_own" ON public.milestone_logs;
DROP POLICY IF EXISTS "milestone_logs_insert_authenticated" ON public.milestone_logs;

-- V1: All authenticated users can read milestone logs (collaboration)
CREATE POLICY "milestone_logs_select_authenticated" ON public.milestone_logs
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- V1: Authenticated users can insert logs
CREATE POLICY "milestone_logs_insert_authenticated" ON public.milestone_logs
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ============================================
-- Delay Requests RLS
-- ============================================

-- Ensure delay_requests table has RLS enabled
ALTER TABLE public.delay_requests ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "delay_requests_select_own" ON public.delay_requests;
DROP POLICY IF EXISTS "delay_requests_insert_own" ON public.delay_requests;
DROP POLICY IF EXISTS "delay_requests_update_own" ON public.delay_requests;

-- V1: All authenticated users can read delay requests (collaboration)
CREATE POLICY "delay_requests_select_authenticated" ON public.delay_requests
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- V1: Authenticated users can create delay requests
CREATE POLICY "delay_requests_insert_authenticated" ON public.delay_requests
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- V1: Order owner or admin can update (approve/reject)
CREATE POLICY "delay_requests_update_own_or_admin" ON public.delay_requests
  FOR UPDATE
  USING (
    auth.uid() IS NOT NULL AND
    (
      EXISTS (
        SELECT 1 FROM public.orders o
        WHERE o.id = delay_requests.order_id
        AND o.created_by = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
        AND p.role = 'admin'
      )
    )
  );

-- ============================================
-- Comments
-- ============================================

COMMENT ON POLICY "orders_select_authenticated" ON public.orders IS 
'V1: All authenticated users can read orders for collaboration';

COMMENT ON POLICY "milestones_select_authenticated" ON public.milestones IS 
'V1: All authenticated users can read milestones for collaboration';

COMMENT ON POLICY "milestones_update_authenticated" ON public.milestones IS 
'V1: Updates allowed for authenticated users. Role-based restrictions enforced in UI/Repository layer. TODO: Tighten at DB level when user_roles table is implemented.';
