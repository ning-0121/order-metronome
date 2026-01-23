'use client';

import { formatDate, isOverdue } from '@/lib/utils/date';
import { MilestoneActions } from './MilestoneActions';
import { DelayRequestForm } from './DelayRequestForm';
import { EvidenceUpload } from './EvidenceUpload';
import { getMilestoneLogs } from '@/app/actions/milestones';
import { useState, useEffect } from 'react';
import type { Milestone } from '@/lib/types';

interface OrderTimelineProps {
  milestones: Milestone[];
  orderId: string;
  orderIncoterm: 'FOB' | 'DDP';
  currentRole?: string;
  isAdmin?: boolean;
}

// Define milestone groups (V1 托底闭环)
const MILESTONE_GROUPS = [
  {
    key: 'setup',
    title: 'A. Order Setup Chain',
    titleCn: '订单启动链',
    stepKeys: [
      'po_confirmed',
      'finance_approval',
      'order_docs_complete',
      'rm_purchase_sheet_submit',
      'finance_purchase_approval',
      'procurement_order_placed',
      'materials_received_inspected',
    ],
  },
  {
    key: 'pps',
    title: 'B. PPS & Start Production',
    titleCn: '产前样与生产启动',
    stepKeys: ['pps_ready', 'pps_sent', 'pps_customer_approved', 'production_start'],
  },
  {
    key: 'production',
    title: 'C. Production → Shipping',
    titleCn: '生产与出货准备',
    stepKeys: [
      'mid_qc_check',
      'final_qc_check',
      'packaging_materials_ready',
      'packing_labeling_done',
      'booking_done',
    ],
  },
  {
    key: 'ship',
    title: 'D. Ship & Payment',
    titleCn: '出货与收款',
    stepKeys: ['shipment_done', 'payment_received'],
  },
];

