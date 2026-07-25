-- ===== 2026-07-25 在途单发货闸「祖父豁免」(CEO 拍板)=====
-- 背景:发货财务闸改为 fail-closed 正向闸——allow_shipment 必须=true(财务主动放货)才能标发货出运。
--   但 order_financials.allow_shipment 列默认 false,现存 99/102 在途单都是 false → 周一起真发货会集中撞「财务未放货」。
-- CEO 定:考评生效日(2026-07-27)【之前】建的在途单先放行,只有生效日起【新建】的单走正向闸。与考评切换同口径。
-- 口径:
--   - 仅回填 生效日前 建的单(created_at < 2026-07-27 Asia/Shanghai)。
--   - 付款暂停中(payment_hold=true)的单【不动】——财务的主动风控信号,不能被祖父豁免冲掉。
--   - 已是 true 的不动(幂等:IS DISTINCT FROM true 保证重跑跳过已放行行)。
-- 一次性数据迁移,幂等可重跑;生效日起的新单不受影响(默认 false → 必须财务放货)。

update public.order_financials f
   set allow_shipment = true,
       updated_at = now()
  from public.orders o
 where f.order_id = o.id
   and o.created_at < timestamptz '2026-07-27 00:00:00+08:00'   -- 生效日前建的在途单
   and f.allow_shipment is distinct from true                    -- 幂等:已放行的跳过
   and f.payment_hold is not true;                               -- 付款暂停的不动(保财务风控)
