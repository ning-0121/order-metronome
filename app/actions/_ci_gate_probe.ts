'use server';
/**
 * ⚠️ 临时探针:验证 CI 门禁真的会红。验证完立即删除。
 * 业务层裸 .from() 应当被 lint:data-access 拦下(基线里没有本文件)。
 */
import { createClient } from '@/lib/supabase/server';

export async function _ciGateProbe() {
  const supabase = await createClient();
  const { data } = await (supabase.from('test_table') as any).select('id').limit(1);
  return data;
}
