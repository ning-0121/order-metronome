export type CustomerPoAttachmentRow = {
  id: string;
  order_id: string;
  file_type?: string | null;
  file_name?: string | null;
  storage_path?: string | null;
  file_url?: string | null;
  uploaded_by?: string | null;
  created_at?: string | null;
};

export type CustomerPoAuditLogRow = {
  action?: string | null;
  note?: string | null;
  payload?: string | null;
  created_at?: string | null;
  actor_user_id?: string | null;
};

export type CustomerPoVersionStatus = 'active' | 'superseded' | 'withdrawn';

export interface CustomerPoVersionRow {
  id: string;
  version: number;
  status: CustomerPoVersionStatus;
  file_name: string | null;
  uploaded_by: string | null;
  created_at: string | null;
  replaced_by?: string | null;
  replacement_reason?: string | null;
  withdrawn_reason?: string | null;
}

function parsePayload(payload?: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function poStamp(row: CustomerPoAttachmentRow): number {
  return row.created_at ? new Date(row.created_at).getTime() : 0;
}

/**
 * 仅针对 customer_po 附件 + 审计日志，推导版本历史与当前 active 版本。
 * 不改变任何持久化结构，供 UI 展示与测试使用。
 */
export function deriveCustomerPoVersions(
  attachments: CustomerPoAttachmentRow[],
  auditLogs: CustomerPoAuditLogRow[] = [],
): { versions: CustomerPoVersionRow[]; activeVersion: CustomerPoVersionRow | null } {
  const poAttachments = [...attachments]
    .filter((row) => row.file_type === 'customer_po')
    .sort((a, b) => poStamp(a) - poStamp(b) || String(a.id).localeCompare(String(b.id)));

  const metaByAttachment = new Map<string, { status?: CustomerPoVersionStatus; reason?: string; replacedBy?: string | null }>();
  const withdrawn = new Map<string, string>();
  const replacementReason = new Map<string, string>();
  const replacementTarget = new Map<string, string>();

  for (const log of auditLogs || []) {
    const payload = parsePayload(log.payload);
    if (log.action === 'customer_po_replaced') {
      const fromId = String(payload.from_attachment_id || payload.old_attachment_id || '');
      const toId = String(payload.to_attachment_id || payload.new_attachment_id || '');
      if (fromId) {
        metaByAttachment.set(fromId, {
          ...(metaByAttachment.get(fromId) || {}),
          status: 'superseded',
          reason: String(payload.reason || log.note || '').trim() || undefined,
          replacedBy: toId || undefined,
        });
      }
      if (toId) {
        metaByAttachment.set(toId, {
          ...(metaByAttachment.get(toId) || {}),
          status: 'active',
          reason: String(payload.reason || log.note || '').trim() || undefined,
        });
        if (fromId) {
          replacementReason.set(toId, String(payload.reason || log.note || '').trim());
          replacementTarget.set(toId, fromId);
        }
      }
    }
    if (log.action === 'customer_po_withdrawn') {
      const targetId = String(payload.attachment_id || payload.target_attachment_id || payload.from_attachment_id || '');
      if (targetId) {
        withdrawn.set(targetId, String(payload.reason || log.note || '').trim());
        metaByAttachment.set(targetId, {
          ...(metaByAttachment.get(targetId) || {}),
          status: 'withdrawn',
          reason: String(payload.reason || log.note || '').trim() || undefined,
        });
      }
    }
  }

  let activeId: string | null = null;
  for (const row of poAttachments) {
    const meta = metaByAttachment.get(row.id);
    if (meta?.status === 'withdrawn') continue;
    if (meta?.status === 'active') activeId = row.id;
    else if (!activeId) activeId = row.id;
  }
  if (activeId) {
    const activeIndex = poAttachments.findIndex((row) => row.id === activeId);
    if (activeIndex >= 0) {
      for (let i = activeIndex + 1; i < poAttachments.length; i += 1) {
        const row = poAttachments[i];
        if (!withdrawn.has(row.id)) activeId = row.id;
      }
    }
  }

  const versions = poAttachments.map((row, index) => {
    const meta = metaByAttachment.get(row.id);
    const isWithdrawn = withdrawn.has(row.id) || meta?.status === 'withdrawn';
    const isActive = !isWithdrawn && row.id === activeId;
    const status: CustomerPoVersionStatus = isWithdrawn ? 'withdrawn' : isActive ? 'active' : 'superseded';
    return {
      id: row.id,
      version: index + 1,
      status,
      file_name: row.file_name || null,
      uploaded_by: row.uploaded_by || null,
      created_at: row.created_at || null,
      replaced_by: meta?.replacedBy || null,
      replacement_reason: replacementReason.get(row.id) || meta?.reason || null,
      withdrawn_reason: withdrawn.get(row.id) || null,
    };
  });

  return {
    versions,
    activeVersion: versions.find((row) => row.status === 'active') || null,
  };
}
