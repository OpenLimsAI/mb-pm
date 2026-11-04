import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'

vi.mock('../../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../../api/client')>(), USE_API: true }))
vi.mock('../../lib/site', () => ({ feedbackUrl: 'https://www.openlims.ai/feedback', settingsUrl: 'https://www.openlims.ai/settings', workspaceUrl: 'https://www.openlims.ai' }))

it('opens the portal feedback composer in a separate tab from every project page', () => {
  render(<MemoryRouter initialEntries={['/projects/project-123?access_token=private#task-1']}><TopBar /></MemoryRouter>)
  const entry = screen.getByRole('link', { name: '回音壁（新标签页打开）' })
  const destination = new URL(entry.getAttribute('href')!)
  expect(destination.origin + destination.pathname).toBe('https://www.openlims.ai/feedback')
  expect(Object.fromEntries(destination.searchParams)).toEqual({ compose: '1', application: 'pm', source_path: '/projects/project-123' })
  expect(destination.href).not.toContain('private')
  expect(entry).toHaveAttribute('target', '_blank')
  expect(entry).toHaveAttribute('rel', 'noopener noreferrer')
})
