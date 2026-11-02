import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { expect, it } from 'vitest'
import { assistantOperationsApi } from './assistantOperations'

it('preserves failure code dictionary keys and unwraps saved settings', async () => {
  server.use(http.get('*/api/v1/assistant/tasks/operations', () => HttpResponse.json({ limits: { per_user_pending: 3, per_user_running: 1, global_queued: 100, retention_days: 0 }, totals: {}, window_hours: 24, failure_counts: { model_timeout: 2, output_limit: 1 }, recent: [], can_manage: true })))
  const overview = await assistantOperationsApi.get()
  expect(overview.failureCounts).toEqual({ model_timeout: 2, output_limit: 1 })
  server.use(http.put('*/api/v1/assistant/tasks/operations/settings', async ({ request }) => {
    expect(await request.json()).toEqual({ per_user_pending: 4, per_user_running: 1, global_queued: 100, retention_days: 30 })
    return HttpResponse.json({ limits: { per_user_pending: 4, per_user_running: 1, global_queued: 100, retention_days: 30 } })
  }))
  expect(await assistantOperationsApi.save({ perUserPending: 4, perUserRunning: 1, globalQueued: 100, retentionDays: 30 })).toEqual({ perUserPending: 4, perUserRunning: 1, globalQueued: 100, retentionDays: 30 })
})
