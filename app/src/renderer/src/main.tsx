import React from 'react'
import ReactDOM from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import App from './App'
import { persistOptions } from './lib/queryPersist'
import './global.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <PersistQueryClientProvider client={persistOptions.queryClient} persistOptions={persistOptions}>
      <App />
    </PersistQueryClientProvider>
  </React.StrictMode>
)
