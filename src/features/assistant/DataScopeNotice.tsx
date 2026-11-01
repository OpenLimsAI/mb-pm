import { dataSourceLabel } from './dataSources'
import type { ApplicationDataSource } from './dataSources'

export default function DataScopeNotice({ sources }: { sources: readonly ApplicationDataSource[] }) {
  return <section className="aa-data-scope-notice" role="status" aria-label="应用数据使用说明">
    <strong>{sources.length ? `已允许查询：${dataSourceLabel(sources)}` : '未启用应用数据 · 仍可正常提问'}</strong>
    <p>{sources.length
      ? '助手仅可按问题需要查询已勾选应用中你有权限的数据；不会每次都读取全部应用，也可以直接进行通用问答。'
      : '助手可用模型的通用知识回答，也可参考当前对话和你主动提供的资料；不会主动查询应用数据。'}</p>
  </section>
}
