# 绮陌 OS 全面体检报告(2026-08-07)

> 多 agent 体检:9 维度并行扫描 + 4 名怀疑者对抗核实(13 agents · 606 次工具调用)。
> 结果:47 条发现 → **26 条确认**(一手证据)· 1 条打回 · 20 条存疑(见文末,不作结论)。
> 扫描均为只读,未改动任何代码与数据。

## 一、已确认问题(26 条)

### P0(6 条)

**P0-1 [吞 error] 改单批准落地:orders 更新与 status='approved' 写入都不查 error,会产生代码注释里自己防的「approved 但订单从未改」幽灵态**
- 位置:`app/actions/order-amendments.ts:304`
- 证据:该函数用 user-session 客户端(L186 `const supabase = await createClient()`)。L263-270 `await (supabase.from('order_amendments')).update({ status: approved ? 'approved' : ... })` 不查 error;L304-306 `await (supabase.from('orders')).update(updates)` 落地改价/改量也不查 error。而 L240-242 的注释明确写着怕「status=approved 但订单从未更新」的幽灵单(财务按旧价旧量收款、无重试路径)——门禁 return 的口子堵了,写库失败这个口子完全敞着。后续 L310 executeSideEffects、L318 重新 select fresh 再 syncOrderToFinance 照常执行(写失败时 fresh=旧值,财务同步的是旧数)。另:user-session UPDATE 被 RLS 过滤时 PostgREST 返回 0 行且无 error,连查 error 都拦不住,必须 .select('id') 断言行数。orders 表 UPDATE policy 无法只读验证(pg_policies/information_schema 经 PostgREST 均不可访问,实测报 `Could not find the table 'public.pg_policies'` / `Invalid schema: information_schema`)→ RLS 维度标 UNVERIFIABLE,但吞 error 本身是代码确证。
- 后果:财务批准一张改价/改量单,orders.update 因 RLS 过滤(0行无error)或列漂移失败 → 申请显示已批准、审批按钮消失(isApprovalPending 挡重批),但订单还是旧价旧量;财务同步收到的也是旧值。生产采购按旧量走,客户按新量结,金额直接错账,且无任何报错、无重试入口——正是 milestone_logs 96 条丢失同款静默模式打在钱上。
- 修法:两处写入都改为 `const { data, error } = await ....update(...).select('id')`;error 或 data.length===0 都要 return { error } 并把 order_amendments 状态回滚/不推进。改单批准建议整体换 service-role 客户端(权限门禁已在代码层做过)。
- 核实:亲读 app/actions/order-amendments.ts L186(user-session createClient)、L262-269(order_amendments.update 裸 await 无 error 检查)、L304-306(orders.update 落地改价改量裸 await 无 error 检查、无 .select() 行数断言)、L239-241 注释确实自己写着防「status=approved 但订单从未更新」幽灵单但只堵了门禁 return 的口子。L310 executeSideEffects、L316-319 重新 select fresh 后 syncOrderToFinance 照常执行——写失败时 fresh 是旧值。RLS UPDATE 策略(20240123 orders_update_own 仅创建人 OR 单列 role='admin')在仓库迁移里确认,现网策略无法只读验证。吞 error 是代码一手确证。

**P0-2 [1000行截断] CEO 驾驶舱全量里程碑查询被截断在 1000 条,且按 due_at 升序——4 月 14 日之后到期的节点全部隐身,最近 4 个月的新逾期/阻塞在 CEO 页上不存在**
- 位置:`app/ceo/page.tsx:147`
- 证据:查询 `.from('milestones').select(...orders!inner(...)).order('due_at',{ascending:true})` 无 .limit/.range。生产库 milestones 共 3979 行;实测该查询只返回 1000 行,返回集中最大 due_at = 2026-04-14T06:17(今天是 2026-08-07)。后续 overdueMilestones/blockedMilestones/overdueCount/blockedCount/今日待办均从这 1000 行过滤。
- 后果:任何 due_at 在 2026-04-14 之后才逾期的节点(即最近约 4 个月的全部新逾期)都不进 CEO 的超期列表、阻塞列表和计数——页面只展示 4 月前的僵尸逾期。代码里 2026 年那条'关键节点被百天僵尸挤掉'的修复注释试图用排序解决的问题,恰恰被这个截断反向放大:现在是新逾期被整体挤掉,CEO 每天看到的'该管的 30 条'系统性缺失最新风险。
- 修法:用 .range() 分页循环拉全量;或直接在 DB 侧过滤(status in 活跃 + due_at < now)把行数压到需要的子集再拉,超期/阻塞计数改用 count:'exact',head:true。
- 核实:看了 app/ceo/page.tsx:147-166:查询确无 .limit/.range,order('due_at',{ascending:true}),overdueMilestones/blockedMilestones/overdueCount/blockedCount 全从该结果过滤。亲自用 service-role 复跑同形查询:milestones 总数 3979,实际只返回 1000 行,返回集内最大 due_at=2026-04-14T06:17。再分页拉全量比对:全库『进行中且已逾期』节点 146 个,其中 142 个 due_at 晚于该截断点——即 97% 的当前真实逾期(全部近 4 个月的)不在 CEO 页数据集里。危害与描述一致。

**P0-3 [1000行截断] 分析页/CEO 页核心 KPI(完成率/准时率/超期数)基于 3793 条里程碑中截断的前 1000 条计算,完成率虚高 4 个百分点**
- 位置:`app/actions/analytics.ts:86`
- 证据:getAnalyticsSummary 中 `.from('milestones').select('id, order_id, status, ..., orders!inner(order_purpose)').eq('orders.order_purpose','production')` 无界。实测生产口径里程碑 3793 行,查询实际返回 1000 行;截断集算出 completionRate=76%(760/1000),分页拉全量真实值 72%(2748/3793)。onTimeRate、overdueInProgressCount、涉及订单数同样只在 26% 样本上算。
- 后果:/analytics 和 /ceo(page.tsx:47 调 getAnalyticsSummary)展示的全站完成率、准时率、超期/阻塞节点数全部失真,且截断子集是 PostgREST 物理顺序(偏老数据),随新单增长偏差会继续扩大——管理层拿虚高的完成率做交付判断。
- 修法:计数类改 count:'exact',head:true 分谓词各查一次;需要逐行计算的用 .range(i,i+999) 循环拉全量,或落一个 SQL 聚合 RPC。
- 核实:看了 app/actions/analytics.ts:86-126:查询无界,后续 completionRate/onTimeRate/overdueCount 全在返回集上算。复跑:orders.order_purpose='production' 内联过滤后里程碑 count=3793,无界查询实际返回 1000 行;用与代码相同的 isDoneStatus 归一化算完成率:截断集 76%(760/1000),分页全量 72%(2748/3793),差 4 个百分点,数字与发现完全吻合。调用方也核实:app/ceo/page.tsx:47 与 app/analytics/page.tsx:24 都调 getAnalyticsSummary。

**P0-4 [1000行截断] 四角色评分引擎(getRoleEfficiency,S-D 打分)同样只吃到 3793 条中的 1000 条,业务/跟单/采购/财务的分数和排名不可信**
- 位置:`app/actions/analytics.ts:178`
- 证据:getRoleEfficiency 中 roleMilestones 查询 `.select('id, order_id, status, due_at, actual_at, updated_at, owner_role, name, orders!inner(order_purpose)').eq('orders.order_purpose','production')` 无界,同一 3793 行总体实测截断到 1000。后续按 owner_role 聚合 completed/overdue/onTime/orderScores 并 calcGrade 定 S-D 档。
- 后果:角色评分只统计了物理顺序靠前的 1000 个节点(偏老订单):老订单占比高的角色被老数据主导,新节点多的角色近期表现完全不计入。CLAUDE.md 明确要求'修改评分逻辑时确认四个角色都正常'——现在四个角色的分数底数都是 26% 抽样,考核/排名结论失真。
- 修法:同上:.range 分页拉全量,或把按 owner_role 的聚合下推为 SQL RPC(group by owner_role)。
- 核实:看了 app/actions/analytics.ts:178-181:roleMilestones 查询与 getAnalyticsSummary 同谓词、同样无界,202 行起按 owner_role 聚合。亲自复跑该查询形状(含 owner_role/name 列):同一 3793 行总体,实际返回 1000 行。截断成立,聚合底数确为 26% 抽样。

