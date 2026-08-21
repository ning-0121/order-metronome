/**
 * 邮件收件箱 / 附件的表访问收口(2026-08-21)。
 *
 * 拆 email-fetch cron 时建的:拉取和分析分成两个路由后,两边都要碰 mail_inbox /
 * mail_attachments。与其各写各的裸 .from(),不如按 lint:data-access 的规矩在这里收口
 * —— 也顺手把「按 message_id 批量去重」这类容易写错的查询变成一个有名字的函数。
 *
 * 这里只做表访问,不含业务判断;调用方自己决定拿到结果后怎么办。
 */

/** 批量查已存在的 message_id。分片 100 个一批(in 列表过长 PostgREST 会拒)。 */
export async function findExistingMessageIds(client: any, messageIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < messageIds.length; i += 100) {
    const { data, error } = await client
      .from('mail_inbox')
      .select('message_id')
      .in('message_id', messageIds.slice(i, i + 100));
    // 查不到就当作"没查到重复",宁可后面 insert 撞唯一键失败,也不要因为一次查询抖动漏掉整批邮件
    if (error) { console.warn('[mailRepo] 批量去重查询失败(按未去重处理):', error.message); continue; }
    for (const r of (data || [])) if (r?.message_id) found.add(r.message_id);
  }
  return found;
}

/** 无 message_id 的邮件回退去重:发件人 + 主题 + 同一天。这类邮件极少,逐封查可接受。 */
export async function existsMailByHeuristic(
  client: any, fromEmail: string, subject: string, dayIso: string,
): Promise<boolean> {
  const { data } = await client
    .from('mail_inbox')
    .select('id')
    .eq('from_email', fromEmail)
    .eq('subject', subject)
    .gte('received_at', `${dayIso}T00:00:00`)
    .lte('received_at', `${dayIso}T23:59:59`)
    .limit(1)
    .maybeSingle();
  return !!data;
}

export interface InboundMailRow {
  from_email: string;
  subject: string;
  raw_body: string | null;
  received_at: string;
  message_id?: string | null;
  in_reply_to?: string | null;
  thread_id?: string | null;
}

/** 写入一封新邮件,返回新行 id。 */
export async function insertInboundMail(
  client: any, row: InboundMailRow,
): Promise<{ id?: string; error?: string }> {
  const { data, error } = await client.from('mail_inbox').insert(row).select('id').single();
  if (error) return { error: error.message };
  return { id: (data as any)?.id };
}

/** 登记一个邮件附件(同一封邮件同名文件覆盖)。 */
export async function upsertMailAttachment(client: any, row: {
  mail_id: string; file_name: string; mime_type: string | null;
  storage_path: string; size_bytes: number | null; is_po: boolean; ocr_status: string;
}): Promise<void> {
  const { error } = await client.from('mail_attachments').upsert(row, { onConflict: 'mail_id,file_name' });
  if (error) console.warn('[mailRepo] 附件登记失败(不阻断):', error.message);
}
