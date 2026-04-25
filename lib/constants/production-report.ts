// 专项报告类型定义（step_key → 显示标签）
// 注意：此文件不是 'use server'，因为 Next.js 'use server' 文件只能导出 async 函数。
// 所以这个常量从 app/actions/production-progress.ts 拆出来放到这里。
export const STEP_REPORT_TYPES: Array<{
  value: string;           // step_key
  label: string;           // 选项显示标签
  icon: string;
  fileType: string;        // 存入 order_attachments.file_type
}> = [
  { value: '', label: '日常进度', icon: '📊', fileType: 'production_report' },
  { value: 'pre_production_sample_ready', label: '封样交付', icon: '👔', fileType: 'sample_photo' },
  { value: 'materials_received_inspected', label: '面料验收', icon: '🧵', fileType: 'fabric_inspection_report' },
  { value: 'production_kickoff', label: '上线确认', icon: '✂️', fileType: 'kickoff_photo' },
  { value: 'mid_qc_check', label: '中查报告', icon: '🔍', fileType: 'mid_qc_report' },
  { value: 'packing_method_confirmed', label: '包装确认', icon: '📦', fileType: 'packing_photo' },
  { value: 'final_qc_check', label: '尾查报告', icon: '✅', fileType: 'final_qc_report' },
  { value: 'inspection_release', label: '出货验货', icon: '🚛', fileType: 'inspection_report' },
];
