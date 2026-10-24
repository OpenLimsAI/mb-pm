import { useId, useState } from 'react'
import { Check, FileText, Library, Plus, RotateCcw, Sparkles } from 'lucide-react'
import { arrangementLabels, moduleLabels } from './layout'
import type { WorkspaceArrangement, WorkspaceLayout, WorkspaceModule } from './layout'
import './layout-picker.css'

const arrangements: WorkspaceArrangement[] = ['columns', 'left-main', 'right-main', 'top-pair']
const modules: WorkspaceModule[] = ['editor', 'knowledge', 'ai']
const positions: Record<WorkspaceArrangement, [string, string, string]> = {
  columns: ['左侧', '中间', '右侧'],
  'left-main': ['左侧', '右上', '右下'],
  'right-main': ['左上', '左下', '右侧'],
  'top-pair': ['左上', '右上', '下方'],
}
const moduleIcons = { editor: FileText, knowledge: Library, ai: Sparkles }

export default function LayoutPicker({ value, onApply, onClose }: {
  value: WorkspaceLayout
  onApply: (layout: WorkspaceLayout) => void
  onClose: () => void
}) {
  const [arrangement, setArrangement] = useState(value.arrangement)
  const [order, setOrder] = useState<WorkspaceModule[]>(() => [...value.order])
  const descriptionId = useId()
  const complete = order.length === modules.length

  function toggleModule(module: WorkspaceModule) {
    setOrder(selected => selected.includes(module) ? selected.filter(item => item !== module) : [...selected, module])
  }

  return <div className="ks-layout-picker">
    <p className="ks-layout-current">当前排列：<strong>{arrangementLabels[value.arrangement]}</strong><span>{value.order.map(module => moduleLabels[module]).join(' → ')}</span></p>
    <fieldset className="ks-layout-choice-group">
      <legend><span>01</span>选择排列方式</legend>
      <p className="ks-layout-help">先选结构，图中的 1、2、3 对应下方模块的选择顺序。</p>
      <div className="ks-layout-options">
        {arrangements.map(option => <button type="button" key={option} className={`ks-layout-option ${arrangement === option ? 'is-selected' : ''}`} aria-label={arrangementLabels[option]} aria-pressed={arrangement === option} aria-describedby={`${descriptionId}-${option}`} onClick={() => setArrangement(option)}>
          <span className={`ks-layout-diagram ks-layout-diagram-${option}`} aria-hidden="true">{[1, 2, 3].map(number => <span key={number} className={`ks-layout-diagram-slot ks-layout-slot-${number}`}>{number}</span>)}</span>
          <span className="ks-layout-option-label">{arrangementLabels[option]}<span className="ks-layout-choice-check" aria-hidden="true">{arrangement === option && <Check size={13} />}</span></span>
          <span className="ks-layout-position-guide" id={`${descriptionId}-${option}`}>{positions[option].map((position, index) => `${index + 1} ${position}`).join(' · ')}</span>
        </button>)}
      </div>
    </fieldset>

    <fieldset className="ks-layout-order-group">
      <legend><span>02</span>按顺序选择模块</legend>
      <div className="ks-layout-order-intro"><p className="ks-layout-help">依次点击分配 1 / 2 / 3；再次点击已选模块可取消。</p><button type="button" className="ks-layout-reset" onClick={() => setOrder([])} title="清空编号，按点击顺序重新选择"><RotateCcw size={13} />重置顺序</button></div>
      <div className="ks-layout-modules">
        {modules.map(module => {
          const index = order.indexOf(module), Icon = moduleIcons[module]
          return <button type="button" key={module} className={`ks-layout-module ${index >= 0 ? 'is-selected' : ''}`} aria-label={moduleLabels[module]} aria-pressed={index >= 0} aria-describedby={`${descriptionId}-${module}`} onClick={() => toggleModule(module)}>
            <Icon size={19} className="ks-layout-module-icon" aria-hidden="true" />
            <span className="ks-layout-module-text"><strong>{moduleLabels[module]}</strong><small id={`${descriptionId}-${module}`}>{index >= 0 ? `位置 ${index + 1} · ${positions[arrangement][index]}` : '待选择位置'}</small></span>
            <span className="ks-layout-module-number" aria-hidden="true">{index >= 0 ? index + 1 : <Plus size={14} />}</span>
          </button>
        })}
      </div>
      <div className="ks-layout-order-summary" role="status" aria-live="polite">
        <span>{complete ? '顺序已完整，可应用排列。' : `已选 ${order.length} / 3 个模块，请继续选择。`}</span>
        <ol aria-label="待应用的模块顺序">{positions[arrangement].map((position, index) => <li key={index}><b>{index + 1}</b><span>{position}<strong>{order[index] ? moduleLabels[order[index]] : '待选择'}</strong></span></li>)}</ol>
      </div>
    </fieldset>

    <footer className="ks-layout-picker-footer"><span>应用后保留正文、检索条件和问答内容。</span><div><button type="button" className="ks-button" onClick={onClose}>取消</button><button type="button" className="ks-button ks-primary" disabled={!complete} onClick={() => { if (complete) onApply({ arrangement, order: [order[0], order[1], order[2]] }) }}><Check size={15} />应用排列</button></div></footer>
  </div>
}
