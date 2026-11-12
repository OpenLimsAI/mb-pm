import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './components/ui/workbenchLink.css'
import App from './App.tsx'
import './styles/efficient-workspace.css'
import './styles/forest-theme.css'
import './styles/forest-applications.css'
import './styles/forest-shell.css'
import './styles/blue-workspace.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
