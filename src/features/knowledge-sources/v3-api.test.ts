import { describe, expect, it } from 'vitest'
import { decodeKnowledgeV3 } from './v3-api'
import type { WorkspaceState } from './workspace-v3-types'
describe('knowledge workspace identity maps',()=>{
  it('preserves document paths and aliases while normalizing reading entry fields',()=>{
    const path='sources/Q5C_updated/ICH_Q5C.md'
    const value=decodeKnowledgeV3<WorkspaceState>({reading:{[path]:{state:'done',version_id:'v1',updated_at:'2026-11-04',position:{offset:12}},'archive:abc_def':{state:'reading',version_id:'v2'}},location:{paper_id:path}})
    expect(value.reading[path]).toEqual({state:'done',versionId:'v1',updatedAt:'2026-11-04',position:{offset:12}})
    expect(value.reading['archive:abc_def'].versionId).toBe('v2')
    expect(value.reading['sources/Q5CUpdated/ICHQ5C.md']).toBeUndefined()
    expect(value.location.paperId).toBe(path)
  })
})