export function OrderTimeline({ milestones, orderId, orderIncoterm, currentRole, isAdmin = false }: OrderTimelineProps) {
  const [expandedMilestone, setExpandedMilestone] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, any[]>>({});

  useEffect(() => {
    // Load logs for expanded milestone
    if (expandedMilestone) {
      getMilestoneLogs(expandedMilestone).then((result) => {
        if (result.data) {
          setLogs((prev) => ({ ...prev, [expandedMilestone]: result.data }));
        }
      });
    }
  }, [expandedMilestone]);

  // 状态颜色映射（只使用中文状态）
  const getStatusColor = (status: string): string => {
    if (status === '未开始') return 'bg-gray-100 text-gray-800';
    if (status === '进行中') return 'bg-blue-100 text-blue-800';
    if (status === '已完成') return 'bg-green-100 text-green-800';
    if (status === '卡住') return 'bg-orange-100 text-orange-800';
    return 'bg-gray-100 text-gray-800';
  };

  // Group milestones by section
  const groupedMilestones = MILESTONE_GROUPS.map((group) => {
    const groupMilestones = milestones
      .filter((m) => group.stepKeys.includes(m.step_key))
      .sort((a, b) => {
        // Sort by due_at within each group
        if (!a.due_at && !b.due_at) return 0;
        if (!a.due_at) return 1;
        if (!b.due_at) return -1;
        return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
      });
    return { ...group, milestones: groupMilestones };
  });

  return (
    <div className="space-y-6">
      {groupedMilestones.map((group) => (
        <div key={group.key} className="space-y-3">
          {/* Section Header */}
          <div className="border-b-2 border-gray-300 pb-2">
            <h3 className="text-xl font-bold text-gray-900">{group.titleCn}</h3>
            <p className="text-sm text-gray-600">{group.title}</p>
          </div>

          {/* Milestones in this group */}
          {group.milestones.length > 0 ? (
            <div className="space-y-3">
              {group.milestones.map((milestone) => {
                const overdue = milestone.due_at ? isOverdue(milestone.due_at) : false;
                const isBlocked = milestone.status === '卡住';
                const isExpanded = expandedMilestone === milestone.id;
                const milestoneLogs = logs[milestone.id] || [];
                const isCritical = milestone.is_critical;
                const isInProgress = milestone.status === '进行中';

                // Visual emphasis: border color based on status
                let borderColor = 'border-gray-200';
                if (isBlocked) {
                  borderColor = 'border-orange-400 border-2';
                } else if (overdue && isInProgress) {
                  borderColor = 'border-red-400 border-2';
                } else if (isCritical) {
                  borderColor = 'border-red-200';
                }

                return (
                  <div
                    key={milestone.id}
                    id={`milestone-${milestone.id}`}
                    className={`rounded-lg border ${borderColor} bg-white p-4 text-gray-900 ${
                      isBlocked || (overdue && isInProgress) ? 'bg-orange-50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="font-semibold text-lg text-gray-900">
                            {milestone.name}
                          </span>
                          {/* Status Badge */}
                          <span
                            className={`text-xs px-2 py-1 rounded font-medium ${getStatusColor(
                              milestone.status
                            )}`}
                          >
                            {milestone.status}
                          </span>
                          {/* Critical Badge */}
                          {isCritical && (
                            <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded font-medium">
                              Critical
                            </span>
                          )}
                          {/* Overdue Badge */}
                          {overdue && isInProgress && (
                            <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded font-medium">
                              Overdue
                            </span>
                          )}
                          {/* Blocked Badge */}
                          {isBlocked && (
                            <span className="text-xs bg-orange-100 text-orange-800 px-2 py-1 rounded font-medium">
                              Blocked
                            </span>
                          )}
                        </div>

                        {/* Milestone Details */}
                        <div className="grid grid-cols-2 gap-2 text-sm text-gray-700 mt-3">
                          <div>
                            <span className="font-medium text-gray-600">Owner:</span>{' '}
                            <span className="text-gray-900">{milestone.owner_role}</span>
                          </div>
                          {milestone.due_at && (
                            <div>
                              <span className="font-medium text-gray-600">Due:</span>{' '}
                              <span
                                className={`text-gray-900 ${
                                  overdue && isInProgress ? 'text-red-700 font-semibold' : ''
                                }`}
                              >
                                {formatDate(milestone.due_at)}
                              </span>
                            </div>
                          )}
                          {milestone.planned_at && (
                            <div>
                              <span className="font-medium text-gray-600">Planned:</span>{' '}
                              <span className="text-gray-900">
                                {formatDate(milestone.planned_at)}
                              </span>
                            </div>
                          )}
                          {milestone.evidence_required && (
                            <div className="col-span-2">
                              <span className="text-blue-700 font-medium">📎 Evidence required</span>
                            </div>
                          )}
                        </div>

                        {/* Blocked reason */}
                        {isBlocked && milestone.notes && (
                          <div className="mt-2 p-2 bg-orange-100 rounded">
                            <p className="text-orange-800 text-sm font-medium">
                              <span className="font-semibold">卡住原因:</span>{' '}
                              {milestone.notes.startsWith('卡住原因：')
                                ? milestone.notes.substring(5)
                                : milestone.notes}
                            </p>
                          </div>
                        )}
                      </div>

                      <div className="ml-4">
                        <button
                          onClick={() =>
                            setExpandedMilestone(isExpanded ? null : milestone.id)
                          }
                          className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                        >
                          {isExpanded ? 'Hide' : 'View'} Details
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-4 space-y-4 border-t border-gray-200 pt-4">
                        {/* Evidence Upload Section */}
                        <EvidenceUpload
                          milestoneId={milestone.id}
                          orderId={orderId}
                          evidenceRequired={milestone.evidence_required || false}
                        />

                        <MilestoneActions 
                          milestone={milestone} 
                          currentRole={currentRole}
                          isAdmin={isAdmin}
                        />

                        {milestone.status !== '已完成' && (isAdmin || (currentRole && currentRole.toLowerCase() === milestone.owner_role?.toLowerCase())) && (
                          <div className="bg-gray-50 p-4 rounded">
                            <h4 className="font-semibold mb-2 text-gray-900">Request Delay</h4>
                            <DelayRequestForm
                              milestoneId={milestone.id}
                              milestone={milestone}
                              orderIncoterm={orderIncoterm}
                              milestoneDueAt={milestone.due_at || null}
                            />
                          </div>
                        )}

                        <div className="bg-gray-50 p-4 rounded">
                          <h4 className="font-semibold mb-2 text-gray-900">Activity Log</h4>
                          {milestoneLogs.length > 0 ? (
                            <div className="space-y-2">
                              {milestoneLogs.map((log: any) => (
                                <div
                                  key={log.id}
                                  className="text-sm border-l-2 border-gray-300 pl-4 bg-white p-2 rounded"
                                >
                                  <p className="font-medium text-gray-900">{log.action}</p>
                                  {log.note && <p className="text-gray-700 mt-1">{log.note}</p>}
                                  <p className="text-gray-500 text-xs mt-1">
                                    {formatDate(log.created_at, 'yyyy-MM-dd HH:mm')}
                                  </p>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-gray-500 text-sm">No activity log</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-gray-500 text-sm italic">No milestones in this section</p>
          )}
        </div>
      ))}
    </div>
  );
}
