// araos → QIMO 赢单交接「通电」验证脚本
// 用法(配好 env 后本机跑;不依赖仓库,纯 node):
//   QIMO_CONTRACT_URL=https://order.qimoactivewear.com \
//   CONTRACT_KEY_ARAOS=araos_xxx CONTRACT_SECRET_ARAOS=xxx \
//   node scripts/verify-araos-handoff.mjs            # 探针模式:验鉴权+签名,不建客户
//   node scripts/verify-araos-handoff.mjs --real     # 真投:建一个「ARAOS通电测试」客户(可事后删)
//
// 判读:
//   探针 → HTTP 400 且 error.code=invalid_body(缺 customer.name)= ✅ 通电(签名/鉴权/端点都对)
//   任意 → HTTP 401 = ❌ env 没配或 key/secret 两仓不一致
//   真投 → HTTP 200 {qimo_customer_id} = ✅ 端到端通(客户已落 QIMO)

import { createHash, createHmac } from 'crypto';

const URL_BASE = process.env.QIMO_CONTRACT_URL;
const KEY = process.env.CONTRACT_KEY_ARAOS;
const SECRET = process.env.CONTRACT_SECRET_ARAOS;
const REAL = process.argv.includes('--real');
const PATH = '/api/contract/v1/handoff/araos';

if (!URL_BASE || !KEY || !SECRET) {
  console.error('❌ 缺 env:需要 QIMO_CONTRACT_URL / CONTRACT_KEY_ARAOS / CONTRACT_SECRET_ARAOS');
  process.exit(1);
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sign = (sec, ss) => createHmac('sha256', sec).update(ss, 'utf8').digest('hex');

// araos 出站真实包裹体(见 araos lib/metronome/client.ts);探针模式故意不给 company_name
const body = REAL
  ? { source: 'araos', entity_type: 'order', entity_id: 'araos-通电测试-001', company_id: 'ping-test',
      idempotency_key: 'araos-通电测试-001',
      data: { type: 'production_order', araos_order_id: 'araos-通电测试-001', araos_company_id: 'ping-test',
              company_name: 'ARAOS通电测试', contact_name: '联调', order_ref: 'PING-001', quantity: 1 },
      sent_at: new Date().toISOString() }
  : { source: 'araos', entity_type: 'order', entity_id: 'araos-probe-001', idempotency_key: 'araos-probe-001',
      data: { type: 'production_order' /* 故意无 company_name → 应 400 */ }, sent_at: new Date().toISOString() };

const raw = JSON.stringify(body);
const ts = Date.now().toString();
const signature = sign(SECRET, [ 'POST', PATH, ts, KEY, sha256(raw) ].join('\n'));

const res = await fetch(URL_BASE + PATH, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'x-timestamp': ts, 'x-signature': signature },
  body: raw,
});
const text = await res.text();
console.log(`\nHTTP ${res.status}`);
console.log(text);

if (res.status === 401) console.log('\n❌ 401 → env 没配 / key 或 secret 两仓不一致。');
else if (!REAL && res.status === 400) console.log('\n✅ 探针通过 → 签名/鉴权/端点都对(400 是故意缺 customer.name,未建客户)。可用 --real 做端到端。');
else if (REAL && res.status === 200) console.log('\n✅ 端到端通 → 客户「ARAOS通电测试」已落 QIMO(可到客户中心确认后删掉测试数据)。');
else console.log('\n⚠️ 非预期结果,把上面 HTTP 状态 + body 贴给我判读。');
