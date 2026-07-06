'use client';

/** 业务员一键导出「分批出货剩余待出」(跨订单,精确到款色 + 所属订单 + 生产工厂)。先预览再下载。 */

import { ExportPreviewButton } from '@/components/ExportPreviewButton';
import { exportLeftoverGoods } from '@/app/actions/leftover-goods';

export function LeftoverExportButton() {
  return (
    <ExportPreviewButton
      label="📦 分批出货剩余待出"
      className="rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-800 hover:bg-teal-100 disabled:opacity-50"
      fetcher={exportLeftoverGoods}
    />
  );
}
