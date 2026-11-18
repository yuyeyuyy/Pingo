import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AnswerPage } from './pages/AnswerPage'
import './styles/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('Pingo renderer root is missing.')

createRoot(root).render(
  <StrictMode>{location.hash === '#answer' ? <AnswerPage /> : <App />}</StrictMode>,
)
