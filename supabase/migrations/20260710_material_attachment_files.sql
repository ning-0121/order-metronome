-- ========================================================================
-- 辅料排版稿/文件附件(2026-07-10 用户拍板)
--   有些辅料(分款吊卡、分款箱唛…)每款每色排版都不同,数量矩阵表达不了。
--   让业务把做好的排版稿文件(PDF/AI/CDR/箱唛稿/xlsx…)直接传上来,跟着流到供应商。
-- ========================================================================
-- 与 image_urls(色卡/参考图,嵌进采购单 addImage)分开:那条只吃图片,文档嵌不进。
-- 本列存「文件附件」:形如 [{"name":"款A吊卡.pdf","url":"https://…"}]。公开桶 product-images。
-- 业务在「原辅料(BOM)」传 → 归并时自动带到采购项(与 image_urls 同一套 union 流转),
-- 采购也可补/删。采购单加一页「辅料附件清单」列出物料+文件名+链接,采购手动发供应商。
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS attachment_files jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN public.materials_bom.attachment_files IS
  '辅料排版稿/文件附件 [{name,url}](公开桶 product-images);业务传,归并随 image_urls 一起流转到 procurement_items。区别于 image_urls(参考图)。';

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS attachment_files jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN public.procurement_items.attachment_files IS
  '辅料排版稿/文件附件 [{name,url}];归并自 BOM.attachment_files,业务/采购双方可补删。采购单「辅料附件清单」页列出,手动发供应商。';

-- ========================================================================
-- 验证(期望 2 行):SELECT table_name, column_name FROM information_schema.columns
--   WHERE column_name='attachment_files' AND table_name IN ('materials_bom','procurement_items');
-- 回滚:ALTER TABLE public.materials_bom DROP COLUMN attachment_files;
--       ALTER TABLE public.procurement_items DROP COLUMN attachment_files;
-- ========================================================================
