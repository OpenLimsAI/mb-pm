import { addDays, format, parseISO } from 'date-fns'
import type { WorkingCalendar, WeeklyCapacity } from '../api/planning'
import { subProjects } from '../mock'
import type { Task } from '../types'

export const defaultCalendar: WorkingCalendar = { weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [], workingDates: [], revision: 0 }
const calendars = new Map<string, WorkingCalendar>()
let capacities: WeeklyCapacity[] = []
export const setWorkingCalendars = (values: WorkingCalendar[]) => {
  calendars.clear()
  values.forEach(value => { if (value.projectId) calendars.set(value.projectId, value) })
}
export const setWeeklyCapacities = (values: WeeklyCapacity[]) => { capacities = values }
export const getWeeklyCapacity = (userId: string, weekStart: string) => capacities.find(c => c.userId === userId && c.weekStart === weekStart)
export const getWorkingCalendar = (projectId: string) => calendars.get(projectId) ?? defaultCalendar
export const calendarForTask = (task: Pick<Task, 'subProjectId'>) => getWorkingCalendar(subProjects.find(s => s.id === task.subProjectId)?.projectId ?? '')
export const isWorkingDate = (day: Date, calendar: WorkingCalendar): boolean => {
  const iso = format(day, 'yyyy-MM-dd')
  return calendar.workingDates.includes(iso) || (!calendar.holidays.includes(iso) && calendar.weekdays.includes(day.getDay() || 7))
}
/** Inclusive dates, used to distribute remaining effort only across future working days. */
export function workingDates(start: Date, end: Date, calendar: WorkingCalendar): Date[] {
  const result: Date[] = []
  for (let day = start, count = 0; day <= end && count <= 36600; day = addDays(day, 1), count++) {
    if (isWorkingDate(day, calendar)) result.push(day)
  }
  return result
}
export function moveWorkingDays(start: Date, amount: number, calendar: WorkingCalendar): Date {
  let day = start
  for (let left = Math.abs(amount), count = 0; left > 0 && count < 36600; count++) {
    day = addDays(day, amount < 0 ? -1 : 1)
    if (isWorkingDate(day, calendar)) left--
  }
  return day
}
/** Signed working-day offsets; default natural calendar retains historical CPM values. */
export function workingDayDifference(end: Date, start: Date, calendar: WorkingCalendar): number {
  if (end < start) return -workingDayDifference(start, end, calendar)
  return workingDates(addDays(start, 1), end, calendar).length
}
export const parseCalendarDates = (value: string) => [...new Set(value.split(/[\s,，;；]+/).filter(Boolean))].filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseISO(value).getTime()))
