-- ========================================================================
-- 试用前安全加固(2026-07-03 权限审计) + BOM 色卡图片列
-- ========================================================================
-- 审计发现:
--   🔴 quote_line / quote_version_snapshot 的 SELECT policy = 任何登录用户全读
--      → 生产/QC/物流登录后可直连读到 成本/毛利/报价快照
--   🔴 order_financials 无 RLS 定义 → authenticated 可能全读(毛利/定金/尾款)
--   🔴 quoter_quotes(报价头表)迁移中无 RLS
-- 原则:读收紧(按角色) / 写保持 authenticated(action 层已把门,收紧写会误伤建单流程)
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

-- ─── 可读财务/成本的角色判断(内联片段,不建函数) ───
-- 财务可见: admin / finance / admin_assistant / sales_manager / order_manager
-- 报价可见: 上述 + sales / procurement / procurement_manager(报价是业务+采购工具)

-- ══ 1. order_financials:启 RLS,读=财务角色 或 订单创建者/负责人 ══
ALTER TABLE public.order_financials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_financials_select ON public.order_financials;
CREATE POLICY order_financials_select ON public.order_financials FOR SELECT USING (
  auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
            AND (p.role IN ('admin','finance','admin_assistant','sales_manager','order_manager')
                 OR p.roles && ARRAY['admin','finance','admin_assistant','sales_manager','order_manager']::text[]))
    OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_financials.order_id
               AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid()))
  )
);

-- 写:保持 authenticated(建单初始化/成本控制等在用户会话下写,action 层已按角色把门)
DROP POLICY IF EXISTS order_financials_insert ON public.order_financials;
CREATE POLICY order_financials_insert ON public.order_financials FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS order_financials_update ON public.order_financials;
CREATE POLICY order_financials_update ON public.order_financials FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- ══ 2. quote_line:读收紧(原为任何登录用户全读) ══
DROP POLICY IF EXISTS quote_line_select ON public.quote_line;
CREATE POLICY quote_line_select ON public.quote_line FOR SELECT USING (
  auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
    AND (p.role IN ('admin','finance','sales','sales_manager','order_manager','procurement','procurement_manager')
         OR p.roles && ARRAY['admin','finance','sales','sales_manager','order_manager','procurement','procurement_manager']::text[])
  )
);

-- ══ 3. quote_version_snapshot:读收紧(冻结快照含价格与成本) ══
DROP POLICY IF EXISTS quote_vsnap_select ON public.quote_version_snapshot;
CREATE POLICY quote_vsnap_select ON public.quote_version_snapshot FOR SELECT USING (
  auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
    AND (p.role IN ('admin','finance','sales','sales_manager','order_manager','procurement','procurement_manager')
         OR p.roles && ARRAY['admin','finance','sales','sales_manager','order_manager','procurement','procurement_manager']::text[])
  )
);

-- ══ 4. quoter_quotes(报价头,含成本/毛利):启 RLS + 读收紧 + 写 authenticated ══
ALTER TABLE public.quoter_quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quoter_quotes_select ON public.quoter_quotes;
CREATE POLICY quoter_quotes_select ON public.quoter_quotes FOR SELECT USING (
  auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
    AND (p.role IN ('admin','finance','sales','sales_manager','order_manager','procurement','procurement_manager')
         OR p.roles && ARRAY['admin','finance','sales','sales_manager','order_manager','procurement','procurement_manager']::text[])
  )
);
DROP POLICY IF EXISTS quoter_quotes_insert ON public.quoter_quotes;
CREATE POLICY quoter_quotes_insert ON public.quoter_quotes FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS quoter_quotes_update ON public.quoter_quotes;
CREATE POLICY quoter_quotes_update ON public.quoter_quotes FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- ══ 5. BOM 色卡/辅料图片(用户试用需求:原料色卡+辅料图上传) ══
ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS image_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.materials_bom.image_urls IS
  '色卡/辅料参考图 URL 数组(公开桶 product-images/materials/);BomTab 上传';

-- ========================================================================
-- 验证(逐条执行,期望值见注释)
-- ========================================================================
-- ① 期望 4 行,rowsecurity 全为 t:
-- select tablename, rowsecurity from pg_tables
--  where tablename in ('order_financials','quote_line','quote_version_snapshot','quoter_quotes');
-- ② 期望能看到上面创建的各 policy:
-- select tablename, policyname, cmd from pg_policies
--  where tablename in ('order_financials','quote_line','quote_version_snapshot','quoter_quotes')
--  order by tablename, policyname;
-- ③ 期望 1 行 image_urls | jsonb:
-- select column_name, data_type from information_schema.columns
--  where table_name='materials_bom' and column_name='image_urls';

-- ========================================================================
-- 回滚
-- ========================================================================
-- DROP POLICY IF EXISTS order_financials_select ON public.order_financials;
-- DROP POLICY IF EXISTS order_financials_insert ON public.order_financials;
-- DROP POLICY IF EXISTS order_financials_update ON public.order_financials;
-- ALTER TABLE public.order_financials DISABLE ROW LEVEL SECURITY;
-- CREATE POLICY quote_line_select ON public.quote_line FOR SELECT USING (auth.uid() IS NOT NULL);
-- CREATE POLICY quote_vsnap_select ON public.quote_version_snapshot FOR SELECT USING (auth.uid() IS NOT NULL);
-- DROP POLICY IF EXISTS quoter_quotes_select ON public.quoter_quotes; (等)
-- ALTER TABLE public.materials_bom DROP COLUMN IF EXISTS image_urls;
