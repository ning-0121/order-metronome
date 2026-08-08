# QIMO OS · Reliability Sprint R1 — Final Gate Report(2026-08-09)

## A. Reliability Executive Summary

R1 从"功能很多但会撒谎"的系统,推进到"关键动作可验证、可追溯、可恢复"的可信底座。
六天五阶段(A 灾备 / B 自动化健康 / C 执行完整性 / D 审计证据 / E 真相与权限 / F 最终门禁),
确立了系统的新性质:**系统在动作没有真实完成时不再说"成功"**。R1-F 又对 4 条最高危 suspected
做了代码+生产双证据复核,3 条确认并当场修复(含 1 个 P0)。

## B. R1-A ~ R1-E Gate 回顾

| 阶段 | 成果 | 判定 |
|---|---|---|
| R1-A Backup | 备份从"从未产出"→ 全量+回读验证+健康哨兵;**恢复演练 PASS** | ✅ PASS |
| R1-B Automation | runAutomationJob 统一契约 + watchdog;三个僵尸 cron 复活(业务产出实证) | ✅ PASS |
| R1-C Mutation | safeMutation/safeCriticalMutation;主干 silent-success=0;65 处棘轮冻结 | ✅ PASS w/ residual |
| R1-D Audit | writeAuditEvent(A0/A1/A2)+ actor 收口 + 反查链生产实证 | ✅ PASS |
| R1-E Truth & Perm | 5 处截断修复(76%→72% 对账)+ 权限 Matrix + 敏感字段投影 | ✅ PASS |

## C. Restore Drill Result

真实备份 → drill_* 隔离表 → **9.4s 恢复 6,240 行**;行数 5/5、UUID/时间/JSON/JSONB/中文/nullable
全保真;3 单关联链与生产逐一相符;孤儿外键 0 → **PASS**。RPO ≈ 24h。
未覆盖(R2):Storage 文件本体、auth 凭据、外部系统状态。Runbook:docs/runbooks/restore-runbook.md。

## D. CONFIRMED 26 Closure Matrix

详见 docs/audit/r1f-closure-matrix.md。汇总:
- **P0:6/6 closed**
- **P1:9 closed + 1 mitigated(orders RLS→R2 设计)+ 1 open(1022839 重复单,待 CEO 决策)**
- **P2:7 closed + 2 open(死 UI 清理→R2)**
- 任何 P0 无 open。open 项均非执行链路(业务决策 / 死 UI)。

## E. 4 Suspected Verification Results

| # | 主张 | 判定 | 定级 | 处置 |
|---|---|---|---|---|
| S1 | 放货闸全站不可达 | **CONFIRMED**(比主张更重:连 admin 都无入口) | P0 | ✅ 已修(财务批准接通闸) |
| S2 | 一键出货绕财务/QC/物流闸 | **CONFIRMED**(merchandiser 已用 14 次) | P1 | ✅ 已修(非 admin 堵闸) |
| S3 | 制造单泄客户价/采购价 | **CONFIRMED**(admin_assistant/生产主管可拉) | P1 | ✅ 已修(按 CAN_SEE_FINANCIALS 剥价) |
| S4 | 件数少算 55,244 | **CONFIRMED**(3 单明细缺录,100% 复现) | P2 | 留数据修正(已产品化暴露) |

## F. Executive OS Mutation Blocker Debt

critical debt 总数 23(全在 orders/purchase_orders/order_financials/order_amendments 表)。
按"V1 是否会调用"分类:
- **A 类(V1 会调用)= 0 residual**:V1 允许能力(见 I)不包含改价/改量/PO/财务写 ——
  这些命令若将来纳入,必须先走 Business Command 迁移。当前 V1 不触达。
- **B 类(V1 不会调用)= 23**:全部是人工低频维护/后台路径,棘轮冻结,只出不进。
- **C 类(不确定)= 0**。
结论:**V1 blockers before/after = 0 / 0**(V1 能力边界不触达这 23 处);remaining non-V1 debt = 23(冻结)。

## G. Agent / Tool Execution Safety

- Agent 执行入口 `agent-execute.ts`:8 种动作,**全部需人工点击执行**(executed_by=user.id),
  无自动执行;熔断限流(单单/全局计数)在位;历史"runAgentLoop→executeToolCall 绕审批"的
  P0 在当前 HEAD 不存在(该链路无自动 DB mutation)。
- Agent 写业务表的动作(assign_owner/create_delay_draft 等)走 delay_requests 草稿/pending,
  **不直接终态化钱/发货**;customer_memory 等为 AI 记忆表(非业务真相)。
- ⚠ 待硬化(V1 前置):agent-execute 的 assign_owner 等仍直接 `.from('milestones').update()`,
  未走 safeCriticalMutation。**V1 授予 Agent 任何写权限前,这些必须迁入 Business Command。**
  当前判定:Agent 只读 + 人工确认执行 = 可接受;Agent 自主写 = 未就绪。

## H. Remaining Known Risks

1. orders UPDATE RLS 仍 2024 老版(confirmed 6 路径已用 B 模式绕过;全面重写=R2)
2. 65 处 critical direct-write + 31 处审计裸插 + 41 处 truth 存量,均棘轮冻结(只出不进)
3. 备份未覆盖 Storage 文件本体 / auth 凭据(R2)
4. watchdog 与 nightly 同宿主(需第二监控平面,R2)
5. 1022839 重复单待 CEO 决策;死 UI(复盘链/BatchActions/邮件页)待清
6. S4 三单件数缺录(数据修正)

## I. Executive OS V1 Allowed Capabilities

**ALLOW(当前底座已支撑)**:
- 语音捕获 / 只读检索 / 任务创建(内部)/ 内部提醒 / CEO 简报 /
- 低风险委托(读、汇总、生成草稿)/ 已迁 Business Command 的审批**建议**(人工点批)

**RESTRICT(V1 不授予自主执行)**:
- 对外发送客户消息 / 改价 / 发货放行 / 财务承诺 / 任何不可逆动作 /
- Agent 自主写业务表(assign_owner 等须先迁 Business Command)

## J. Final Decision

# ✅ READY WITH RESTRICTIONS

**理由**:
- 五道 Gate + 恢复演练全部 PASS;26 条 confirmed 的 P0 全 closed,无执行链路 open;
- 4 条最高危 suspected 复核完毕,确认的 3 条(含 P0 放货闸)已当场修复上线;
- 可信底座十层(见下)无 FAIL;
- V1 mutation blocker 对 V1 能力边界 = 0。

**限制条件(必须同时成立)**:
1. V1 只开放 ALLOW 清单;RESTRICT 清单一律人工执行,Agent 仅出建议
2. 授予 Agent 任何"自主写"能力前,必须先完成 agent-execute 写路径迁入 Business Command(G 节)
3. R2 需处理:Storage/auth 备份、第二监控平面、orders RLS 重写、debt 棘轮清零、死 UI/重复单

**十层就绪度**:Backup ✅ / Automation ✅ / SafeMutation 🟡PARTIAL(主干✅,65债冻结)/
Audit ✅ / TruthQuery ✅ / Permission 🟡PARTIAL(confirmed✅,RLS 全面重写=R2)/
Sensitive Projection ✅ / Business Command Boundary 🟡PARTIAL(高危✅,agent 写路径待迁)/
Failure Injection ✅ / Production Smoke ✅ —— **无 FAIL,PARTIAL 已由 I 节限制边界兜住**。

Reliability Sprint R1 正式结束。下一步进入 QIMO Executive OS V1(CEO Delegation Loop),
在上述限制边界内开发,不再主动扩修历史技术债。
