import PortalLayout from '../components/portal/PortalLayout'
import { usePortalContext } from '../components/portal/context'

// 门户登录后可阅读，不依赖项目管理权限或业务数据；与可下载 HTML 共用内容源。
export default function ReleaseNotes() {
  const { user, logout, preview } = usePortalContext()
  return (
    <PortalLayout user={user} logout={logout} preview={preview}>
      <div className="portal-page-heading">
        <div className="workspace-section-label">RELEASE NOTES</div>
        <h1>版本更新</h1>
        <p>了解应用的新功能、使用方式与历史更新记录。</p>
      </div>
      <iframe
        title="应用功能说明与版本更新"
        src={`/release-notes.html?v=${__APP_BUILD__}`}
        className="portal-release-frame"
      />
    </PortalLayout>
  )
}
