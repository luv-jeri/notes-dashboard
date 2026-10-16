import '@fontsource-variable/dm-sans/opsz.css'
import './styles/global.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createQueryClient } from './queryClient'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App queryClient={createQueryClient()} />
  </StrictMode>,
)
