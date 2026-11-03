import { useCallback, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

interface WidthOptions {
  storageKey: string
  defaultWidth: number
  minWidth?: number
  maxWidth?: number
  reserveWidth?: number
  containerRef?: RefObject<HTMLElement | null>
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
function readWidth(key: string, fallback: number) {
  try {
    const stored = localStorage.getItem(key)
    const value = stored?.trim() ? Number(stored) : NaN
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch { return fallback }
}

/** Keep the preferred width when the viewport temporarily becomes narrower. */
export function useColumnWidth({ storageKey, defaultWidth, minWidth = 160, maxWidth = 720, reserveWidth = 120, containerRef }: WidthOptions) {
  const [preferred, setPreferred] = useState(() => ({ key: storageKey, width: readWidth(storageKey, defaultWidth) }))
  const [available, setAvailable] = useState<number | null>(null)
  if (preferred.key !== storageKey) setPreferred({ key: storageKey, width: readWidth(storageKey, defaultWidth) })
  useLayoutEffect(() => {
    const element = containerRef?.current
    if (!element) return
    const measure = () => {
      const size = element.clientWidth
      if (size > 0) setAvailable(size)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [containerRef])
  // On very small screens share the space instead of hiding the entire timeline.
  const minimum = available === null ? minWidth : Math.min(minWidth, Math.max(1, available / 2))
  const maximum = Math.max(minimum, Math.min(maxWidth, available === null ? maxWidth : available - Math.min(reserveWidth, available / 2)))
  const setWidth = useCallback((next: number, persist = true) => {
    if (!Number.isFinite(next)) return
    const width = clamp(next, minimum, maximum)
    setPreferred({ key: storageKey, width })
    if (persist) try { localStorage.setItem(storageKey, String(width)) } catch { /* Local preference is optional. */ }
  }, [minimum, maximum, storageKey])
  const resetWidth = useCallback(() => {
    setPreferred({ key: storageKey, width: defaultWidth })
    try { localStorage.removeItem(storageKey) } catch { /* Resizing works without storage. */ }
  }, [storageKey, defaultWidth])
  return { width: clamp(preferred.width, minimum, maximum), minWidth: minimum, maxWidth: maximum, setWidth, resetWidth }
}

