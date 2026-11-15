import { describe, expect, it } from 'vitest'
import { sourceError } from './api'

const failure = (status?: number, data?: unknown, code?: string) => ({
  isAxiosError: true,
  response: status === undefined ? undefined : { status, data },
  code,
})

describe('knowledge source failure explanations', () => {
  it.each([
    [413, '<html><body>Request Entity Too Large</body></html>', '请求内容过大'],
    [500, 'Internal Server Error', '知识源服务处理失败'],
    [502, '<html>Bad Gateway</html>', '知识源或知识库服务暂不可用'],
    [503, undefined, '知识源或知识库服务暂不可用'],
    [504, '<html>Gateway Timeout</html>', '响应超时'],
  ])('explains HTTP %s without exposing a proxy response', (status, data, expected) => {
    const message = sourceError(failure(status as number, data))
    expect(message).toContain(expected)
    expect(message).not.toContain('<html>')
    expect(message).not.toContain('Internal Server Error')
    expect(message).not.toContain('Bad Gateway')
  })

  it.each(['ETIMEDOUT', 'ECONNABORTED'])('recognizes %s and leaves the saved outcome unconfirmed', code => {
    expect(sourceError(failure(undefined, undefined, code))).toContain('响应超时')
    expect(sourceError(failure(undefined, undefined, code))).toContain('核对保存结果')
  })

  it('keeps a network interruption distinct from a known server failure', () => {
    expect(sourceError(failure(undefined, undefined, 'ERR_NETWORK'))).toContain('暂时无法连接知识源')
    expect(sourceError(failure(500))).not.toContain('暂时无法连接知识源')
  })

  it('preserves safe backend string details and structured message details', () => {
    expect(sourceError(failure(413, { detail: '单份 PDF 请控制在 25 MB 以内' }))).toBe('单份 PDF 请控制在 25 MB 以内')
    expect(sourceError(failure(400, { detail: { message: 'PDF 正文暂无法读取，原件仍保留。', code: 'invalid_text' } }))).toBe('PDF 正文暂无法读取，原件仍保留。')
  })

  it.each([
    '<html><body>upstream private response</body></html>',
    'Traceback (most recent call last):\n  File "/private/database.py", line 42\nprivate credentials',
    'Error: private response\n    at upload (/private/server.js:4:2)',
  ])('does not render HTML or stack traces contained in a detail message', detail => {
    expect(sourceError(failure(500, { detail: { message: detail } }))).toBe('知识源服务处理失败，请稍后重试。')
  })
})
