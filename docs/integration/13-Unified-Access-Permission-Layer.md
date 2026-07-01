# 13 — QIMO OS Unified Access & Permission Layer（统一登录·分权进入·多系统数据链与审批流）

> **Date**: 2026-07-01 · 三仓库统一入口/权限/待办的**规范源**。
> **定位**：盖在现有联邦集成脊柱（doc 05/07/10）之上的**接入与权限层**。三系统仍各自独立 repo + 独立 Supabase，**不合并、不共用 Supabase**。
> **不是**：❌ 系统合并 ❌ 只放链接的门户壳。

---

## 1. 四支柱与现状（延展现有，不重造）

| 支柱 | 已有底座 | 缺口 |
|---|---|---|
| **① 统一身份** | DB 身份脊柱（0a，15 共享 ID 列，惰性）；QIMO Supabase cookie 登录 + 域限制 | 跨系统 SSO（本层核心） |
| **② 统一权限** | `lib/domain/roles.ts` ROLE_GROUPS + RLS；Contract API 系统级 scope | 跨仓库统一角色 + 三层 RBAC |
| **③ 统一数据链** | 共享 ID + Contract API v1（HMAC 签名，只读端点） | 激活/回填/开桥（现有 roadmap，非本层新建） |
| **④ 统一审批/待办** | Handoff Queue 设计（doc 10，无 auto-approve） | 中央待办收件箱 + 状态回流 |

## 2. SSO 决策：方案 C（中央 QIMO OS Portal 令牌）
- **Phase A 选 C**：QIMO OS 作统一入口，登录一次 → 按角色显示可进系统 → 外部系统（finance/araos）经**短时签名 token / 受控跳转**免二次登录。
- **企业微信 SSO 留 Phase 2**（不作第一步阻塞）；员工身份锚 = QIMO 邮箱（Phase 2 换 WeCom 目录）。

## 3. 分期
| 期 | 内容 | 状态 |
|---|---|---|
| **A** | 统一入口 `/hub` + 角色识别 + 分权显示 + 受控跳转/短时 token（QIMO 侧） | **本文实现** |
| B | 三层 RBAC（模块/字段/动作）统一角色目录 | 待定 |
| C | 中央待办聚合 + 审批状态回流主链（扩 handoff_queue） | 待定 |
| （并行） | 数据链激活（回填/开桥/财务回流） | 现有 roadmap doc 04 |

---

## 4. Phase A 实现（QIMO 侧，已落地）

### 4.1 组件
| 文件 | 职责 |
|---|---|
| `lib/os/systems.ts` | 系统注册表 + `visibleSystemsForRoles` / `canEnterSystem` / `resolveHref`（纯） |
| `lib/os/token.ts` | 短时 token `signClaims` / `verifyToken`（HMAC-SHA256，无状态） |
| `app/hub/page.tsx` + `HubClient.tsx` | 统一入口页：按角色渲染系统卡片 |
| `app/api/os/handoff/route.ts` | 校验会话 + 角色 → 铸 token → 302 到目标 accept（无 secret 则降级为普通跳转） |

### 4.2 系统 × 角色（Phase A 初版）
| 系统 | kind | 可进角色 |
|---|---|---|
| 业务开发 araos | external | sales / sales_manager / admin |
| 订单执行 QIMO | internal(`/dashboard`) | sales / merchandiser / production / order_manager / admin |
| 采购 QIMO | internal(`/procurement`) | procurement / procurement_manager / finance / admin |
| 生产 QIMO | internal(`/factories`) | production / qc / production_manager / merchandiser / admin |
| 财务 finance | external | finance / admin |

> 角色值取自 `roles.ts`；只做"能否进模块"这一层。字段/动作层属 Phase B。

### 4.3 环境变量
```
OS_ARAOS_URL / OS_FINANCE_URL          # 外部系统基址
OS_TOKEN_SECRET_ARAOS / OS_TOKEN_SECRET_FINANCE   # 每目标独立 HMAC 密钥
```
未配 URL → 卡片 503（不崩）；未配 secret → 降级为普通受控跳转（不带 token）。

---

## 5. 外部 accept 端点规范（供 finance / araos 团队在**各自 repo** 实现；本阶段不改其代码）

QIMO 铸的 token 结构：`base64url(claims JSON) + "." + HMAC-SHA256-hex(canonical)`。

**claims**
```json
{ "sub": "员工邮箱", "roles": ["..."], "aud": "<本系统id: finance|araos>", "iat": 1234567890, "exp": 1234567980, "nonce": "uuid" }
```

**canonical 串**（铸/验必须一致）
```
sub \n roles.join(',') \n aud \n iat \n exp \n nonce
```

**目标 `GET /api/os/accept?token=...` MUST**：
1. 拆 token → 验 HMAC-SHA256（用与 QIMO 约定的 `OS_TOKEN_SECRET_<SYS>`，恒定时间比较）。
2. 校验 `aud === 本系统id`（防跨目标重放）、`nowSec ≤ exp`、`iat ≤ now+60`。
3. 以 `sub`（邮箱）映射到本地用户，建**本地会话**，重定向到本系统首页。
4. 任一校验失败 → 拒绝并跳本系统登录页。

**参考实现**：QIMO `lib/os/token.ts::verifyToken` 即验证参考，目标用同算法复刻。

**过渡**：目标未实现 accept 时，QIMO 侧自动降级为普通受控跳转（目标走自有登录），**不影响使用**。

---

## 6. 红线（守宪）
- ❌ 不合并/共用 Supabase；三系统联邦。
- ❌ AI 不跨系统写真相。
- ✅ 每系统只拥有自己真相，跨系统 id 引用 + 契约读。
- ✅ 身份/角色单一真相源，各系统映射不各写。
- ✅ Phase A **不改现有登录默认跳转**（`/hub` 为新增可选入口）。

## 7. 残余 / 后续
- token 重放硬化（nonce 落库）→ 需 DB，Phase A 用短时(90s)+aud 绑定替代，列 Phase A+。
- finance/araos 的 accept 端点 = 对方 repo 工作，未完成前走降级跳转。
- 登录默认落地是否切到 `/hub`：`/hub` 验证稳定后再定（Phase A 不动）。
- 企业微信 SSO：Phase 2。
