// The fixture cannot bootstrap a business session or mutate business data.
export async function bootstrap() {}
export async function refreshAllData() {}
export function watchIdentity() { return () => {} }
const forbidden = async () => { throw new Error('Business writes are disabled in the layout fixture') }
export const refreshAfterWrite = forbidden
export const updateTaskProgress = forbidden
export const updateTasksBatch = forbidden
export const updateProjectFinanceEntry = forbidden
export const createProjectBaseline = forbidden
export const deleteProjectBaseline = forbidden
export const updateProjectMembers = forbidden
export const createMilestoneWithDeps = forbidden
export const updateMilestoneWithDeps = forbidden
export const deleteMilestoneWithDeps = forbidden
export const deleteProjectEntry = forbidden
export const createProjectBundle = forbidden
export const createTemplateEntry = forbidden
export const deleteTemplateEntry = forbidden
export const saveTemplateStructure = forbidden
