export interface ReportExportOptions {
  template: 'standard' | 'compact'
  organization: string
  cover: boolean
  figureIndex: boolean
  bibliography: 'detailed' | 'titles'
}
export const defaultExportOptions: ReportExportOptions = { template: 'standard', organization: '', cover: true, figureIndex: true, bibliography: 'detailed' }
