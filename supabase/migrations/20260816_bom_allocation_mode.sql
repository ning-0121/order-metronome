-- ========================================================================
-- 辅料分配方式 allocation_mode(2026-08-16 CEO 拍板,并入采购 P0)
--
-- 解决的问题:BOM 录入侧「一行一物料 + 一个总量」,没有色×码维度 →
--   多尺码尺码牌/吊牌表达不了 → 跟单只能退回 Excel 手抄。
--   而那些数量系统本来就有(order_line_items.sizes),不该让人再敲一遍。
--
-- 本列只存**跟单的分配意图**,不存数量:
--   数量由 line item matrix × consumption_basis × qty_per_piece 算出,
--   落进**既有** procurement_items.sku_breakdown(20260710 已建)。
--   → 零新表,零第二套 SKU breakdown 模型。
--
-- 取值:
--   whole_order          整单一个数量(默认;NULL 等同此值 = 老行为)
--   by_style             按款分
--   by_style_color       按款×色分
--   by_style_color_size  按款×色×码分(吊牌/洗唛/尺码牌等印 SKU 信息的辅料)
--
-- NULL = 未声明 → 一律按 whole_order 处理,在途订单行为一个字节不变。
-- 纯加法,幂等。
-- ========================================================================

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS allocation_mode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'materials_bom_allocation_mode_chk'
  ) THEN
    ALTER TABLE public.materials_bom
      ADD CONSTRAINT materials_bom_allocation_mode_chk
      CHECK (allocation_mode IS NULL OR allocation_mode IN
        ('whole_order','by_style','by_style_color','by_style_color_size'));
  END IF;
END $$;

COMMENT ON COLUMN public.materials_bom.allocation_mode IS
  '辅料分配方式(跟单声明的意图,不存数量):whole_order/by_style/by_style_color/by_style_color_size。NULL=whole_order(老行为)。数量由 order_line_items 矩阵 × consumption_basis × qty_per_piece 算出,落既有 procurement_items.sku_breakdown。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='materials_bom' AND column_name='allocation_mode';   -- 期望 1 行
-- 回滚:ALTER TABLE public.materials_bom DROP COLUMN IF EXISTS allocation_mode;
--       ALTER TABLE public.materials_bom DROP CONSTRAINT IF EXISTS materials_bom_allocation_mode_chk;
-- ========================================================================
