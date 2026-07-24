-- ===== 2026-07-24 procurement_line_items.size 写授权 =====
-- 20260707_pli_size_grant 只 GRANT SELECT(size) → user-session 带 size INSERT/UPDATE 报
-- "permission denied for column size" → generateExecutionLines 命中降级把 size 抹成 null(拆码行全丢尺码)。
-- 代码已改走 service-role 插入(绕开列级授权);此处再补 INSERT/UPDATE 授权,让任何 user-session
-- 写 size(如采购手改尺码)也正常。size 是展示信息,非敏感。
GRANT INSERT (size), UPDATE (size) ON public.procurement_line_items TO authenticated;

-- 验证(期望有 INSERT + UPDATE 两行):
-- SELECT privilege_type FROM information_schema.column_privileges
--  WHERE table_name='procurement_line_items' AND column_name='size' AND grantee='authenticated';
