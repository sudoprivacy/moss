import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { Providers } from '@/components/providers'
import App from './app'
import './globals.css'

const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

const router = createBrowserRouter(
  [{ path: '*', element: <Providers><App /></Providers> }],
  { basename: basename || undefined },
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
