import React from 'react'
import ReactDOM from 'react-dom/client'
import { PrototypeApp } from './prototype-app'
import '../src/globals.css'
import './prototype.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrototypeApp />
  </React.StrictMode>,
)
