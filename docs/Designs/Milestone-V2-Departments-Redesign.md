# 节点体系 V2 + 部门角色重构 设计方案

> 2026-07-03,用户口述需求整理。状态:待拍板 → 分期实施。
> 原则:模板版本化,**新模板只对新订单生效,在途订单不动**;角色不改数据库枚举,做部门映射(零迁移风险)。

## 一、部门 → 系统角色映射

| 部门 | 岗位 | 登录系统 | 映射到现有角色 |
|---|---|---|---|
| 业务开发部 | 经理 / 业务开发员 | **客户开发系统**(araos) | 不登录节拍器(见决策②) |
| 业务执行部 | 经理 / 业务执行 | 节拍器 | sales_manager / sales |
| 采购部 | 经理 / 采购员 | 节拍器 | procurement_manager / procurement |
| 生产部 | 经理 / QC | 节拍器 | production_manager / qc |
| 财务部 | 财务 | **财务系统** | finance(节拍器保留确认权,数据经 webhook 双向) |

- UI 文案按部门显示(「业务执行部」),底层 role key 不动 → RLS/权限组/历史数据全兼容。
- merchandiser(跟单)角色去留 → 决策①。

## 二、节点模板 V2(9 节点,T0 = PO 日期)

| # | 节点 | step_key | 截止 | 责任/确认方 | 机制 |
|---|---|---|---|---|---|
| 1 | PO确认 | po_confirmed(复用) | **T+0** | 业务确认 + 财务确认(双确认) | finance_approval 并入为同日双确认 |
| 2 | 生产任务单下发 | mo_released(新) | **T+0** | 业务执行 | **自动完成**:生产任务单状态→「已下发生产」钩子自动打完 |
| 3 | 产前会 | pre_prod_meeting(新) | **T+2** | 业务执行+生产+采购 三方确认 | order_confirmations 多方确认 |
| 4 | 采购下单 | procurement_order_placed(复用) | 排期引擎 | 采购 | 完成后开启**采购进度共享**(无价单+采购进度tab+定期推送) |
| 5 | 产前样确认 | pre_production_sample_approved(复用) | 排期引擎 | 采购(原辅料大货品质)+ 业务执行(客户/自确认) 双确认 | order_confirmations |
| 6 | 生产启动 | production_kickoff(复用) | 排期引擎 | 生产+QC | 完成后开启 **QC 日常跟单打卡**(见三) |
| 7 | 尾查验货 | final_qc_check(复用) | 排期引擎 | 业务执行 + QC 双确认 | order_confirmations |
| 8 | 发货出运 | shipment_execute(复用) | 排期引擎 | 业务执行 + 采购(尾货尾料清点,接尾料归库) + 财务 三方确认 | order_confirmations;采购确认动作=完成尾料清点归库 |
| 9 | 收款完成 | payment_received(复用) | **按账期**(发货日+账期天数) | 财务 | 财务系统 webhook 回传可自动完成 |

- 9 个里程碑 + 多方确认挂在节点上;节点完成 = 所有要求方确认完毕。
- 旧模板(11节点/打样8节点)保留服务在途订单;模板版本字段区分。

## 三、QC 日常跟单流程设计(节点6→7 期间)

复用生产日报底座(production-progress),升级为结构化打卡:

1. **打卡内容**(结构化字段,30 秒能填完):
   - 今日数量:裁剪 / 车缝 / 后整 / 包装(件)
   - 累计进度 %(系统自动算 = 累计 ÷ 订单量,不用 QC 算)
   - 品质:✅正常 / ⚠️有问题(必填描述 + 拍照)
   - 风险灯:🟢正常 / 🟡关注 / 🔴告警
2. **频率与提醒**:生产启动后系统按频率(决策④)生成待打卡任务,当天未打卡晚间提醒 QC;**连续 2 期断更 → 自动通知生产经理 + 订单风险标记**(接现有风险引擎)。
3. **共享**:打卡自动进订单「生产进度」tab;业务执行/采购登录可见;🔴告警即时通知业务执行+采购+生产经理;业务开发不登录节拍器 → 通过企微群机器人推送摘要(复用现有 wechat-push)。
4. **尾查联动**:节点7打开时自动汇总打卡记录(总产量/问题清单/照片)作为验货依据。

## 四、采购进度共享(节点4起)

- 已有:无价版采购单导出、订单「采购进度」tab。
- 补:采购单状态变化(下单/到货/收货)自动推企微群摘要(定期而非每单刷屏,如每日一条汇总);业务执行/业务开发/生产按需看。

## 五、实施分期

