import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { completeLogin } from '../lib/oidc'

export default function Callback() {
  const navigate = useNavigate()
  useEffect(() => {
    completeLogin()
      .then(() => navigate('/', { replace: true }))
      .catch(() => navigate('/', { replace: true }))
  }, [navigate])
  return (
    <div className="h-full flex items-center justify-center gap-2 text-sm text-ink-500">
      <Loader2 className="w-4 h-4 animate-spin" /> 登录中 …
    </div>
  )
}
