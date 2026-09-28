// 账号规则（与后端 backend/app/schemas/account.py 保持一致）：注册、改用户名、改密码共用。
import axios from 'axios'

export const USERNAME_HINT = '3–32 位小写字母或数字，可用 . _ - 分隔'
export const PASSWORD_HINT = '8–64 位，需同时包含字母和数字，不含空格'

const USERNAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'casdoor', 'built-in', 'app'])

export const normalizeUsername = (value: string) => value.trim().toLowerCase()

export function usernameProblem(value: string): string | null {
  const name = normalizeUsername(value)
  if (name.length < 3 || name.length > 32) return '用户名长度需为 3–32 个字符'
  if (!USERNAME_RE.test(name)) return '用户名只能包含小写字母和数字，可用 . _ - 分隔（不能连用或出现在首尾）'
  if (RESERVED.has(name)) return '该用户名为系统保留，请换一个'
  return null
}

export function passwordProblem(value: string): string | null {
  if (value.length < 8 || value.length > 64) return '密码长度需为 8–64 位'
  if (!/^[\x21-\x7e]+$/.test(value)) return '密码只能由英文字母、数字和符号组成，不能包含空格'
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return '密码需同时包含字母和数字'
  return null
}

export function emailProblem(value: string): string | null {
  const email = value.trim()
  if (!email) return '请填写邮箱'
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确'
  return null
}

/** 后端错误 → 一句中文提示（422 字段校验取第一条）。 */
export function accountError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = (error.response?.data as { detail?: unknown } | undefined)?.detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && detail.length) {
      const msg = (detail[0] as { msg?: unknown })?.msg
      return typeof msg === 'string' ? msg.replace(/^Value error, /, '') : '输入无效，请检查后重试'
    }
    if (!error.response) return '无法连接服务器，请稍后重试。'
  }
  return '操作失败，请稍后重试。'
}
