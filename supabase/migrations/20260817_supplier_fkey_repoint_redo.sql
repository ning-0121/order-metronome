-- ========================================================================
-- 供应商外键改指 suppliers —— 重做 20260703(那次从未真正落到生产)
-- ========================================================================
-- 背景:20260703_supplier_fkey_repoint.sql 早就写好了这件事,文件头还写着
--   「⚠️ 由人手动在 Supabase SQL Editor 执行」。但它显然没人手动跑过 ——
--   后来 db:baseline 把全部历史迁移一并标记成"已执行",于是
--   `npm run db:status` 一直显示【待执行 0】,而生产库里外键**仍然指向 factories**。
--   典型的「迁移记录说已执行 ≠ 真的落了生产」(见 CLAUDE.md 数据库变更规范)。
--
-- 实证(2026-08-17,service-role 探针,插入即删):
--   · procurement_line_items.supplier_id 传 suppliers.id → ✗ 外键拒绝
--                                        传 factories.id → ✓ 接受
--     → 证明 FK 至今指向 factories,20260703 未生效。
--   · 后果:采购单选的是 suppliers.id,归行必然违反 FK。业务侧代码
--     (app/actions/trade-purchase.ts)靠"去掉 supplier_id 重试"的降级路径兜住,
--     所以功能没崩,但**采购行上的 supplier_id 永远是空的**。
--
-- 存量安全性(改之前实测):procurement_line_items.supplier_id 非空行数 = 0
--   → 没有任何存量行会被这次改动触及,零回归。
--   仍保留 NOT VALID:不回溯校验历史行,与 20260703 的原始设计一致。
--
-- ⚠️ 20260703 原文还想改 goods_receipts / procurement_tracking 的同名外键,
--   但这两张表**根本没有 supplier_id 列**(2026-08-17 实测确认)。
--   所以那个迁移即便当年有人手动跑,也会挂在第 4 条
--   ("column supplier_id referenced in foreign key constraint does not exist") ——
--   它从来就跑不完。这里改成按列存在与否条件执行:今天两张表会被跳过,
--   将来真加了列也不会再炸。
--
-- 幂等:DROP CONSTRAINT IF EXISTS 在前 + DO 块判列存在,重跑安全。
-- ========================================================================

ALTER TABLE public.procurement_line_items
  DROP CONSTRAINT IF EXISTS procurement_line_items_supplier_id_fkey;
ALTER TABLE public.procurement_line_items
  ADD CONSTRAINT procurement_line_items_supplier_id_fkey
  FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) NOT VALID;

DO $repoint$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['goods_receipts', 'procurement_tracking'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = t AND column_name = 'supplier_id') THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_supplier_id_fkey');
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (supplier_id) '
                     'REFERENCES public.suppliers(id) NOT VALID', t, t || '_supplier_id_fkey');
      RAISE NOTICE '% : supplier_id 外键已改指 suppliers', t;
    ELSE
      RAISE NOTICE '% : 无 supplier_id 列,跳过', t;
    END IF;
  END LOOP;
END
$repoint$;

-- ========================================================================
-- 验证(执行后)
-- ========================================================================
-- ① 期望 3 行且 指向表 都是 suppliers:
-- SELECT conname, confrelid::regclass AS 指向表 FROM pg_constraint
--  WHERE conname IN ('procurement_line_items_supplier_id_fkey',
--                    'goods_receipts_supplier_id_fkey',
--                    'procurement_tracking_supplier_id_fkey');
-- ② 经销单「生成大货采购单」→ 采购行应带上 supplier_id(不再走降级路径)。
--
-- ========================================================================
-- 回滚(改回 factories,不建议)
-- ========================================================================
-- 同上三段,REFERENCES public.factories(id)
