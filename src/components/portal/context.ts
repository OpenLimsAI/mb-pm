import { useOutletContext } from 'react-router-dom'
import type { PortalApplication, PortalUser } from '../../api/portal'

export interface PortalContext {
  user: PortalUser
  applications: PortalApplication[]
  preview: boolean
  refresh: () => Promise<void>
  logout: () => void
}

export const usePortalContext = () => useOutletContext<PortalContext>()
