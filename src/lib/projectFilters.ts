import type { Health, ProductType, Stage, ProjectStatus } from '../types'

export interface FilterState {
  keyword: string
  productType: ProductType | 'all'
  stage: Stage | 'all'
  health: Health | 'all'
  ownerId: string | 'all'
  status: ProjectStatus | 'all'
}

export const initialFilters: FilterState = {
  keyword: '',
  productType: 'all',
  stage: 'all',
  health: 'all',
  ownerId: 'all',
  status: '活跃',
}
