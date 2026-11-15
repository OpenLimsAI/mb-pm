import { beforeEach, describe, expect, it, vi } from 'vitest'

const transport=vi.hoisted(()=>({post:vi.fn(),responseUse:vi.fn()}))
vi.mock('axios',()=>({default:{create:()=>({post:transport.post,interceptors:{response:{use:transport.responseUse}}})}}))
vi.mock('../../api/client',()=>({API_BASE:'/api/v1',camelize:(value:unknown)=>value,snakeize:(value:unknown)=>value}))

import { knowledgeV3Upload } from './v3-api'

beforeEach(()=>{transport.post.mockReset();transport.post.mockResolvedValue({data:{registered:false}})})

describe('knowledge source upload transport',()=>{
  it('passes the original FormData, cancellation and progress callback to Axios',async()=>{
    const body=new FormData(),controller=new AbortController(),progress=vi.fn()
    body.append('file',new File(['%PDF-1.7'],'progress.pdf'));body.append('parse','false')
    expect(await knowledgeV3Upload('/upload',body,controller.signal,progress)).toEqual({registered:false})
    expect(transport.post).toHaveBeenCalledExactlyOnceWith('/upload',body,{signal:controller.signal,onUploadProgress:progress})
    expect(body.get('parse')).toBe('false')
  })

  it('keeps existing upload callers valid when no progress callback is supplied',async()=>{
    const body=new FormData()
    await knowledgeV3Upload('/upload',body)
    expect(transport.post).toHaveBeenCalledExactlyOnceWith('/upload',body,{signal:undefined,onUploadProgress:undefined})
  })
})