**P0-5 [定时任务] 每日备份 cron 从未产出任何备份文件——backups 桶自始至终是空的,灾难恢复能力为零**
- 位置:`app/api/backup/route.ts:35`
- 证据:生产 Storage 实查:backups 桶存在但 list('daily') 返回 0 个文件、桶根目录也为空(cron 排程 '0 18 * * *' 每天跑)。根因:路由第 35 行用 `const supabase = await createClient()`(cookie 会话客户端),cron 调用无 cookie = anon 身份——实测 anon 客户端读 orders/milestones 均为 0 行(RLS),对 Private 桶的 upload 也会被 storage RLS 拒。2026-07-28 只修了 GET→405 问题(文件第 134 行注释自认'每日备份从未运行过'),但没换客户端,修完照样一个文件都没落。
- 后果:任何误删/漂移/供应商故障需要恢复数据时,团队以为有 30 天滚动备份,实际一份都不存在;212 张订单、3979 个节点、1687 条审计日志无任何冷备。且路由每天 500 也无人告警。
- 修法:isCron 分支改用 createServiceRoleClient()(与 order-audit 同款双分支写法);修完当天去 Storage 确认 daily/ 下真的出现文件。另注意 limit(10000) 上限,notifications 已 7574 行,接近时要分页。
- 核实:亲自用 service-role 查生产 Storage:backups 桶存在,list('daily')=0 个文件,桶根目录也 0 个文件——vercel.json 里 '/api/backup' cron('0 18 * * *')确在排程,却零产出。代码复核 app/api/backup/route.ts:35:const supabase = await createClient()(cookie 会话客户端),cron 请求无 cookie 即 anon;我实测 anon 客户端 orders count=0、milestones count=0(RLS 拒),导出必为空且 Private 桶上传会被 storage RLS 拒。134-135 行确实只修了 GET→405 没换客户端。桶空 = 一手铁证。

**P0-6 [定时任务] /api/cron/daily 四个核心步骤(客户节奏/P&L/告警清理/每日任务生成)自上线起全部空转——用了无会话的 anon 客户端**
- 位置:`app/api/cron/daily/route.ts:27`
- 证据:生产实查:customer_rhythm 表 0 行(从未写入过)、system_alerts 表 0 行、daily_tasks 全部 1000 条采样行的 created_at 都是 2026-07-31T05:08(一次手动触发,UTC 小时分布 {"5":1000},没有任何一行落在 cron 的 00:00 窗口)。对照组:同路由 Step 5 明确用 createServiceRoleClient() 的 customer_matters 今天 00:03 有新行——证明 cron 每天在跑,只有 anon 步骤颗粒无收。实测 anon 客户端可见 orders=0、milestones=0、daily_tasks=0;daily_tasks 的 INSERT 策略仅 TO authenticated(20260427_trade_os_foundation.sql:413)。步骤读 0 行后返回 '0 updated' 算成功,路由回 200,失败完全静默。
- 后果:每天 00:00 cron 绿灯跑完,但没人收到系统生成的今日任务、客户节奏/P&L 画像永远是空表、过期告警永不清理;Step 5/6 自己代码里都写了'表无 authenticated 写策略→必须 service-role',Step 1-4 却还在用会话客户端。
- 修法:第 27 行改 createServiceRoleClient() 传入各 service;并让各 service 在读到 0 行且 error 非空时上报 ✗(现有 failed-steps→500 机制才能真正亮红)。
- 核实:代码核实 app/api/cron/daily/route.ts:27:Step1-4 用 createClient()(会话客户端,cron 下=anon),Step5/6 用 createServiceRoleClient()。生产复跑:customer_rhythm count=0、system_alerts count=0(两表从未写入);对照组 customer_matters 最新行 2026-08-07T00:03(证明 cron 每天在跑)。daily_tasks 自 8-01 起 0 新行,而 cron 每天 00:00 跑——步骤颗粒无收成立。但同事的取证细节有误:daily_tasks 实为 3981 行、分布在 07-22/23/26/27/31 五天七个 UTC 时段(他的 1000 行采样本身被截断了,颇具讽刺);这些行全部来自 /my-today 页面访问触发(app/my-today/page.tsx:79 用登录用户 session 生成,如 07-27 的 804 行全在 00:04=北京 8:04 有人开页),没有任何一行落在 00:00-00:02 的 cron 窗口。核心结论(Step1-4 anon 空转、静默 200)成立,判 CONFIRMED,evidence 细节需按上述更正。

### P1(11 条)

