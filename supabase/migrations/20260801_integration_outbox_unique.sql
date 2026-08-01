-- 修:财务同步失败连"失败"都记不下来(2026-08-01)
--
-- 现象:integration_outbox 建表至今 0 行,看着像"从没失败过",实际是**从没成功入队过**。
--
-- 根因:enqueueFinanceOutbox 用 upsert(..., { onConflict: 'request_id' }),
-- 但表上没有 request_id 的唯一约束 → Postgres 报
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- 而该函数整体套在 try/catch 里只 console.error → 静默。
--
-- 于是形成两层失效叠加、对外完全无声:
--   ① 财务系统 /api/integration/webhook 只实现了 GET,POST 返回 405(需财务侧修,不在本仓库);
--   ② 首发失败本该落 outbox 重试,但入队也失败 → 没送达、也没痕迹。
-- 结果:财务集成上线至今一条都没同步成功,而系统里看不出任何异常
-- (也解释了 order_financials.allow_shipment 的 187 个 true 全是补建默认值,财务侧从没回调过)。
--
-- 本迁移只修 ②。修好后失败会正常入队并按 2/4/8/16/32/60 分钟退避重试,
-- 等财务侧把 POST 端点补上,积压会自动补发。

-- 幂等:request_id 是发送方按 sha256(event|payload) 生成的确定性 id,天然唯一
create unique index if not exists integration_outbox_request_id_uniq
  on public.integration_outbox (request_id);

comment on index public.integration_outbox_request_id_uniq is
  'enqueueFinanceOutbox 的 upsert onConflict 依赖此唯一索引;缺了会让失败入队静默失效(2026-08-01 修)。';
