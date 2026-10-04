// 路由守卫：按权限矩阵（URS 5.2）拦截直接 URL 访问 —— 侧边栏隐藏了入口，手输地址也会被拦下。
// 前端守卫只管体验；真正的授权以后端（IAM 角色）为准。
//
// 用法：包裹一组路由
//   <Route element={<RequirePerm perms={['workload.view']} />}>
//     <Route path="/workload" element={<Workload />} />
//   </Route>

import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ShieldAlert, ArrowLeft } from 'lucide-react'
import { useAuth } from '../../store/auth'
import { can, roleLabels, type PermKey } from '../../lib/permissions'
import { Card, CardBody, Button } from '../ui'

interface Props {
  perms: PermKey[]
  /** 'any'：任意一个权限即可（默认）；'all'：必须全部满足 */
  mode?: 'any' | 'all'
  children?: ReactNode
}

export function RequirePerm({ perms, mode = 'any', children }: Props) {
  const user = useAuth((s) => s.currentUser)
  const location = useLocation()
  const navigate = useNavigate()

  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />
  }

  const ok = mode === 'all' ? perms.every((p) => can(user.role, p)) : perms.some((p) => can(user.role, p))
  if (ok) return <>{children ?? <Outlet />}</>

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Card>
        <CardBody className="p-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-red-50 text-red-600 mb-4">
            <ShieldAlert className="w-7 h-7" />
          </div>
          <h2 className="text-xl font-semibold text-ink-900 mb-2">无权访问</h2>
          <p className="text-sm text-ink-500 mb-5">
            您当前的角色 <span className="font-medium text-ink-900">{roleLabels[user.role]}</span> 没有访问该页面的权限；
            如需访问，请联系管理员在 IAM 中调整角色。
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={() => window.history.back()}>
              返回上一页
            </Button>
            <Button variant="primary" onClick={() => navigate('/dashboard')}>回到首页</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
