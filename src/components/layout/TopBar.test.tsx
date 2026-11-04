import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'

vi.mock('../../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../../api/client')>(), USE_API: true }))
vi.mock('../../lib/site', () => ({ feedbackUrl: 'https://www.openlims.ai/feedback', settingsUrl: 'https://www.openlims.ai/settings', workspaceUrl: 'https://www.openlims.ai' }))

it('opens the portal feedback composer in a separate tab from every project page', () => {
  render(<MemoryRouter><TopBar /></MemoryRouter>)
  const entry = screen.getByRole('link', { name: '问题反馈（新标签页打开）' })
  expect(entry).toHaveAttribute('href', 'https://www.openlims.ai/feedback?compose=1')
  expect(entry).toHaveAttribute('target', '_blank')
  expect(entry).toHaveAttribute('rel', 'noopener noreferrer')
})
