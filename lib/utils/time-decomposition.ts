import { parseISO, startOfDay } from 'date-fns';
import { IncotermType, OrderType, PackagingType, MilestoneTemplate, UserRole } from '../types';
import { subtractWorkingDays, ensureBusinessDay } from './date';

/**
 * Milestone templates for FOB orders
 */
const FOB_MILESTONE_TEMPLATES: MilestoneTemplate[] = [
  { step_key: 'order_confirmation', name: '订单确认', owner_role: 'sales', is_critical: true, evidence_required: true, days_before_target: 0 },
  { step_key: 'procurement_sheet', name: '采购单', owner_role: 'procurement', is_critical: true, evidence_required: true, days_before_target: 2 },
  { step_key: 'finance_approval', name: '财务审批', owner_role: 'finance', is_critical: true, evidence_required: true, days_before_target: 2 },
  { step_key: 'order_sheet', name: '订单单', owner_role: 'procurement', is_critical: true, evidence_required: true, days_before_target: 3 },
  { step_key: 'production_sheet', name: '生产单', owner_role: 'production', is_critical: true, evidence_required: true, days_before_target: 3 },
  { step_key: 'packaging_spec', name: '包装规格', owner_role: 'procurement', is_critical: false, evidence_required: true, days_before_target: 3 },
  { step_key: 'packaging_materials', name: '包装材料到位', owner_role: 'procurement', is_critical: true, evidence_required: true, days_before_target: 10 }, // Will be adjusted based on packaging type
  { step_key: 'production_start', name: '生产开始', owner_role: 'production', is_critical: true, evidence_required: true, days_before_target: 7 },
  { step_key: 'production_complete', name: '生产完成', owner_role: 'production', is_critical: true, evidence_required: true, days_before_target: 3 },
  { step_key: 'quality_check', name: '质检', owner_role: 'qc', is_critical: true, evidence_required: true, days_before_target: 2 },
  { step_key: 'packaging', name: '包装', owner_role: 'production', is_critical: true, evidence_required: true, days_before_target: 1 },
  { step_key: 'etd', name: 'ETD (预计离港日期)', owner_role: 'sales', is_critical: true, evidence_required: true, days_before_target: 0 },
];

/**
 * Milestone templates for DDP orders
 */
const DDP_MILESTONE_TEMPLATES: MilestoneTemplate[] = [
  { step_key: 'order_confirmation', name: '订单确认', owner_role: 'sales', is_critical: true, evidence_required: true, days_before_target: 0 },
  { step_key: 'procurement_sheet', name: '采购单', owner_role: 'procurement', is_critical: true, evidence_required: true, days_before_target: 2 },
  { step_key: 'finance_approval', name: '财务审批', owner_role: 'finance', is_critical: true, evidence_required: true, days_before_target: 2 },
  { step_key: 'order_sheet', name: '订单单', owner_role: 'procurement', is_critical: true, evidence_required: true, days_before_target: 3 },
  { step_key: 'production_sheet', name: '生产单', owner_role: 'production', is_critical: true, evidence_required: true, days_before_target: 3 },
  { step_key: 'packaging_spec', name: '包装规格', owner_role: 'procurement', is_critical: false, evidence_required: true, days_before_target: 3 },
  { step_key: 'packaging_materials', name: '包装材料到位', owner_role: 'procurement', is_critical: true, evidence_required: true, days_before_target: 10 }, // Will be adjusted
  { step_key: 'production_start', name: '生产开始', owner_role: 'production', is_critical: true, evidence_required: true, days_before_target: 14 },
  { step_key: 'production_complete', name: '生产完成', owner_role: 'production', is_critical: true, evidence_required: true, days_before_target: 7 },
  { step_key: 'quality_check', name: '质检', owner_role: 'qc', is_critical: true, evidence_required: true, days_before_target: 5 },
  { step_key: 'packaging', name: '包装', owner_role: 'production', is_critical: true, evidence_required: true, days_before_target: 3 },
  { step_key: 'warehouse_due_date', name: '仓库到货日期', owner_role: 'sales', is_critical: true, evidence_required: true, days_before_target: 0 },
];

/**
 * Calculate milestone dates based on target date (ETD for FOB, WarehouseDueDate for DDP)
 */
export function calculateMilestoneDates(
  targetDate: string,
  incoterm: IncotermType,
  orderType: OrderType,
  packagingType: PackagingType
): Array<{
  step_key: string;
  name: string;
  owner_role: UserRole;
  planned_at: Date;
  due_at: Date;
  is_critical: boolean;
  evidence_required: boolean;
  sequence_number: number;
}> {
  const templates = incoterm === 'FOB' ? FOB_MILESTONE_TEMPLATES : DDP_MILESTONE_TEMPLATES;
  const target = ensureBusinessDay(startOfDay(parseISO(targetDate)));
  
  const milestones = templates.map((template, index) => {
    let daysBefore = template.days_before_target;
    
    // Adjust packaging materials milestone based on packaging type
    if (template.step_key === 'packaging_materials') {
      if (packagingType === 'custom') {
        // Custom packaging needs 7 more days
        daysBefore += 7;
      }
      // Find production_start milestone to calculate from production_offline - 7 days
      const productionStartTemplate = templates.find(t => t.step_key === 'production_start');
      if (productionStartTemplate) {
        const productionStartDaysBefore = productionStartTemplate.days_before_target;
        daysBefore = productionStartDaysBefore + 7;
      }
    }
    
    const dueDate = subtractWorkingDays(target, daysBefore);
    const plannedDate = subtractWorkingDays(dueDate, 1); // Planned is 1 day before due
    
    return {
      step_key: template.step_key,
      name: template.name,
      owner_role: template.owner_role,
      planned_at: ensureBusinessDay(plannedDate),
      due_at: ensureBusinessDay(dueDate),
      is_critical: template.is_critical,
      evidence_required: template.evidence_required,
      sequence_number: index + 1,
    };
  });
  
  return milestones;
}

/**
 * Get milestone templates for an order type
 */
export function getMilestoneTemplates(incoterm: IncotermType): MilestoneTemplate[] {
  return incoterm === 'FOB' ? FOB_MILESTONE_TEMPLATES : DDP_MILESTONE_TEMPLATES;
}
