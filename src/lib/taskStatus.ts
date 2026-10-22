import type { TaskStatus } from '../types'

export const PRIMARY_TASK_STATUSES = ['未开始', '进行中', '已完成', '已验证'] as const

/** 阻塞、延迟沿用现有存储状态，在主流程中属于进行中。 */
export function primaryTaskStatus(status: TaskStatus): typeof PRIMARY_TASK_STATUSES[number] {
  return status === '阻塞' || status === '延迟' ? '进行中' : status
}