- **P1a**(已完成 2026-07-03):V2 模板 9 节点骨架 + T+0/T+2 排期 + MO 自动完成钩子 + 部门文案(决策①)。**零 migration**(新 step_key 为 text,owner_role 复用现有枚举)。
- **P1b**(已完成 2026-07-03):多方(双/三方)确认机制,详见下方「P1b 落地清单」。决策②最终口径:**业务开发部在客户开发系统(araos)工作到「下 PO」,不进节拍器;节拍器的业务角色(sales/sales_manager)= 业务执行部**,UI 文案已改「业务执行」。不新增 bd 角色。
- **P2**:QC 打卡(表单+提醒+断更监控+共享)。
- **P3**:采购进度定期推送 + 收款按账期自动化(财务 webhook 回传)。

### P1a 落地清单(改动面,均已过 `npm run check`=151✅ + `npm run build`✅)

| 文件 | 改动 |
|---|---|
| `lib/milestoneTemplate.ts` | 新增 `MILESTONE_TEMPLATE_V2`(9节点);`getApplicableMilestones` 生产分支切 V2;V1 保留服务在途+回滚 |
| `lib/schedule.ts` | TIMELINE + calcDueDates 加 `mo_released`(T+0)/`pre_prod_meeting`(T+2) |
| `lib/runtime/criticalNodes.ts` | 关键集加 `po_confirmed`(并入财务门)/`shipment_execute`(V2出口末阻塞);旧键保留兼容 V1 |
| `app/actions/manufacturing-order.ts` | MO 状态→`executing` 自动完成里程碑 `mo_released`(fire-and-forget,不阻塞主链路,非V2订单命中0行静默) |
| `lib/utils/i18n.ts` | 决策①:跟单/QC 家族显示统一为「生产部QC」;`production_manager`→「生产部主管」 |
| `scripts/pre-deploy-check.ts` | 断言改指 V2(9节点/顺序/新键排期/已移除旧节点) |

**owner_role 说明**:`user_role` 枚举无 `qc` 值,QC 属生产部 → QC 牵头节点(尾查验货)owner_role 用 `production`。
**已知边界**:历史导入路径(`orders.ts` import_current_step)仍按 V1 索引 —— 仅用于把旧订单导入到某中间节点,新 V2 订单是全新建单不走此路,低风险。

### P1b 落地清单(多方确认,2026-07-03)

「节点完成 = 所有要求方确认完毕」:

| 节点 | 要求确认方 |
|---|---|
| PO确认 | 业务执行 + 财务(双) |
| 产前会 | 业务执行 + 生产部 + 采购部(三) |
| 产前样确认 | 采购部 + 业务执行(双) |
| 尾查验货 | 生产部QC + 业务执行(双) |
| 发货出运 | 业务执行 + 采购部(尾料清点归库) + 财务(三) |

| 文件 | 职责 |
|---|---|
| `lib/domain/confirmationParties.ts` | 节点→确认方配置(部门→角色组映射,纯函数,进 check 断言) |
| `supabase/migrations/20260703_milestone_confirmations.sql` | 确认表(一节点一方一行,UNIQUE 幂等,RLS) |
| `app/actions/milestone-confirmations.ts` | 行懒建 + 角色把关确认 + 日志 + 全齐自动完成(免证据节点)/提示传证据 |
| `app/actions/milestones.ts` markMilestoneDone | 完成门禁:缺确认 → 报还差哪些方;admin 豁免;表未建时放行(不 brick) |
| `components/MilestoneConfirmations.tsx` | 节点卡片「多方确认」chips(✅谁/何时 · ⬜确认按钮按角色显隐) |

机制:确认行为逐条落 `milestone_logs`(admin 代确认标注);全部确认后免证据节点直接自动完成并触发交付置信度重算,要证据的节点由负责人照常上传凭证→点完成(门禁此时已放行)。V1 在途订单节点不在配置里 → 完全不受影响。

## 决策(2026-07-03 用户拍板)

① **跟单(merchandiser)改名为「生产部 QC」**:跟单职责并入生产部 QC 岗;原 merchandiser 承担的节点(产前样确认/验货放行等)责任方改派 qc / 业务执行。UI 文案与角色显示同步改。
② **业务开发也开节拍器账号**(只读 + PO 确认权):新增角色显示「业务开发」,映射策略实施时定(倾向新增 app 角色 bd,或复用 sales 加部门标)。
③ **新 9 节点模板只对新订单生效**,在途订单走完旧节点(模板版本化)。
④ **QC 打卡隔天一次**;且 **QC 跟哪张订单由生产部主管指定**(新增:订单⇄QC 指派,生产经理在生产启动时指定跟单 QC,打卡任务只派给被指派的 QC)。
