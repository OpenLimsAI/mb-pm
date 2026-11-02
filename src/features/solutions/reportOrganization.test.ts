import { describe,it,expect } from 'vitest'
import { insertionRange,moveChapter,chapterDepth,filterReports } from './reportOrganization'
import type { Section,Solution } from './types'
const sections:Section[]=[{id:'a',title:'A',content:''},{id:'a1',parentId:'a',title:'A1',content:''},{id:'b',title:'B',content:''}]
describe('report organization and safe adoption',()=>{
 it('moves a whole chapter subtree without separating children',()=>{expect(moveChapter(sections,'a','b').map(s=>s.id)).toEqual(['a','a1','b']);expect(moveChapter(sections,'b','a').map(s=>s.id)).toEqual(['b','a','a1']);expect(moveChapter(sections,'a','a1')).toBe(sections);expect(chapterDepth(sections,'a1')).toBe(1)})
 it('rejects an adoption position after the original chapter was edited',()=>{const cursor={sectionId:'a',from:2,to:4,text:'cd',content:'abcdef'};expect(insertionRange('abcdef','a','replace',cursor)).toEqual({from:2,to:4});expect(insertionRange('abcdef','a','after',cursor)).toEqual({from:4,to:4});expect(()=>insertionRange('abcdef!','a','replace',cursor)).toThrow('变化');expect(()=>insertionRange('abcdef','b','cursor',cursor)).toThrow('变化')})
 it('requires real selected text for replacement but permits explicit append',()=>{expect(()=>insertionRange('abc','a','replace',{sectionId:'a',from:1,to:1,text:'',content:'abc'})).toThrow('选中');expect(insertionRange('abc','a','end',null)).toEqual({from:3,to:3})})
 it('combines project, tags and query while keeping pins first',()=>{const row={title:'研究',productName:'蛋白',projectName:'P',tags:['实验'],updatedAt:'2026-11-02'} as Solution;const rows=[{...row,id:'1'},{...row,id:'2',pinned:true,updatedAt:'2026-10-01'},{...row,id:'3',projectName:'Q'}];expect(filterReports(rows,'蛋白','P','实验','updated').map(s=>s.id)).toEqual(['2','1'])})
})

import {deleteChapter,restoreChapter} from './chapterActions'
it('promotes children when deleting a parent and restores their hierarchy on undo',()=>{
 const doc={id:'r',sections,references:[],formula:[]} as unknown as Solution
 const result=deleteChapter(doc,'a')!;expect(result.patch.sections.find(s=>s.id==='a1')?.parentId).toBeNull()
 const restored=restoreChapter({...doc,...result.patch},result.undo)!;expect(restored.sections.find(s=>s.id==='a1')?.parentId).toBe('a')
 const moved={...doc,...result.patch,sections:result.patch.sections.map(s=>s.id==='a1'?{...s,parentId:'b'}:s)}
 expect(restoreChapter(moved,result.undo)?.sections.find(s=>s.id==='a1')?.parentId).toBe('b')
})
it('refuses moving a subtree beyond six levels without mutating the outline',()=>{
 const chain:Section[]=Array.from({length:6},(_,i)=>({id:`c${i}`,title:`C${i}`,content:'',parentId:i?`c${i-1}`:null}))
 const tree:Section[]=[...chain,{id:'p',title:'P',content:''},{id:'child',title:'Child',content:'',parentId:'p'}]
 expect(moveChapter(tree,'p','c5')).toBe(tree)
})
