import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/**
 * A data router, not `<BrowserRouter>`.
 *
 * Nothing here loads data — the whole app fetches through TanStack Query and
 * always will. The reason is `useBlocker`, which is how a form warns before
 * you navigate away from unsaved edits: react-router only registers a blocker
 * against a data router, and throws under `<BrowserRouter>`.
 */
const router = createBrowserRouter(routes);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
