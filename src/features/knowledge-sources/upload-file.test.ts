import { describe, expect, it, vi } from 'vitest'
import { snapshotLocalPdf } from './upload-file'

function bytes(blob:Blob):Promise<Uint8Array>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(new Uint8Array(reader.result as ArrayBuffer));reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(blob)})}

describe('local PDF snapshots',()=>{
  it('creates an independent file with identical bytes, name, MIME and lastModified',async()=>{
    const source=new Uint8Array([37,80,68,70,45,49,0,255,10,13]),file=new File([source],'论文.pdf',{type:'application/pdf',lastModified:123456})
    const snapshot=await snapshotLocalPdf(file,new AbortController().signal)
    expect(snapshot).not.toBe(file);expect(snapshot).toMatchObject({name:file.name,size:file.size,type:file.type,lastModified:file.lastModified});expect(await bytes(snapshot)).toEqual(source)
  })

  it.each(['NotReadableError','NotFoundError'])('returns a safe %s failure without the browser error message',async name=>{
    const read=vi.spyOn(FileReader.prototype,'readAsArrayBuffer').mockImplementation(function(this:FileReader){Object.defineProperty(this,'error',{value:new DOMException('/private/document.pdf',name)});this.dispatchEvent(new ProgressEvent('error'))})
    try{await expect(snapshotLocalPdf(new File(['PDF'],'x.pdf'),new AbortController().signal)).rejects.toMatchObject({name:'LocalFileReadFailure',code:name,message:'无法读取此 PDF。请先下载到本机，再重新选择。'})}finally{read.mockRestore()}
  })

  it('rejects a snapshot whose byte length changed before send',async()=>{
    const read=vi.spyOn(FileReader.prototype,'readAsArrayBuffer').mockImplementation(function(this:FileReader){Object.defineProperty(this,'result',{value:new ArrayBuffer(1)});this.dispatchEvent(new ProgressEvent('load'))})
    try{await expect(snapshotLocalPdf(new File(['PDF'],'x.pdf'),new AbortController().signal)).rejects.toMatchObject({code:'FILE_SIZE_CHANGED'})}finally{read.mockRestore()}
  })

  it('aborts an active local file read and releases the reader',async()=>{
    const controller=new AbortController(),abort=vi.spyOn(FileReader.prototype,'abort'),promise=snapshotLocalPdf(new File(['PDF'],'x.pdf'),controller.signal)
    controller.abort();await expect(promise).rejects.toMatchObject({name:'AbortError'});expect(abort).toHaveBeenCalledOnce();abort.mockRestore()
  })
})

