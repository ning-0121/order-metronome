# QIMO OS Constitution V1.0 (Final)

> **Status**: Frozen　**Version**: 1.0　**Priority**: Highest　**Date**: 2026-06-28
>
> 本文件是 QIMO OS 的**最高设计原则**。当任何设计与本文件冲突时,**以 Constitution 为准**。
> 所有 Claude / ChatGPT / Cursor / Agent / 开发者必须遵守。
> **Constitution 永远控制在 10 条以内。** 新原则不得直接加入,必须先进 ADR,经多阶段验证后才允许升级进 Constitution(见文末 + `../CLAUDE.md` 开发纪律)。

---

## QIMO Philosophy

- QIMO OS **不管理部门**。QIMO OS **管理业务对象(Business Objects)**。
- 部门会变化,组织会调整;**系统始终围绕业务对象构建**。
- 所有业务数据只有一个真相源(**Single Source of Truth**)。

---

## Constitution 01 — Business Objects First
订单中心永远**围绕业务对象**设计,**禁止围绕部门**设计。
订单域只有三个核心对象:

```
Customer Order  →  Material Package  →  Manufacturing Order
```

**不得创建第四个订单对象。**

## Constitution 02 — Single Source of Truth
每一个业务对象只能存在**一份真相**。
禁止 Business BOM / Procurement BOM / Production BOM 等**多份数据长期并存**。
**允许生命周期,禁止复制维护。**

## Constitution 03 — Lifecycle Instead of Copy
业务对象随**生命周期**不断完善,而非复制生成新对象:

```
Business Draft  →  Reviewing  →  Confirmed  →  Executing  →  Closed
```

是**生命周期推进**,不是复制。

## Constitution 04 — Field Ownership
同一个对象、不同字段、属于不同部门:
- **业务**维护:客户要求、预计单耗
- **采购**维护:Lead Time、MOQ、Supplier、最终采购单耗
- **仓库**维护:到料数量
- **生产**维护:实际消耗

**禁止跨职责修改字段。**

## Constitution 05 — Evidence Is Not Data
PO / Tech Pack / Word / Excel / PDF / 图片 / 视频 / 邮件 / 聊天记录,**全部都是 Evidence**。
Evidence 永远不能作为业务数据。**真正的数据必须结构化。**

## Constitution 06 — AI Is Assistant
AI 可以解析、推荐、补全、分析;**不能直接成为真相源**。
任何结构化数据**必须经过人工确认**。

## Constitution 07 — Manufacturing Order Definition
Manufacturing Order **不是**工艺、不是 MES、不是 SOP、不是 IE。
它只是**企业内部生产任务**,负责把**客户需求翻译成企业执行语言**。

## Constitution 08 — Domain Responsibility
- **Order Domain** 负责**表达需求**。
- **Production Domain** 负责**实现需求**:SMV / IE / MES / 工艺 / 吊挂 / 工位 / SOP。

这些**不得进入 Order Domain**。

## Constitution 09 — Build Once, Generate Everywhere
所有模板(生产任务单 / 原辅料单 / 采购单 / QC / 包装资料 / 客户确认版 / PDF / Excel / Word)
全部来自 `Customer Order + Material Package + Manufacturing Order`。
**模板只是表现形式,不是数据。**

## Constitution 10 — Evolution Instead of Rewrite
任何升级必须是 **Evolution**,不是 Rewrite。
优先**新增 / 扩展 / 兼容**,禁止推倒重来。**历史数据必须可继续使用。**

---

## End — 修宪纪律

任何新的架构原则,**不得直接加入 Constitution**。必须先进入 **ADR**,经过验证以后,才能升级 Constitution。

> 开发纪律(放在开发规范,不在宪法):当发现新的设计方向时,**优先修改 Domain Design 或 ADR**,而不是频繁修改 Constitution。只有经过多个阶段验证、确认能长期成立的原则,才允许升级进入 Constitution。

— 这样 Constitution 会越来越**稳定**,而不是越来越长;变化快的内容沉淀到 ADR 与 Domain Design。
