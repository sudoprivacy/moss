import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Providers } from '@/components/providers'
import App from './app'
import './globals.css'

const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename || undefined}>
      <Providers>
        <App />
      </Providers>
    </BrowserRouter>
  </React.StrictMode>,
)
