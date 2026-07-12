-- ============================================================
-- 订单级「纸箱规格 + 箱唛模板」carton_spec(#3 建单优化)
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- ------------------------------------------------------------
-- 背景:同一 PO 的纸箱信息大多相同(箱型/外箱尺寸/每箱件数/毛净重),只有个别款/色大小不同,
--   箱唛(shipping mark)按款/色不同。原来建单阶段没有结构化纸箱字段(只整单一段包装文字 + 上传文件)。
-- 设计:orders.carton_spec jsonb =
--   { default: {box_type, dims_cm:{l,w,h}, pcs_per_box, gross_kg, net_kg},
--     exceptions: [{scope:'style'|'color', style_no?, color?, ...覆盖字段}],
--     mark_template: "文字 + {PO}{款号}{颜色}{箱号} 变量" }
--   系统按订单款×色派生每个箱唛/纸箱,出货时可带进 packing_list_lines(前移+复用,不重造)。
-- 性质:纯加法单列,可空;NULL = 未设置纸箱规格。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS carton_spec jsonb;

COMMENT ON COLUMN public.orders.carton_spec IS
  '纸箱规格+箱唛模板(建单填):{default:{box_type,dims_cm,pcs_per_box,gross_kg,net_kg}, exceptions:[{scope,style_no?,color?,...}], mark_template}。按款×色派生箱唛,出货带进 packing_list_lines。NULL=未设置';

-- 验证(期望 1 行 carton_spec | jsonb):
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name='orders' AND column_name='carton_spec';
-- 回滚: ALTER TABLE public.orders DROP COLUMN IF EXISTS carton_spec;