**P1-1 [吞 error] 延期批准后订单锚点日期(factory_date/etd)写入不查 error,失败时延期已标 approved、「已通过」通知已发、节点已按新日期重算**
- 位置:`app/actions/delays.ts:993`
- 证据:recalculateSchedule 内 L993-996 `await supabase.from('orders').update(updates).eq('id', orderData.id)` 裸写(此处 supabase 是 approveDelayRequestCore 传入的 service-role 客户端,L577 `supabase = createServiceRoleClient()`)。调用它之前 core 已把 delay_requests 写成 status='approved'(L668-670,这条有查 error)并给申请人发「延期已通过」。写失败后代码继续用内存里的新日期算 newFactory/newEtd 并逐个重算 milestones(L1035+ 这些有查 error)。文件里 L100-102 注释自己承认这类矛盾态:「延期已 status='approved'、已发通知 → 申请人误信,而节点/订单日期实际未写」——但只对日期链校验分支做了记录,对写库失败没有任何检查。service-role 下 RLS 无关,失败源是列漂移/约束/网络(本项目 orders 列漂移有 PR#70 前科);RLS 抽验不适用,标 N/A。
- 后果:延期批准 → orders.factory_date/etd 写入失败(如某次迁移漂移) → 订单头还是旧交期,但 15 个节点的 due_at 已全部按新交期重算:逾期判红、交付置信度、报表全按旧锚点 vs 新节点错位;申请人收到「已通过」以为交期已退,业务对客户报的还是旧日期。
- 修法:`const { error } = await supabase.from('orders').update(updates)...`;失败时写一条 milestone_logs 'delay_anchor_write_failed'(同 L980 日期链违规的处理方式)并跳过后续 milestones 重算,避免半套状态。
- 核实:亲读 app/actions/delays.ts:L993-996 `await supabase.from('orders').update(updates)` 裸写无 error 检查(supabase 为 core L576 createServiceRoleClient);对照 L668-675 delay_requests 写 approved 是查了 error 的,L1036-1042 milestones 逐条重算也查了 error——唯独订单锚点这条不查。L980-987 对日期链违规分支确有 milestone_logs 留痕,对写库失败没有。写失败后 L1001-1003 仍用内存新日期算 newFactory/newEtd 并全量重算节点,头/节点错位场景成立。service-role 下失败源为列漂移/约束/网络,orders 列漂移有 PR#70 前科(MEMORY 印证)。

**P1-2 [吞 error] 多级改期审批链推进(approvals/current_step)4 处写入全不查 error,失败仍返回 ok:true 并通知下一级 → 审批链静默卡死**
- 位置:`app/actions/delays.ts:527`
- 证据:confirmDelayStep 内所有链状态写入均为裸 `await (svc.from('delay_requests')).update(...)`:L491-492(转紧急,追加 approval_chain+reschedule_mode)、L496(链满落地前推进)、L499/506(reschedule_mode 落地)、L527(未到末位推进 current_step)。每条后面都直接 `return { ok: true, ... }` 并 notify 下一级角色;另 L1542 批量代确认同款。svc=service-role,RLS 无关(标 N/A),但列漂移即静默——reschedule_mode/approval_chain/current_step 都是 2026-07 新列(今日实测生产已存在,风险是潜伏性)。L70-71 注释自己写着要防「status=approved 但 current_step 未走满的矛盾态」,防的是逻辑分支,没防写失败。
- 后果:某列漂移或瞬时故障 → 财务点「确认」返回成功、采购收到「轮到你确认」通知,但 DB 里 current_step 没动;采购来确认时角色对不上当前步被拒,财务的确认记录也不存在 → 整条改期审批链卡死,双方互相以为对方没处理,和「审批人从来没收到」同级别的流程黑洞。
- 修法:每处 update 加 `.select('id')` + error/行数检查,失败 return { error } 且不发下一级通知。
- 核实:亲读 delays.ts:L490-491(转紧急追加链)、L496(链满推进)、L499/503/506(reschedule_mode/标签落地)、L513(未到末位推进 current_step)——全部裸 `await (svc...).update(...)` 后直接 return { ok:true } + notify 下一级;L1541-1543 批量代确认同款(外层 try/catch 只接得住 throw,supabase error 对象不 throw)。生产实测 `select approval_chain, current_step, reschedule_mode` 无报错——列已存在,风险确为潜伏性,与发现描述一致。

**P1-3 [吞 error] 审计日志系统性裸插:milestone_logs 25 处 + order_logs 11 处 insert 不查 error,含核心 mark_done 路径——96 条审计丢失事故的代码模式原样健在**
- 位置:`app/actions/milestones.ts:841`
- 证据:静态扫描确认 36 个裸插调用点(bare await / try{}catch{} 吞掉,均无 error 检查)。最重的几处:milestones.ts:841 markMilestoneDone 的 mark_done/mark_done_backfill 日志(user-session 客户端,payload.overdue_days 明确注释「供后续评分使用」——丢了就丢考核依据);orders.ts:2161 force_complete(前面 orders 写入有查 error,日志没查);agent-execute.ts:187 agent_execute;milestone-confirmations.ts:193/224 多方确认;batch-milestones.ts:185/203/231;confirm-shipped.ts:57、customer-po.ts:214、inspection-waiver.ts:55、order-business-state.ts:145(allow_shipment 财务闸的开关审计)等。生产实测当前路径活着(milestone_logs 近14天 337 行、order_logs 52 行,payload 列已存在),即风险是潜伏性:下一次列漂移/策略变更会无声重演。RLS 抽验:pg_policies 与 information_schema 经 service-role PostgREST 均不可读(实测),user-session 插入是否可能被 policy 拒收 → UNVERIFIABLE;历史上 milestone_logs 就发生过 13 类动作/96 条静默丢失。
- 后果:任何一次 milestone_logs/order_logs 的列漂移或 RLS 调整 → 全站节点完成、逾期天数、放货审计、Agent 执行记录静默归零;考核评分(读 payload.overdue_days)与纠纷追溯(谁放的货、谁跳过验货)无据可查,且和上次一样要数月后才被发现。
- 修法:收口成一个 `logAudit(client, table, row)` helper:查 error,失败 console.error + 尽力写 notifications 给 admin;36 处全部替换。pre-deploy 列漂移防线只护已知列,护不住新代码引用新列。
- 核实:逐个亲读了点名的最重调用点,全部属实:milestones.ts:841-855 mark_done/mark_done_backfill 裸插(payload.overdue_days 注释确为「供后续评分使用」,user-session);orders.ts:2162 force_complete(对照同函数 L2153-2158 orders 写入查了 error,日志没查);agent-execute.ts:187、milestone-confirmations.ts:193/224、batch-milestones.ts:185/203/231、confirm-shipped.ts:57(try/catch 吞)、customer-po.ts:214、inspection-waiver.ts:55(try/catch 吞)、order-business-state.ts:145(财务闸 business_override 审计,裸插)、finance-resync.ts:56。未逐一数满 36 处,但 12 个抽查点 100% 命中且无一处在下游补查。生产实测当前路径活着(order_logs 132 行/近查询正常),确为潜伏性风险。

**P1-4 [RLS 静默拒收] 节点完成后清理逾期待办的 update 被 daily_tasks RLS 静默拒收——my-today 上 300+ 张「逾期 X 天」僵尸卡就是它**
- 位置:`app/actions/milestones.ts:901`
- 证据:代码:markMilestoneDone 用 session 客户端 update daily_tasks(status→done),fire-and-forget 吞错(.then(()=>{}, warn))。策略:20260427_trade_os_foundation.sql 只有 daily_tasks_update_own(USING/WITH CHECK 均为 assigned_to = auth.uid()),没有任何管理员/协作者 UPDATE 策略(admin 只有 read/insert)。生产实证:pending 状态的 milestone_overdue/milestone_due_today 任务共 1941 条;抽样 1000 条中 309 条对应节点已是 done(其中 266 条 assigned_to ≠ 节点当前 owner);对照组:完成人=被派人时清理成功过 255 条——说明代码路径通、RLS 是唯一拦截点。
- 后果:任何「完成人 ≠ 任务被派人」的节点完成(经理代完成、admin 补登、改派后完成)→ UPDATE 被 RLS 过滤为 0 行且无 error → 被派人的 my-today 永远挂着『逾期 5 天』卡片——这正是该处注释里自称已修掉的 bug,实际对跨用户场景从未生效;逾期噪音污染每日待办和催办,团队对红色告警脱敏。另注:batch-milestones/agent-execute 两条完成路径根本没有这段清理。
- 修法:清理动作改用 createServiceRoleClient()(与该函数里其它旁路副作用一致),或给 daily_tasks 增加系统/协作者 UPDATE 策略;同时给 batch-milestones、agent-execute 的完成路径补同样的清理;再跑一次性脚本把现存 309+ 条僵尸卡清掉。
- 核实:代码:milestones.ts L181 markMilestoneDone 用 createClient(session),L901-909 daily_tasks update fire-and-forget 吞错,亲验。策略:20260427_trade_os_foundation.sql L406-410 daily_tasks_update_own USING/WITH CHECK 均 assigned_to=auth.uid(),admin 只有 read(L394)/insert(L413),无任何管理员/协作者 UPDATE 策略,亲验。grep 确认 batch-milestones.ts / agent-execute.ts / milestonesRepo.ts 均无 daily_tasks 清理。生产复跑(service-role):pending 的 milestone_overdue/milestone_due_today 共 1941 条;抽样 1000 条中 309 条节点已 done,其中 266 条 assigned_to≠节点 owner;status=done 清理成功过 255 条。四个数字与发现完全一致。

**P1-5 [RLS 静默拒收] 延期「驳回」用 session 写 delay_requests,链上指定的部门经理(生产主管/财务/业务执行经理)全被 RLS 拒——只有 Alex 驳回得动**
- 位置:`app/actions/delays.ts:865`
- 证据:代码:rejectDelayRequest(807 行起)全程 session 客户端;865 行 .update({status:'rejected'}).eq(id).select().single()。对照:approve 侧在鉴权后显式切 service-role(delays.ts:574「绕过 delay_requests RLS 的多角色/老策略残留问题——2026-05-26 事故」),reject 侧没切。策略:delay_requests 现存两条 UPDATE 策略均为限制型(20240123: 订单创建人 OR profiles.role='admin' 单列;ADD_roles_array: 节点 owner OR 'admin'=ANY(roles)),或起来仍不含部门经理。业务路由:DEFERRAL_ROUTING(lib/domain/deferral-routing.ts:10-22)明确让 production_manager(生产/QC延期)、finance(出运延期)、order_manager/sales_manager 审;canActOnDeferralStep 放行这些角色点驳回。生产实证:近 1000 条 delay_requests 里 rejected 共 9 条,approved_by 全部是 Alex(admin,6 条)或 null(3 条)——从无一条经理驳回成功。
- 后果:秦增富(生产主管)驳回生产延期、方园(财务)驳回出运延期、高洁/May 驳回其它延期 → UPDATE 被 RLS 过滤 0 行 → .single() 抛 PGRST116,用户只看到一句晦涩英文报错,驳回永远失败;不合理的延期申请只能积压等 Alex,与「对口主管直接审」的设计目标直接矛盾。
- 修法:与 approve 同构:canActOnDeferralStep 鉴权通过后,驳回落库改走 createServiceRoleClient()。
- 核实:代码:delays.ts:807-874 rejectDelayRequest 全程 L808 createClient(session),L865-870 update+.select().single()(RLS 过滤 0 行时 .single() 抛 PGRST116);对照 approve 侧 L571-576 注释明说切 service-role 绕 delay_requests RLS(2026-05-26 事故),reject 侧没切,亲验。策略:20240123 delay_requests_update_own_or_admin(订单创建人 OR 单列 role='admin')+ ADD_roles_array delay_requests_update(节点 owner OR 'admin'=ANY(roles)),两条 OR 起来不含 production_manager/finance/order_manager 等链上角色,亲读迁移文本。业务路由 canActOnDeferralStep 确放行这些角色。生产复跑:rejected 共 9 条,approved_by 为 Alex×6 + null×3,无一条经理驳回成功——与发现一致。

**P1-6 [RLS 静默拒收] 价格审批:代码允许 sales_manager 批,RLS UPDATE 只认 admin,且 update 不带 .select()——经理批准会「界面成功、库里永远 pending」**
- 位置:`app/actions/price-approvals.ts:125`
- 证据:代码门禁 CAN_APPROVE_PRICE=['admin','sales_manager'](lib/domain/roles.ts:184),待办中心也把 sales_manager 标为该项可处理人(lib/services/pending-approvals.service.ts:321-324,注释还专门修过『sales_manager 是真审批人』)。策略:20260519_ai_usage_log_and_price_approval_rls.sql:84 drop 掉了旧的宽松 FOR ALL 策略,:118-122 的 pre_order_price_approvals_update 仅允许 admin——sales_manager 不在内。125 行 update 链没有 .select():RLS 把行过滤掉时返回 0 行且 error=null,函数照常走成功分支。生产:现有 2 条审批记录 reviewed_by 均为 Alex(admin),May/王海莲 两位 sales_manager 尚未用过该入口——即策略缺口尚未爆发但一用必中。
- 后果:May 或王海莲在 /admin/price-approvals 点「批准」→ 返回成功、revalidate、后续通知照发,但 DB 里 status 仍是 pending → 业务员以为价格已批开始建单/报价,审批单又同时留在待办里被重复处理;与 notifications 事故同款「静默 0 行」。
- 修法:二选一:把 pre_order_price_approvals_update 策略扩到 CAN_APPROVE_PRICE 同口径;或鉴权后落库走 service-role。无论哪种,update 后补 .select('id').single() 把 0 行变成显式报错。
- 核实:核心确证,但失败模式与描述不符。亲验:roles.ts:184 CAN_APPROVE_PRICE=['admin','sales_manager'];20260519 迁移 pre_order_price_approvals_update 仅 admin(且 20260408 的宽松 policy 已 drop);price-approvals.ts:125-132 update 无 .select()(有查 error,但 RLS 0 行无 error);生产 2 条审批 reviewed_by 均 Alex,May roles=['sales_manager']、王海莲 roles=['sales_manager','order_manager','procurement_manager','production_manager'] 均无 admin/finance——缺口未爆发但一用必中,全部复现。修正:同迁移的 SELECT 策略也只有本人/admin/finance,sales_manager 在 L112-115 .single() 读行时就会拿到 0 行 → 返回显式报错「审批记录不存在」,而非「界面成功、库里 pending」的静默模式(除非现网 SELECT 策略已漂移,无法只读验证)。无论哪种模式,经理批不动这个 P1 缺陷成立。

**P1-7 [RLS 静默拒收] orders 的 UPDATE 策略还是 2024 老版(仅创建人 OR 单列 role='admin'),15+ 处跨用户经营写点多数「静默成功」——免验/打样费/分批标记/转派从未落过库**
- 位置:`supabase/migrations/20240123000000_v1_collaboration_rls.sql:24`
- 证据:策略:orders_update_own = created_by=auth.uid() OR EXISTS(profiles.role='admin')——单列 role,不认 roles 数组;后续迁移(20260408/20260425)只动过 SELECT,UPDATE 从未升级。全站 28 人只有 Alex/Su 的 role='admin'。跨用户 session 写点(节选):inspection-waiver.ts:50(免验标记,update 无 select→静默)、sample-fee.ts:51(打样费,静默)、shipment-batches.ts:86(is_split_shipment 标记)、overdue-triage.ts:251(转派 owner_user_id)、score-appeals.ts:125(po_penalty_waived)、po-overdue.ts:127、order-amendments.ts:304/466/680。生产反证:带「免验货」tag 的订单 0 张、shipment_batches 0 行、transfer_owner 审计 0 条、po_penalty_waived=true 0 张——这些功能上线至今没有一次成功落库(未用过或用了没写进去,无法区分,但策略保证了非 admin 非创建人必失败)。
- 后果:QC 主管给别人建的订单标「免验货」→ 界面成功、tag 没写上,后续验货节点照卡;财务/业务给打样单录打样费 → orders 没写进去,但下游 order_finance_events + 财务通知走 service-role 已经发出(sample-fee.ts:57-59)→ 通知说有应收、订单上查无此费,账实分叉;物流建分批后订单永不标 is_split_shipment;经理转派逾期订单「成功」但 owner 没变、milestone_logs 却已写入 transfer_owner 审计(审计与事实矛盾)。
- 修法:orders UPDATE 策略升级:按 roles 数组判 admin/经理 + 协作者走 user_can_access_order;或把这批经营动作统一为「代码鉴权 + service-role 落库」;所有不带 .select() 的 orders update 补 0 行检查。
- 核实:策略:亲读 20240123 L24-33 orders_update_own(created_by OR 单列 role='admin');grep 全部迁移确认后续只动过 SELECT(20260408/20260425 orders_select_v2),无任何迁移升级 orders UPDATE。生产复跑:28 个 profile 中单列 role='admin' 仅 Alex/Su Liu。写点亲读:inspection-waiver.ts:50、sample-fee.ts:51、shipment-batches.ts:86、overdue-triage.ts:251 这几处其实都查了 error——但 RLS 过滤返回 0 行且 error=null,查 error 拦不住,静默成功结论成立;sample-fee 下游 order_finance_events 走 svc(L57)账实分叉路径属实;overdue-triage 转派后 milestone_logs 审计在 orders 写之后无条件写入属实。生产反证复现:免验货 tag=0、shipment_batches=0、is_split=0、transfer_owner 日志=0、po_penalty_waived=0(sample_fee 有 1 条,可能是创建人/admin 自改,不构成反驳)。保留一点:order_logs 维度已实证现网策略会漂移(见下条),orders 现网 UPDATE 策略同样无法只读验证——若也被手改放宽,则是「功能没人用」而非「被拒」;但按仓库迁移文本与全部生产零证据,发现成立。

**P1-8 [定时任务] 每日订单审计通知停发 73 天(最后一条 2026-05-26)——notifications.payload 列生产不存在,插入全数失败被吞**
- 位置:`app/api/cron/order-audit/route.ts:220`
- 证据:生产实查:type='daily_audit' 通知共 85 条,首条 2026-04-14、最后一条 2026-05-26T00:30(恰是 cron 时刻),此后 0 条;而当前审计谓词(status in ('in_progress','进行中') 且 due_at 过期)此刻就命中 144 个节点,绝不可能连续 73 天零问题。`select payload from notifications` 报 'column notifications.payload does not exist',全部迁移文件 grep 不到给 notifications 加 payload 的语句;第 220 行把 payload 塞进 insertNotifications 的行对象,insert 必失败,调用方又不检查返回的 {ok:false}。ignoreBuildErrors=true 让多余字段的类型报错也拦不住(同 milestone_logs payload 漂移一个根因家族)。
- 后果:cron 每天 00:30 扫出缺内部单号/缺工厂/逾期≥3 节点等问题,却一条都送不到 admin;管理员以为'没通知=没问题',数据质量问题积压 73 天无人认领。
- 修法:补幂等迁移 `alter table notifications add column if not exists payload jsonb` 并 npm run db:migrate 落生产;order-audit 处检查 insertNotifications 返回值,失败要让路由 500。
- 核实:亲自跑 select payload from notifications → 报 'column notifications.payload does not exist';grep 全部 supabase/migrations 无任何给 notifications 加 payload 的语句。复跑统计:type='daily_audit' 共 85 条,首条 2026-04-14,最后 2026-05-26T00:30(恰为 cron 00:30 时刻),此后 0 条;当前『in_progress/进行中 且 due_at 已过』节点 146 个(同事测 144,时间推移正常),不可能连续 73 天零问题。代码核实:app/api/cron/order-audit/route.ts:220-227 把 payload 塞进插入行;lib/utils/notifications.ts insertNotifications 用 service-role(RLS 无关)但列缺失必失败,返回 {ok:false},order-audit 212-229 行 for 循环 await 后不检查返回值——失败被吞、路由照样 200。全链路一手证实。

**P1-9 [定时任务] 业务员每日简报自 2026-07-13 停摆——90 张 active 订单没有一张 owner_user_id 属于 sales 角色用户,逐人 return null 后静默'成功'**
- 位置:`lib/agent/dailyBriefing.ts:64`
- 证据:生产实查:daily_briefings 表与 type='daily_briefing' 通知的最后记录都停在 2026-07-13T00:02(cron 排程 '0 0 * * *' 每天在跑)。根因取证:profiles 里 sales 用户共 4 人(谭博文/21131123/田芯怡/王一凡),而按简报谓词 `owner_user_id=该用户 AND lifecycle_status in ('执行中','running','active','已生效')` 逐人查询全部为 0 张——尽管全库 lifecycle_status='active' 的订单有 90 张。generateBriefingForUser 第 68 行 `if (!myOrders || myOrders.length===0) return null`,4 人全 null → generated:0,路由返回 200 无任何告警。
- 后果:业务员每天早上再也收不到'昨日客户邮件+今日到期节点+优先级建议'简报(连带微信推送),且停摆近一个月无人察觉;订单归属(owner_user_id)在 7 月中旬移交给非 sales 角色后,该 cron 就永久性空转。
- 修法:确认 7-13 前后订单 owner 移交给了谁(疑似跟单/生产角色);简报收件人改为按实际 owner_user_id 的角色圈定(或谓词放宽到订单 owner 本人),并在 generated=0 连续 N 天时报警。
- 核实:复跑生产:daily_briefings 最后一条 2026-07-13T00:02,type='daily_briefing' 通知最后一条同时刻;vercel.json '/api/cron/daily-briefing' 排程 '0 0 * * *' 仍在。代码核实 app/api/cron/daily-briefing/route.ts:29-32 只圈 role=sales 用户;profiles 里 sales 共 4 人(谭博文/21131123/田芯怡/王一凡),逐人按 lib/agent/dailyBriefing.ts:61-66 的谓词(owner_user_id=本人 AND lifecycle_status in 执行中/running/active/已生效)查询全部 =0,而全库匹配该 lifecycle 谓词的订单有 90 张;68 行 length===0 即 return null。4 人全 null → generated:0 → 200 无告警。逐项吻合。

**P1-10 [孤儿UI/死链] 邮件差异告警的「打开订单」链接指向已被删除的 ?tab=email_diffs 页签,静默落到基本信息页,差异处理入口断了 4 个月**
- 位置:`app/admin/mail-monitor/page.tsx:194`
- 证据:app/admin/mail-monitor/page.tsx:194 和 components/BriefingCard.tsx:170 都写死 href={`/orders/${d.orderId}?tab=email_diffs`}。但订单详情页白名单 app/orders/[id]/page.tsx:112 的 allowedTabs = ['basic','progress',...,'email_center',...] 里没有 'email_diffs',113 行 `allowedTabs.includes(rawTab) ? rawTab : 'basic'` 会静默回退。git 显示 commit 43b24b9(2026-04-07)把 EmailDiffsTab 并入 EmailCenterTab(tab key 改为 email_center,EmailCenterTab.tsx:73 渲染 <EmailDiffsTab/>),但这两处链接自 d113e9e(2026-04-06)起从未改过。
- 后果:管理员在 /admin/mail-monitor 或 CEO/晨报页(BriefingCard 挂在 /ceo 和 /briefing)看到「邮件 vs 订单数据差异」告警,点「打开订单→」→ 落到订单基本信息页,看不到差异面板,也到不了 resolveEmailDiff 的处理入口。用户会以为差异功能坏了或差异不存在,邮件差异闭环(发现→核对→消解)在 UI 上断链。
- 修法:两处链接改为 ?tab=email_center(components/BriefingCard.tsx:170 同步改);顺手在 allowedTabs 回退逻辑里给旧 key 加映射(email_diffs→email_center),和 cost_control 的回退注释同款做法
- 核实:亲自看:app/admin/mail-monitor/page.tsx:194 与 components/BriefingCard.tsx:170 都写死 ?tab=email_diffs;app/orders/[id]/page.tsx:112 的 allowedTabs 白名单无 'email_diffs',105-110 行的旧 key redirect 映射只有 timeline/overview 两项,113 行静默回退 'basic';components/tabs/EmailCenterTab.tsx:14/73 确认 EmailDiffsTab 已并入 email_center 页签;git show 43b24b9(2026-04-07 合并)与 d113e9e 存在且与描述一致。唯一小误差:BriefingCard 只挂在 /briefing(app/briefing/page.tsx:37),CEO 页的晨报卡已下线(app/ceo/page.tsx:19 注释),不挂 /ceo——不影响死链结论。

**P1-11 [数据完整性] internal_order_no=1022839 存在 4 张全 completed 的重复订单,统计重复计 1,668 件**
- 位置:`supabase://orders`
- 证据:同内部单号 1022839(EHL)共 4 行且 lifecycle_status 全为 completed:1,368 件 ×2 张(均 2026-04-03 建)+ 300 件 ×2 张(04-03/04-10 建)。completed 非取消单均进 isStatCountableOrder 统计口径 → 1,368+300=1,668 件被双算。另有 7 组同号双胞胎(559、559-2、1022869、1022870、1022871、1022872、1022919)为 active/completed + cancelled 配对,取消单不进统计、暂无害但数据脏,且说明 internal_order_no 无唯一约束
- 后果:总览/客户维度件数与金额把同一批货算两遍;按单号查单时随机命中 4 张之一,附件/日志/财务挂错单
- 修法:人工确认保留哪两张,把重复两张改 cancelled;给 internal_order_no 加部分唯一索引(where lifecycle_status not in ('cancelled'))防再发
- 核实:复跑 eq('internal_order_no','1022839'):确为 4 行全 completed——1,368件×2(均04-03建,间隔4分钟)+300件×2(04-03/04-10)。亲读 analytics-metrics.ts:8/20-27:EXCLUDED_STATUSES 只排 cancelled/closed/archived,completed 计入 → 1,368+300=1,668 件双算成立。全表 212 单(1000行内一次取全)扫出的其余同号组恰为清单所列 7 组:559、559-2、1022869/70/71/72、1022919,均为 active/completed+cancelled 配对。重复行存在本身即证明 internal_order_no 无有效唯一约束。

### P2(9 条)

**P2-1 [吞 error] 拒绝进行中导入订单:cancelled 写入不查 error(user-session),返回成功并通知创建者「已拒绝」,失败则订单照常跑生产**
- 位置:`app/actions/orders.ts:2105`
- 证据:rejectImportOrder(L2083 `const supabase = await createClient()` user-session)L2105-2107 `await (supabase.from('orders')).update({ lifecycle_status: 'cancelled', terminated_at: ... })` 裸写,随后直接发「订单被拒绝」通知并 `return {}`(成功)。terminated_at 列今日实测生产已存在(PR#70 已落),但该列正是本项目 schema 漂移事故主角,且 user-session UPDATE 被 RLS 过滤时无 error 返回 0 行。同款还有 confirm-shipped.ts:54 `lifecycle_status:'completed'` 裸写(svc,前面节点补录有查 error、这条没查,失败时函数返回 completed:true)。对比 forceCompleteOrderAction L2152-2158 是查了 error 的正面样板——同文件双标。RLS policy 无法只读验证,标 UNVERIFIABLE。
- 后果:CEO/财务拒绝一张进行中导入单,写入被 RLS 过滤或失败 → 界面成功、创建者收到「已被拒绝」通知,但订单 lifecycle 仍是 active:继续出现在跟单列表、继续算逾期、采购生产照常推进——一张被否决的单在系统里活着跑完全程。
- 修法:`.update(...).select('id')` + error/0行检查,失败 return { error } 且不发通知;confirm-shipped.ts:54 同改。
- 核实:亲读 orders.ts:2083-2122:L2084 user-session,L2094 允许 admin OR finance 操作,L2105-2107 orders.update({lifecycle_status:'cancelled',terminated_at}) 裸 await 无 error 无 .select(),随后 L2110 发「已被拒绝」通知、L2121 return {}(成功)。而 20240123 迁移的 orders UPDATE 策略只认创建人 OR 单列 role='admin'——финance(方园 role='finance')拒绝他人建的单,按迁移文本必被 RLS 过滤为 0 行且无 error。对照 forceCompleteOrderAction L2153-2158 确实查了 error(同文件双标属实)。confirm-shipped.ts:54 svc 裸写 lifecycle_status:'completed' 也亲验属实。

**P2-2 [吞 error] 财务金额类裸写一组:order_financials 售价、purchase_orders.total_amount 汇总、order_commissions 绩效 upsert 均不查 error**
- 位置:`app/actions/cost-control.ts:273`
- 证据:cost-control.ts:273/275 报价基线保存后同步售价到 order_financials 的 update/insert 裸写(同文件 L152/156 PO 匹配回填售价同款);对比同函数上文 order_cost_baseline 写入(L256-259)是查了 error 的——半查半不查。procurement.ts:886 与 procurement-items.ts:1340 采购单总额 `purchase_orders.update({ total_amount })` 汇总回写裸写(svc)。commissions.ts:373/396/418/448 采购/财务/物流/部门绩效 `order_commissions.upsert` 裸写(同函数 L283 业务角色的那条却查了 error——同一函数内双标)。均为静态确证;这三张表的 RLS 无法只读验证(UNVERIFIABLE),但 commissions/采购汇总多为 service-role 或 admin 触发,主要失败源是列漂移/约束。
- 后果:报价员录完基线,order_financials 售价写入静默失败 → 成本基线有了、售价没同步,利润快照与应收按空售价算;采购单加行后 total_amount 回写失败 → 对账单总额与行明细对不上;绩效 upsert 失败 → 采购/财务/物流当月评分静默缺失,只有业务有分(恰好是查了 error 的那条),考核公平性无声打穿。
- 修法:三处补 error 检查:售价同步失败应 return error(它在用户主动保存链路上);total_amount 汇总与绩效 upsert 至少 console.error + 告警,别让金额对不上还查无此事。
- 核实:全部亲读命中:cost-control.ts L151-153/156-160(PO 匹配回填售价裸写)、L273/275(手工基线同步售价裸写,对照 L256-259 order_cost_baseline 确实查了 error——半查半不查属实);procurement.ts:885-886 与 procurement-items.ts:1340 purchase_orders.total_amount 汇总回写裸 await(外层 try/catch 接不住 error 对象);commissions.ts:373/396/418/448 采购/财务/物流/部门 upsert 全裸写。一处细节修正:L283 业务那条走 upsertComm helper,内部查 error 只是为了列漂移降级重试,最终返回的 error 在 L309 `await upsertComm(salesPayload)` 同样被丢弃——「业务那条查了 error」的对照略夸大,但四处裸 upsert 与考核静默缺失风险本身确证。

**P2-3 [RLS 静默拒收] order_logs:迁移文本的 INSERT 策略「仅订单创建人」已被生产实证漂移(现网被手改过),且财务放货/免验/重同步三类审计生产 0 条、写入点全部吞错**
- 位置:`app/actions/order-business-state.ts:145`
- 证据:迁移里 order_logs 唯一 INSERT 策略是 20240121_add_order_lifecycle.sql:152 order_logs_insert_own(仅 orders.created_by=auth.uid(),连 admin 例外都没有);但生产 order_logs 里有 22 条 Alex 在别人订单上经 session 写入成功的 terminate/cancel_decision(actor_user_id=Alex ≠ orders.created_by)→ 现网策略必定 ≠ 仓库迁移(同 [[schema-drift-lifecycle-columns]] 的漂移病,重放迁移/新环境会回到创建人-only)。同时:action='business_override'(财务放货/停产审计)、'finance_resync'、'inspection_waiver' 生产各 0 条,而调用点全是 session 且不看结果(order-business-state.ts:145 与 finance-resync.ts:56 完全不检查 error,inspection-waiver.ts:55 try/catch 吞掉);全表仅 132 条日志、还混用 actor_id/actor_user_id 两套列;SELECT 策略同样仅创建人,协作者本来也看不到这份时间线。
- 后果:财务方园切 allow_shipment/payment_hold(发货财务闸的强审计动作)→ 若现网策略是「创建人 or admin」(与 22 条 Alex 数据吻合的最简解释),留痕被静默拒收,出了纠纷查不到『谁放的货、为什么』;即便现网已放开,仓库迁移与生产不一致意味着任何环境重建/策略重放都会把审计写入无声打回创建人-only。
- 修法:先在 SQL Editor 查 pg_policies where tablename='order_logs' 对齐真相,把现网策略回写成幂等迁移收口漂移;审计表 INSERT 放开为 authenticated、SELECT 至少放开到订单协作者;统一 actor 列;pre-deploy 漂移防线把 RLS 策略也纳入比对。
- 核实:迁移:亲读 20240121 L151-160,唯一 INSERT 策略仅 orders.created_by=auth.uid(),连 admin 例外都没有;SELECT 同仅创建人(L140-149)。生产复跑更强化了漂移结论:全表 132 条中跨用户(actor≠订单创建人)经 session 写入成功的有 32 条——Alex 22 + 秦增富(production_manager)3 + 菁菁(merchandiser)7,连非 admin 都插进去过 → 现网策略必定 ≠ 仓库迁移,且比「创建人 or admin」还宽(此点比发现假设的「最简解释」更宽,意味着财务 business_override 现网可能其实写得进,审计丢失未必正在发生——但「环境重建/重放迁移即回到创建人-only」的漂移风险原样成立)。action='business_override'/'finance_resync'/'inspection_waiver' 生产各 0 条复现(actions 分布里完全没有);actor_id/actor_user_id 两列并存混用亲验(查询两列均存在,order-business-state 用 actor_id、milestones.ts 用 actor_user_id);三个写入点全吞错亲读确认。

**P2-4 [1000行截断] Agent 管理页按类型统计只吃到 2927 条 agent_actions 中的 1000 条,与同页头部 count(2927)自相矛盾**
- 位置:`app/admin/agent/page.tsx:41`
- 证据:`.from('agent_actions').select('action_type, status')` 无界;agent_actions 实测 2927 行,该查询实测返回 1000 行。同页顶部 total/executed/dismissed 用 count:'exact' 查的是真值(total=2927),typeStats 却在 1000 行上累加。
- 后果:管理员打开 /admin/agent:头部显示总动作 2927,下方按类型分布合计只有 1000,各类型的执行率/驳回率基于早期 1/3 数据——评估 Agent 8 种动作哪个有效时会被老数据误导(近两个月的动作全不在分布里)。
- 修法:按类型统计改成对每个 action_type × status 用 count head 查询,或 SQL RPC group by action_type,status。
- 核实:看了 app/admin/agent/page.tsx:41-49:byType 查询 select('action_type, status') 无界,而 15-24 行头部统计用 count:'exact',head:true。复跑:agent_actions count=2927,无界查询实际返回 1000 行。同页两组数字必然自相矛盾,确认。

**P2-5 [1000行截断] AI 知识库统计页 byType/bySource 分布只统计 1385 条 active 中的 1000 条,与同函数用 count 查出的 total 对不上**
- 位置:`app/actions/ai-knowledge.ts:410`
- 证据:getKnowledgeStats 里 total 用 count:'exact',head:true 查(真值 1385),紧接着 `.select('knowledge_type, source_type, industry_tag').eq('status','active')` 无界拉明细做 byType/bySource/byIndustry 累加;ai_knowledge_base active 实测 1385 行,明细查询只返回 1000 行。
- 后果:知识库统计页显示总数 1385,但类型/来源/行业三个分布合计各只有 1000,385 条(28%)最新知识不计入分布——判断'哪类知识积累得多'时结论失真。另附临界观察(尚未越线但即将):单用户 notifications 最多 915 条、单人 owner 的 milestones 最多 817 条(analytics-detail.ts:216/384、orders.ts:1438、production-center.ts:82、export-production-sheet.ts:69 等按 owner_user_id 的无界查询),按当前增速数月内会陆续撞 1000 线,建议一并加分页。
- 修法:三个分布改 SQL RPC group by,或 .range 分页;同时给上述按 owner_user_id 的查询统一加分页工具函数。
- 核实:看了 app/actions/ai-knowledge.ts:405-421:total 用 count head 查,分布明细 410 行无界。复跑:status='active' count=1385,无界明细查询实际返回 1000 行。主张成立。附带的『临界观察』(notifications 915/单人 milestones 817 等)未逐项复核,不影响本条判定。

**P2-6 [孤儿UI/死链] 复盘功能 2026-08-02 已删页,但 CEO 页和 dashboard 各留一个「去复盘」链接指向已不存在的 /orders/[id]/retrospective(点击即 404)**
- 位置:`app/ceo/page.tsx:1039`
- 证据:app/ceo/page.tsx:1039 与 app/dashboard/page.tsx:709 均有 href={`/orders/${o.id}/retrospective`}。commit 1cc09e5(2026-08-02)删除了该路由目录(app/orders/[id]/ 下现在只剩 error/loading/page.tsx),且 commit message 声称「独立复盘页无任何入口链接」——但这两个入口自 2026-03-29/04-03(31a0a79/f33e2f6)就存在,漏删了。生产库实测:orders 表 retrospective_required=true 且未完成 = 0 行,lifecycle_status='待复盘' = 0 行,所以当前渲染 0 次,属潜伏死链。
- 后果:一旦任何订单被置 retrospective_required=true(如管理端回填或恢复旧逻辑),dashboard「待复盘」区块和 CEO 页复盘卡会立即渲染「去复盘」按钮,点击 404。同时 dashboard.tsx:150-155 每次加载仍在跑 select * from orders where retrospective_required 的死查询,CEO 页 553-554 行的 needRetrospective/retrospected 统计块也是永远为 0 的死代码。
- 修法:补齐 1cc09e5 的漏删:移除 app/ceo/page.tsx 复盘统计卡(553-554、1026-1057)和 app/dashboard/page.tsx 待复盘区块(150-155 查询 + 700-715 渲染)
- 核实:亲自看:app/ceo/page.tsx ~1039 与 app/dashboard/page.tsx ~709 均有 href=/orders/${...}/retrospective;ls app/orders/[id]/ 只剩 error.tsx/loading.tsx/page.tsx,retrospective 路由目录已不存在;git show 1cc09e5(2026-08-02)确认删除复盘功能且 commit message 自称『独立页无任何入口链接』——漏掉了这两处。dashboard.tsx:150-155 的 retrospective_required 死查询也在。生产复跑:retrospective_required=true 且未完成 =0 行、lifecycle_status='待复盘' =0 行,与发现一致——当前是潜伏死链,数据一出现即 404。按其陈述(含『潜伏』定性)判 CONFIRMED。

**P2-7 [孤儿UI/死链] BatchActions.tsx(批量分配跟单+批量催办,168 行)自 2026-04-03 创建以来从未被任何文件 import——OutsourceTab 同款孤儿,功能写完 4 个月无人能用**
- 位置:`components/BatchActions.tsx:1`
- 证据:全仓库(app/components/lib/scripts,含动态 import/require)对 BatchActions 的引用为 0;git log -S 'BatchActions' 全历史只有创建它的单文件提交 4e8a841(2026-04-03 'feat: 批量操作组件 — 批量分配跟单+批量催办',components/BatchActions.tsx 168 行,一个文件,无任何挂载改动)。组件内含完整实现:多选订单→批量 assignMerchandiser / 批量催办,权限给 admin 和 production_manager。
- 后果:生产经理/管理员至今只能在每张订单里用 MerchandiserAssign 逐单分配跟单、逐单催办;当初立项的批量操作从未上线,提交记录会让人误以为功能已存在。与 CLAUDE.md 记录的 OutsourceTab 事故完全同构(建功能前未确认组件可达)。
- 修法:二选一:在订单列表页挂载(补 checkbox 选择流),或按项目惯例删除并在 commit message 记录弃用决定;不要留第三种「存在但不可达」状态
- 核实:grep 全仓 app/components/lib/scripts(含动态 import 字符串匹配)对 'BatchActions' 的引用只有 components/BatchActions.tsx:14 自身定义,0 个引用方;git log --all -S 'BatchActions' 全历史仅一个提交 4e8a841『feat: 批量操作组件 — 批量分配跟单+批量催办』,单文件、无挂载改动。孤儿组件属实。

**P2-8 [孤儿UI/死链] /admin/mail-monitor、/admin/mail-import、/admin/mail-batch 三个管理页全仓库零入口链接,只能手敲 URL 进入**
- 位置:`app/admin/mail-monitor/page.tsx:1`
- 证据:对 133 条路由做反向引用扫描(app/components/lib/supabase/scripts 全部 .ts/.tsx/.sql),这三条路径除自身目录外无任何 href/push/redirect/通知链接引用;/admin/page.tsx 只有 5 行,直接 redirect('/ceo'),不是导航索引页;Navbar 中 grep '/admin' 无这三项。其中 mail-monitor 正是承载「邮件差异告警」的页面(与上面 P1 死链同属一条断裂的闭环)。
- 后果:邮件监控/差异处理、邮件导入、邮件批处理这三个后台工具对不知道 URL 的管理员等于不存在;新管理员(如白名单里的 su@)无从发现。mail-monitor 与 email_diffs 死 tab 叠加后,邮件差异功能链路两头都没有可点的入口。
- 修法:在 /ceo 或 Navbar 的 admin 区加入口;若 mail-monitor 已被 /inbox 看板(邮件归纳 Phase0-2)取代,则按惯例明确下线并在 commit 记录,避免半悬空
- 核实:grep 全仓(.ts/.tsx/.sql,排除页面自身目录与 API 路由)对三条路径的 href/router.push/redirect/action_url 引用为 0——唯一命中的是 EmailDiffsTab 对 actions/mail-monitor(server action 文件)的 import,不是页面链接;app/admin/page.tsx 全文 5 行,直接 redirect('/ceo'),不是导航索引;Navbar 无这三项。三个后台页确实只能手敲 URL。

**P2-9 [价格红线] getProcurementTrackingRows select('*') 含线下采购金额列,读取端零角色门禁**
- 位置:`app/actions/procurement-tracking.ts:63`
- 证据:第67-77行:仅查登录即 select('*') 返回 procurement_tracking 全列,含 amount(注释:'线下采购金额(RMB,2026-07-21)')和 offline_paid。同文件写入端全部挂了 CAN_EDIT_BOM 门禁(第98/152/311行),唯独读取端没有任何 role gate,也没按 CAN_SEE_PROCUREMENT_FLOOR 剥 amount。缓解:生产库实测 353 行中 amount 非空 0 行,当前无真实金额泄出。
- 后果:采购一旦开始按 2026-07-21 设计录线下采购金额,任何登录角色(含生产/QC/物流)打开订单的采购跟踪 tab(ProcurementTrackingTab)即可见每笔线下采购花了多少钱——采购金额红线归 CAN_SEE_PROCUREMENT_FLOOR 管,这里整条旁路。
- 修法:读取端按 CAN_SEE_PROCUREMENT_FLOOR(或 CAN_SEE_FINANCIALS)判定,无权则从返回行剥 amount/offline_paid;顺手把 select('*') 换成显式列清单。
- 核实:亲读 procurement-tracking.ts:63-78:只查登录即 select('*'),返回含 amount/offline_paid;同文件写入端 98/152 行确挂 CAN_EDIT_BOM,读取端无任何 gate。RLS 亲查 migration.sql:2270-2271:procurement_tracking_authenticated FOR ALL USING(true)——任意登录用户可读全表,无行级兜底(与 order_commissions 不同,这里连本人行限制都没有)。roles.ts:196 确认 amount 红线归 CAN_SEE_PROCUREMENT_FLOOR(admin/finance/procurement/procurement_manager),此口整条旁路。DB 复跑:353 行、amount 非空=0,与清单一致,当前无真实金额泄出的缓解描述也准确。

## 二、存疑待复核(20 条,核实组未拿到一手证据或题目未对上,不作结论)

- [P1][多真相源] 付款/确认链硬闸全部锚在 V1 的 production_kickoff/shipment_execute,V3 新单(现行标准模板)根本没有这些节点——「定金未收不许开工」「面料/Logo未确认不许开裁」对所有新单空转
- [P1][多真相源] 「下一个挡路的关键节点」有两套互相矛盾的关键节点清单:orderBusinessEngine 私有一份 V1 口径的 CRITICAL_STEP_KEYS,比 criticalNodes.ts 少 po_confirmed/pi_confirmed/ci_made/shipment_execute,且不读模板物化的 is_critical
- [P1][多真相源] 待审批中心三份准入名单漂移:service 层给 procurement_manager 全量审批可见,页面层却把她挡在门外——采购经理(王海莲)在「我的今天」看得到审批数、点进去是🔒
- [P2][多真相源] 「管理层看全部」在 4 处各内联一份且已互不一致:周日程导出漏 finance/sales_manager,跟单计划漏 finance/sales_manager/procurement_manager——财务导出周日程只看得到自己名下节点
- [P2][多真相源] 客户页准入名单与 CAN_EDIT_CUSTOMER 双轨已分叉:order_manager 拥有客户主数据编辑权却被 /customers 页面 redirect 走;admin_assistant/production_manager 能进页面却无编辑权
- [P2][多真相源] brand.ts 品牌单一源(2026-08-01 收口)仍有绕过副本:全站页脚法人名硬编码且比 BRAND.legalNameZh 少个「市」;finance-sso 的 admin 邮箱白名单是第三份硬编码副本
- [P0][审批链] 发货财务放行闸的「开闸」动作全站不可达:allow_shipment 唯一写入函数 overrideBusinessControl 仅 admin 可调且没有任何 UI 挂载,财务出货审批也不写该字段
- [P0][审批链] 「已出货」一键补录绕过全部审批闸:confirmOrderShipped 用 service-role 把除收款外所有未完成节点(含财务审核、QC 验货、订舱)批量置 done,不查 allow_shipment/payment_hold,服务端也没有「出厂日已过」校验
- [P1][审批链] V3 模板砍掉了 shipment_execute/domestic_delivery/finance_shipment_approval 节点,但物流队列和发货硬闸硬编码这些 step_key —— 对 V3 新单静默失效
- [P1][审批链] PO 免罚两方会签通过后,置 orders.po_penalty_waived=true 用的是审批人的 user-session,而 orders 的 UPDATE RLS 只允许创建者或 role='admin' —— 经理/财务会签达成时会静默写 0 行且不检查 error
- [P1][审批链] 待审批中心(pending-approvals)缺 4 条链:PO免罚、补料、订单改用途、出货财务审批都不在聚合里,审批人只有一次性通知或碰巧打开订单页才看得到;finance_ext 采购单还被禁止站内审批且无超时提醒
- [P2][审批链] QC 判返工后自动派发的复检任务 assigned_to 恒为 null:读旧记录时 select 漏了 assigned_to 字段,且不发通知 —— 「谁判的返工谁复检」从未生效
- [P1][数据完整性] 5 张套装单 total_amount 与 quantity×unit_price 恒差整整 2 倍——unit_price 按【每套】、quantity 按【件】,两字段口径冲突
- [P1][数据完整性] 3 张 active 单逐款明细少录,全站件数统计合计被少算 55,244 件(核①,共 6 张不一致,另 3 张见明细全0项)
- [P2][数据完整性] 幽灵负责人全貌(核④):2 个 UUID 不在 profiles,涉 70 行里程碑、14 张单(含 2 张 active)
- [P2][数据完整性] 3 张单建了明细行但 qty_pcs 全空(明细全0),其中 603 还叠加金额自相矛盾差 $4,374.72
- [P2][数据完整性] 核②收尾:另 3 张单金额三方互不一致(非 ×2 模式、逐款价也解释不了);其余核查项干净
- [P0][价格红线] getManufacturingOrder 无任何订单访问校验和价格剥离:任意登录角色可拿到全部逐款成交价+采购进价+PO底档金额
- [P1][价格红线] getPoParseSnapshot 返回原始 AI 冻结底档不剥价:QC/被指派的生产跟单可见客户单价与总额
- [P2][价格红线] getOrderCommissions select('*') 带佣金基数(=订单成交额)与提成金额,仅订单访问校验、无财务口径剥离

## 三、结构性观察

26 条确认问题里,**吞 error(7)+ RLS 静默拒收(5)合计占近半** —— 与本周通知事故同一病灶:写库失败不检查、被拒收无声。其次是 1000 行截断(5,全部打在管理层看的数字上)与定时任务实际停摆(4)。这不是零散 bug,是四个系统性模式,治本靠统一入口 + 静态闸(通知那套已建成,可复制)。