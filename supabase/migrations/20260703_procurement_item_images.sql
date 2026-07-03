-- ========================================================================
-- 采购核料带图(2026-07-03 用户拍板:辅料图必须完整流转到采购,双方可更新)
-- ========================================================================
-- 业务执行在「原辅料」传的色卡/辅料图(materials_bom.image_urls)→ 核料归并
-- 自动汇集到采购项;采购在核料面板可继续补拍/更换。图片是证据不是计算真相,
-- 归并时从来源 BOM 行实时汇集(与主数据码同模式)。纯加法。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS image_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.procurement_items.image_urls IS
  '色卡/辅料参考图(公开桶URL数组)。归并自动汇集来源BOM图;业务执行+采购都可增删。';

-- 验证(期望 1 行 image_urls | jsonb):
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name='procurement_items' AND column_name='image_urls';

-- 回滚:
-- ALTER TABLE public.procurement_items DROP COLUMN IF EXISTS image_urls;
