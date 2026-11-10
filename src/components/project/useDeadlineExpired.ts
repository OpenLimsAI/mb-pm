import { useEffect, useState } from 'react'

export function useDeadlineExpired(
  expiresAt: string | null | undefined,
): boolean {
  const [expiredFor, setExpiredFor] = useState<string | null>(null)
  useEffect(() => {
    if (!expiresAt) return
    const delay = Date.parse(expiresAt) - Date.now()
    const timer = window.setTimeout(
      () => setExpiredFor(expiresAt),
      Number.isFinite(delay) ? Math.max(0, delay) : 0,
    )
    return () => window.clearTimeout(timer)
  }, [expiresAt])
  return !!expiresAt && expiredFor === expiresAt
}
