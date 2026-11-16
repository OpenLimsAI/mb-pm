import { describe, expect, it } from 'vitest'
import { summarizeUploadFailure, uploadByteCount, type UploadAttempt } from './upload-diagnostics'

const attempt:UploadAttempt={trace:'a'.repeat(32),stage:'uploading',loadedBytes:null,totalBytes:null}

describe('allowlisted upload diagnostics',()=>{
  it('keeps a correlation trace when the browser exposes no HTTP response or byte events',()=>{
    expect(summarizeUploadFailure({isAxiosError:true,code:'ERR_NETWORK'},attempt,15210)).toEqual({...attempt,elapsedSeconds:15,code:'ERR_NETWORK',status:null})
  })
  it('does not copy document content, paths, request configuration, headers or unrecognized codes',()=>{
    const error={isAxiosError:true,code:'/private/document.pdf',message:'private-document',config:{url:'private-url',headers:{Cookie:'private-cookie'}},response:{status:502,data:'private-body',headers:{'x-request-id':'private-id'}}}
    const result=summarizeUploadFailure(error,{...attempt,stage:'processing',loadedBytes:1024,totalBytes:1024},30000)
    expect(result).toEqual({...attempt,stage:'processing',loadedBytes:1024,totalBytes:1024,elapsedSeconds:30,code:'UPLOAD_FAILED',status:502});expect(JSON.stringify(result)).not.toContain('private')
  })
  it('does not turn status zero into a received HTTP response or render an unsafe trace',()=>{
    expect(summarizeUploadFailure({isAxiosError:true,code:'ETIMEDOUT',response:{status:0}},{...attempt,trace:'../private'},1000)).toEqual({...attempt,trace:'',elapsedSeconds:1,code:'ETIMEDOUT',status:null})
  })
  it.each([undefined,null,NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])('does not invent an invalid byte count %s',value=>{
    expect(uploadByteCount(value)).toBeNull()
  })
  it('preserves reported zero bytes without treating them as proof of no transmission',()=>{
    expect(uploadByteCount(0)).toBe(0);expect(uploadByteCount(1024)).toBe(1024)
  })
})
