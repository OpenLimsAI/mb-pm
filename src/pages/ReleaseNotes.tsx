// 与可下载的独立 HTML 使用同一份内容，避免应用内说明与离线手册不一致。
// 说明页只包含产品文案，不读取业务数据；路由沿用应用的登录守卫。
export default function ReleaseNotes() {
  return (
    <iframe
      title="CMC-PMS 版本更新"
      src={`/release-notes.html?v=${__APP_BUILD__}`}
      className="block w-full h-full min-h-[400px] border-0"
    />
  )
}
