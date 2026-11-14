import { Navigate } from 'react-router-dom'
import { projectAssistantUrl } from '../lib/projectAssistantNavigation'

export default function AISettings() {
  return <Navigate to={projectAssistantUrl('settings')} replace />
}
