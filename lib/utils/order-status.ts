import { isAfter, isBefore, differenceInHours, startOfDay } from 'date-fns';
import type { Milestone } from '@/lib/types';

export type OrderStatusColor = 'GREEN' | 'YELLOW' | 'RED';

export interface OrderStatus {
  color: OrderStatusColor;
  reason: string;
}

/**
 * Compute order status based on milestones
 * GREEN: no blocked and no overdue in_progress
 * YELLOW: in_progress milestone past planned_at but not past due_at OR <=48h remaining
 * RED: any milestone blocked OR any in_progress milestone overdue
 */
export function computeOrderStatus(milestones: Milestone[]): OrderStatus {
  if (!milestones || milestones.length === 0) {
    return { color: 'GREEN', reason: 'No milestones' };
  }

  const now = new Date();

  // Check for blocked milestones (RED) - 只使用中文状态
  const blockedMilestones = milestones.filter(m => m.status === '卡住');
  if (blockedMilestones.length > 0) {
    return {
      color: 'RED',
      reason: `${blockedMilestones.length} milestone(s) blocked: ${blockedMilestones.map(m => m.name).join(', ')}`,
    };
  }

  // Check for overdue in_progress milestones (RED) - 只使用中文状态
  const inProgressMilestones = milestones.filter(m => 
    m.status === '进行中'
  );
  const overdueInProgress = inProgressMilestones.filter(m => {
    if (!m.due_at) return false;
    return isAfter(now, new Date(m.due_at));
  });

  if (overdueInProgress.length > 0) {
    return {
      color: 'RED',
      reason: `${overdueInProgress.length} in-progress milestone(s) overdue: ${overdueInProgress.map(m => m.name).join(', ')}`,
    };
  }

  // Check for YELLOW conditions
  const yellowConditions = inProgressMilestones.filter(m => {
    if (!m.due_at) return false;
    
    // Past planned_at but not past due_at
    if (m.planned_at) {
      const plannedAt = new Date(m.planned_at);
      const dueAt = new Date(m.due_at);
      if (isAfter(now, plannedAt) && isBefore(now, dueAt)) {
        return true;
      }
    }
    
    // <=48h remaining
    const hoursRemaining = differenceInHours(new Date(m.due_at), now);
    if (hoursRemaining <= 48 && hoursRemaining > 0) {
      return true;
    }
    
    return false;
  });

  if (yellowConditions.length > 0) {
    return {
      color: 'YELLOW',
      reason: `${yellowConditions.length} milestone(s) approaching deadline: ${yellowConditions.map(m => m.name).join(', ')}`,
    };
  }

  // Default to GREEN
  return { color: 'GREEN', reason: 'All milestones on track' };
}
