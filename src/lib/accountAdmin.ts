// 账号管理的显示文案与初始密码生成。身份对应的 IAM 角色见 backend/app/services/accounts.py。
import type { Identity } from '../api/accounts'

export { specialtyGroups } from '../mock/dictionaries'

/** 项目管理、知识库默认对所有人开放（知识库为编辑）；身份只决定项目管理里的重要编辑与账号管理。 */
export const IDENTITY_OPTIONS: { value: Identity; label: string; hint: string }[] = [
  { value: 'staff', label: '员工', hint: '项目管理里可做日常录入（更新自己负责的任务）；看不到账号管理。' },
  { value: 'lead', label: '项目负责人', hint: '可编辑项目（项目信息、预算与 WBS 结构）、删除项目等重要编辑（全部项目）；账号管理里只能查看。' },
  { value: 'admin', label: '系统管理员', hint: '全部权限，可以修改所有人的所有信息。' },
]

export const identityLabel = (identity: Identity) => IDENTITY_OPTIONS.find((o) => o.value === identity)?.label ?? '员工'

/** 身份对应的 IAM 角色；IAM 里没有建立时该身份不可选（员工不需要角色）。 */
export const IDENTITY_ROLE: Record<Identity, string | null> = { staff: null, lead: 'cmc_lead', admin: 'admin' }

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
