# araos → QIMO 赢单交接桥 · 实现设计清单

> **来源**:2026-07-04 全企业 OS 审计(见 `docs/Enterprise-OS-Audit-2026-07-04.md` C3/C4/C5)。
> **决策(用户已拍板)**:**A 方案** —— araos 改打 QIMO 的**签名契约端点**(复用契约 API 的 HMAC),
> QIMO 当集成中枢。③契约 API 本就为此激活(仅 handoff 这条,不迁移现有财务 webhook)。
> **本文件是自包含实现清单**,可在新对话中直接照做(跨 QIMO + araos 两仓)。

---

## 0. 一句话目标
araos 赢单/出样时,把「客户 + PO/订单」**自动、签名、幂等**地推进 QIMO 建单,
两端回填共享 ID,失败可重试可见 —— 取代现状「只能人工搬 3 步 + 失败静默丢」。

---

## 1. 现状(两仓已有什么,别重造)

### QIMO 侧(order-metronome)
- 契约 API v1:`app/api/contract/v1/`,现有路由**全是 GET 只读**(orders/customers/quotes/finance/order-snapshot)。
- 鉴权 `app/api/contract/v1/_lib/auth.ts`:
  - **已预留 araos 消费者密钥**:`CONTRACT_KEY_ARAOS` + `CONTRACT_SECRET_ARAOS`,scope=`COMMERCIAL_READ`(见 auth.ts:34-36)。
  - 签名串 `buildSignString(method, path, timestamp, apiKey)` = `[METHOD, path, timestamp, apiKey].join('\n')`;`createHmac('sha256', secret).update(payload).digest('hex')`。
  - Header:`x-api-key`(token)、`x-signature`(HMAC)、timestamp;漂移窗口 `DRIFT_MS=300_000`(±5min);`timingSafeEqual`。
  - **注意**:GET 无 body,签名串不含 body → **POST 写必须扩展**(见 §3.1)。
  - 包装器 `_lib/withContract.ts`、scope 定义 `_lib/scopes.ts`、日志 `_lib/log.ts`、响应 `_lib/response.ts`。
- 建单入口:`lib/order/intake-router.ts`(现仅 `order-from-po.ts` 用);OS Kernel/BridgeSession。
- 共享 ID 列:`customers.source_araos_company_id`(migration `20260629_phase0a`,**只被 SELECT,从无 INSERT/UPDATE**)。
- 0c 交接队列设计:`docs/integration/10`(migration + 路由 + 匹配引擎**均未建**,本文件落地其精简版)。

### araos 侧(~/Projects/终极版客户开发系统/araos)
- 出站桥:`lib/metronome/client.ts` —— 现 POST `METRONOME_WEBHOOK_URL` + `Authorization: Bearer`(**无 HMAC**),目标路径占位 `/api/intake`(QIMO 无此路由)。`METRONOME_WEBHOOK_URL` 未配=默认关。
- payload 构造:`lib/metronome/payloads.ts`(现只带 `araos_order_id`)。
- 落库:`metronome_handoffs` 表(status `pending`/`error`)。**error 永不重试,全仓无 UI/health/审计读该表**(审计 P0)。
- 触发点:`confirmOrder` 时推送(`pushed_to_metronome` 布尔防重)。
- 身份脊柱:migration `018_phase0a_identity_spine.sql` 加了 `companies.qimo_customer_id`/`qimo_order_id`/`qimo_entity_id`/`qimo_ack_at`(**只加列,未接线**)。

---

## 2. 目标架构

```
araos.confirmOrder
  → 构造 handoff payload(客户+订单+araos ID + 幂等键)
  → HMAC 签名(契约口径,含 body hash)
  → POST {QIMO}/api/contract/v1/handoff/araos   [x-api-key/x-signature/timestamp]
      → QIMO 校验签名+scope+时间戳+幂等键
      → 落 araos_handoffs_inbox(幂等唯一约束)
      → upsert 客户(写 source_araos_company_id)+ 建 PO/订单草稿(intake-router)
      → 200 { qimo_customer_id, qimo_order_id, qimo_entity_id }
  → araos 回写 companies.qimo_customer_id/qimo_ack_at,置 handoff=done
  ↓ 失败(非2xx/超时)
  → 置 handoff=error + attempts++ + next_retry_at;后台重试(退避);/system 可见
```

---

## 3. QIMO 侧任务

### 3.1 扩展契约鉴权支持 POST 写(auth.ts / withContract.ts)
- 签名串对有 body 的请求追加 **body sha256**:`[METHOD, path, timestamp, apiKey, sha256(rawBody)].join('\n')`(GET 保持不变,兼容现有只读路由)。araos 端按同口径签。
- 新增**写 scope**:`scopes.ts` 加 `HANDOFF_WRITE`(或 `COMMERCIAL_WRITE`);给 araos 消费者追加该 scope(auth.ts:36 那条 araos key 的 scope 从纯 `COMMERCIAL_READ` 扩为含 handoff 写)。
- `withContract` 支持 POST + 传 rawBody 给签名校验。

