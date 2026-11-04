import { api } from './client'

export interface WorkingCalendar {
  projectId?: string
  weekdays: number[]
  holidays: string[]
  workingDates: string[]
  revision: number
}
export interface WeeklyCapacity {
  userId: string; weekStart: string; availableHours: number; leaveHours: number; revision: number
}
export interface ScheduleRequest {
  taskId: string; newStart: string; newEnd: string; lockedIds: string[]; fingerprint?: string; reason?: string
}
export interface SchedulePreview {
  fingerprint: string
  changes: { taskId: string; name: string; code: string; oldStart: string; oldEnd: string; newStart: string; newEnd: string; isMilestone: boolean }[]
  conflicts: { taskId: string; name: string; reason: string }[]
  previousFinish: string; newFinish: string
}
export const planningApi = {
  calendars: async () => (await api.get<WorkingCalendar[]>('/planning/calendars')).data,
  saveCalendar: async (projectId: string, value: WorkingCalendar) => (await api.put<WorkingCalendar>(`/planning/projects/${encodeURIComponent(projectId)}/calendar`, value)).data,
  capacities: async () => (await api.get<WeeklyCapacity[]>('/planning/capacities')).data,
  saveCapacity: async (value: WeeklyCapacity) => (await api.put<WeeklyCapacity>('/planning/capacities', value)).data,
  preview: async (projectId: string, value: ScheduleRequest) => (await api.post<SchedulePreview>(`/planning/projects/${encodeURIComponent(projectId)}/schedule-preview`, value)).data,
  apply: async (projectId: string, value: ScheduleRequest) => (await api.post<SchedulePreview>(`/planning/projects/${encodeURIComponent(projectId)}/schedule-apply`, value)).data,
}
