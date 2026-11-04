import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'

GlobalWorkerOptions.workerSrc = workerUrl
const resources = import.meta.glob<string>(['/node_modules/pdfjs-dist/cmaps/*.bcmap', '/node_modules/pdfjs-dist/standard_fonts/*.pfb', '/node_modules/pdfjs-dist/standard_fonts/*.ttf'], {query:'?url',import:'default',eager:true})
class LocalPdfResources {
  async fetch({kind,filename}:{kind:string;filename:string}) {
    const directory=kind==='cMapUrl'?'cmaps':kind==='standardFontDataUrl'?'standard_fonts':''
    const url=resources[`/node_modules/pdfjs-dist/${directory}/${filename}`]
    if(!url)throw new Error('PDF字体资源暂不可用')
    const response=await fetch(url)
    if(!response.ok)throw new Error('PDF字体资源读取失败')
    return new Uint8Array(await response.arrayBuffer())
  }
}
export default function PdfReader({url,title,initialPage=1,onPosition}:{url:string;title:string;initialPage?:number;onPosition?:(page:number)=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null),container=useRef<HTMLDivElement>(null)
  const initial=useRef(initialPage),positionCallback=useRef(onPosition)
  useEffect(()=>{positionCallback.current=onPosition},[onPosition])
  const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(initialPage),[width,setWidth]=useState(600),[zoom,setZoom]=useState(1),[error,setError]=useState(''),[loading,setLoading]=useState(true),[rendered,setRendered]=useState(false)
  useEffect(()=>{const element=container.current;if(!element)return;const observer=new ResizeObserver(entries=>{const value=entries[0]?.contentRect.width;if(value)setWidth(Math.max(200,value-24))});observer.observe(element);return()=>observer.disconnect()},[])
  useEffect(()=>{
    const controller=new AbortController();let document:PDFDocumentProxy|undefined;let destroy:(()=>Promise<void>)|undefined
    void(async()=>{try{
      const response=await fetch(url,{credentials:'include',signal:controller.signal})
      if(!response.ok)throw new Error(response.status===403?'当前账号无权读取此原件':'原件暂不可读，请刷新后重试')
      if(Number(response.headers.get('content-length'))>25*1024*1024)throw new Error('原件超过25MB，请打开原件阅读')
      const data=await response.arrayBuffer()
      if(data.byteLength>25*1024*1024||!new TextDecoder().decode(data.slice(0,16)).trimStart().startsWith('%PDF-'))throw new Error('返回内容未通过PDF校验')
      const task=getDocument({data:new Uint8Array(data),BinaryDataFactory:LocalPdfResources,useWorkerFetch:false})
      destroy=()=>task.destroy();document=await task.promise
      if(controller.signal.aborted){await task.destroy();return}
      setPdf(document);setPage(Math.max(1,Math.min(document.numPages,initial.current)));setError('')
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'PDF预览暂不可用')}finally{if(!controller.signal.aborted)setLoading(false)}})()
    return()=>{controller.abort();void destroy?.();document=undefined}
  },[url])
  useEffect(()=>{
    if(!pdf||!canvas.current)return
    let stopped=false;let cancel:(()=>void)|undefined
    void(async()=>{try{
      const documentPage=await pdf.getPage(page)
      if(stopped||!canvas.current)return
      const ratio=Math.min(window.devicePixelRatio||1,2),normal=documentPage.getViewport({scale:1}),scale=width/normal.width*zoom,viewport=documentPage.getViewport({scale:scale*ratio})
      const element=canvas.current;element.width=Math.floor(viewport.width);element.height=Math.floor(viewport.height);element.style.width=`${viewport.width/ratio}px`;element.style.height=`${viewport.height/ratio}px`
      const context=element.getContext('2d');if(!context)throw new Error('浏览器无法绘制PDF')
      const task=documentPage.render({canvas:element,canvasContext:context,viewport});cancel=()=>task.cancel();await task.promise
      if(!stopped){setRendered(true);positionCallback.current?.(page)}
    }catch(e){if(!stopped&&!(e instanceof Error&&e.name==='RenderingCancelledException'))setError('此页预览失败，可切换正文或打开原件阅读')}})()
    return()=>{stopped=true;cancel?.()}
  },[pdf,page,width,zoom])
  return <div className="ksv-pdf-reader" ref={container}><div className="ksv-reader-paging"><button className="kso-btn" aria-label="PDF上一页" disabled={!pdf||page<=1} onClick={()=>{setRendered(false);setPage(n=>n-1)}}><ChevronLeft/></button><label>第 <input aria-label="PDF页码" type="number" min={1} max={pdf?.numPages || 1} value={page} onChange={e=>{const next=Number(e.target.value);if(pdf&&next>=1&&next<=pdf.numPages){setRendered(false);setPage(next)}}}/> / {pdf?.numPages || '…'} 页</label><button className="kso-btn" aria-label="PDF下一页" disabled={!pdf||page>=pdf.numPages} onClick={()=>{setRendered(false);setPage(n=>n+1)}}><ChevronRight/></button><button className="kso-icon-btn" aria-label="缩小PDF" disabled={zoom<=.6} onClick={()=>setZoom(n=>Math.max(.6,n-.2))}><ZoomOut/></button><button className="kso-icon-btn" aria-label="放大PDF" disabled={zoom>=2} onClick={()=>setZoom(n=>Math.min(2,n+.2))}><ZoomIn/></button></div>{loading&&<p role="status" className="ksv-reader-message">正在读取 PDF 原件…</p>}{error&&<p role="alert" className="kso-error ksv-reader-message">{error} <a href={url} target="_blank" rel="noreferrer">打开原件</a></p>}<div className="ksv-pdf-canvas"><canvas ref={canvas} aria-label={`${title} 第${page}页`} data-rendered={rendered?'true':'false'}/></div></div>
}