### 3.2 幂等表 + 建单接收路由
- **新 migration** `araos_handoffs_inbox`:`(id, araos_order_id UNIQUE, araos_company_id, payload jsonb, status, qimo_customer_id, qimo_order_id, received_at, processed_at, error)`。唯一约束 `araos_order_id` 做幂等(重投同单→命中→返回已建结果,不重复建单)。
- **新路由** `app/api/contract/v1/handoff/araos/route.ts`(POST,走 withContract + HANDOFF_WRITE):
  1. 校验签名/scope/时间戳(§3.1)。
  2. 幂等:`araos_order_id` 已存在 → 直接返回已存的 `qimo_customer_id/qimo_order_id`(200)。
  3. upsert 客户:按 `source_araos_company_id` 优先匹配(**这是 C5 接线的关键——终于写入这列**),无则按名+新建;写回 `source_araos_company_id`。
  4. 建 PO/订单草稿:复用 `lib/order/intake-router.ts` / order-from-po 的建单逻辑(Order 是 PO 派生物,不重算 —— 见 [[quote-po-order-chain-live]] 铁律)。
  5. 落 `araos_handoffs_inbox`(status=processed)+ 返回 `{ qimo_customer_id, qimo_order_id, qimo_entity_id }`。
  6. 全程失败要返回明确 4xx/5xx(让 araos 重试),不静默吞。

### 3.3 字段映射(araos payload → QIMO 建单)
- 需和 araos payloads.ts 对齐:客户(名/联系人/联系方式)、订单(客户 PO 号/款/数量/交期/币种)、araos_company_id、araos_order_id、幂等键。
- **口径一致性**:枚举/单位/币种两端必须一致(审计 C:契约漂移风险)。在 `docs/integration/` 补一份字段契约表(或复用 Business-Chain-Contract-V1.0)。

---

## 4. araos 侧任务
### 4.1 重写 `lib/metronome/client.ts`
- 改为**契约 HMAC 签名**(与 QIMO §3.1 同口径:`[METHOD, path, timestamp, apiKey, sha256(body)].join('\n')`),Header `x-api-key`=`CONTRACT_KEY_ARAOS` / `x-signature` / timestamp。
- 目标 URL:`{QIMO_CONTRACT_URL}/api/contract/v1/handoff/araos`(替换旧 `METRONOME_WEBHOOK_URL` + `/api/intake`)。
- 成功:解析 `{qimo_customer_id, qimo_order_id, qimo_entity_id}` → 回写 `companies.qimo_customer_id/qimo_ack_at`(**C5 接线 araos 侧**),置 handoff=done。
### 4.2 修 handoff 重试 + 可见(审计 P0-1/C4)
- `metronome_handoffs` 加 `attempts`/`next_retry_at`;`processPendingHandoffs`(workers/queue-worker.ts)**把 error 态纳入重试**(带上限+指数退避)。
- `health.ts` 加 error 计数告警;`/system`(或 today)暴露 handoff 队列,失败可见可手动重投。

---

## 5. 环境变量(两仓都要,值必须一致)
| 变量 | QIMO | araos | 说明 |
|---|---|---|---|
| `CONTRACT_KEY_ARAOS` | ✅ | ✅ | araos 消费者 token(非密钥,走 x-api-key) |
| `CONTRACT_SECRET_ARAOS` | ✅ | ✅ | HMAC 密钥,两端相同 |
| `QIMO_CONTRACT_URL` | — | ✅ | 指向 QIMO 生产域名(https://order.qimoactivewear.com) |
- araos 旧 `METRONOME_WEBHOOK_URL` 废弃。
- 生成一对强随机 key/secret,分别配到两仓 Vercel env。

---

## 6. 幂等 + 错误/重试(硬要求)
- **幂等键 = `araos_order_id`**(稳定实体键),QIMO 唯一约束兜底;重投同单不重复建单(参照 QIMO finance-sync 刚做的内容确定性键思路 `c13392d`)。
- araos 失败(非 2xx/超时/网络)→ error + 重试(退避,上限如 5 次)+ 可见告警。**绝不 fire-and-forget 丢单**。
- QIMO 侧建单任一步失败 → 返回 5xx(触发 araos 重试),不落半成品。

---

## 7. 测试
1. **签名自测**:先用 QIMO 现有 `test.ping` 口径确认新 POST 签名(含 body hash)两端一致(araos 签、QIMO 验 PASS)。
2. **幂等**:同一 araos_order_id 连推两次 → QIMO 只建一单,第二次返回同 ID。
3. **端到端**:araos 造一个赢单 → confirmOrder → QIMO 出现客户+PO草稿,两端 ID 互相回填。
4. **失败重试**:QIMO 端临时 500 → araos handoff=error → 重试后恢复 → done。
5. **越权**:无签名/错签名/过期时间戳 → QIMO 401/403。

---

## 8. 上线顺序(避免断链)
1. QIMO 先建 `araos_handoffs_inbox` migration + handoff 路由 + 鉴权扩展 → 部署(**此时无人调,零影响**)。配 QIMO 侧 env。
2. 联调签名自测(§7.1)PASS。
3. araos 改客户端 + 配 env → 部署。旧 `METRONOME_WEBHOOK_URL` 同时移除。
4. 造单端到端验证 → 打开(移除 araos 侧的"默认关")。
5. 观察 handoff 队列几天,确认无 error 堆积。

---

## 9. 留给新对话的待定项
- **建单落点**:handoff 直接建 PO 草稿,还是先落 `araos_handoffs_inbox` 待人工/自动"匹配确认"再建(0c 设计的 matching 引擎)?建议**先直接建草稿**(简单),matching 后置。
- **客户匹配**:`source_araos_company_id` 命中优先;无则按名 + 阈值?同名不同客户如何防撞(审计 C5 痛点)。
- **PO 号来源**:用 araos 的客户 PO 号,还是 QIMO 生成 internal_order_no?(参照现有建单口径)。
- **字段契约**:是否单开一份 araos↔QIMO 字段/枚举/单位契约表冻结口径。

> 关联:[[quote-po-order-chain-live]](Order 是 PO 派生物不重算)· [[enterprise-integration-repos]](三仓靠共享 ID+契约融合)· `docs/integration/10`(0c 原设计)· `docs/integration/07/09`(契约 API)。
