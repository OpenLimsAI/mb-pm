// 账号管理的显示文案与初始密码生成。身份对应的 IAM 角色见 backend/app/services/accounts.py。
import type { Account, PMIdentity, KBRole } from '../api/accounts'

export { specialtyGroups } from '../mock/dictionaries'

export const pmIdentityLabel = (identity: PMIdentity) => identity === 'lead' ? '项目负责人' : '员工'
export const kbRoleLabel = (role: KBRole) => ({ viewer: '仅阅读（历史）', editor: '可编辑', unassigned: '待分配' })[role]
export const legacyPMNote = (account: Account) => account.pmRoles
  .filter((r) => ['project_lead', 'production', 'qa_qc'].includes(r))
  .map((r) => ({ project_lead: '项目负责人（本人项目）', production: '生产支持', qa_qc: 'QA/QC' })[r]).join('、')

// 去掉易混淆的 0/O、1/l/I；三段四位，含大小写与数字（满足后端与 IAM 的密码规则）
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGIT = '23456789'
const ALL = LOWER + UPPER + DIGIT

export function generatePassword(): string {
  for (;;) {
    const text = Array.from(crypto.getRandomValues(new Uint32Array(12)), (n) => ALL[n % ALL.length]).join('')
    if (/[a-z]/.test(text) && /[A-Z]/.test(text) && /[0-9]/.test(text)) {
      return [text.slice(0, 4), text.slice(4, 8), text.slice(8)].join('-')
    }
  }
}

/** 交给本人的开通 / 重置说明（只在本次显示，不保存）。 */
export function credentialText(kind: 'created' | 'reset', displayName: string, username: string, password: string, portalUrl: string) {
  const created = kind === 'created'
  return [
    created ? `${displayName}，你的迈博工作台账号已开通：` : `${displayName}，你的迈博工作台密码已重置：`,
    `登录地址：${portalUrl}`,
    `用户名：${username}`,
    `${created ? '初始密码' : '临时密码'}：${password}`,
    created ? '首次登录时系统会要求你修改密码。' : '登录后系统会要求你修改密码。',
  ].join('\n')
}
