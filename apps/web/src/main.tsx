import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { SessionProvider } from './hooks/useSession.js';
import { ApiRequestError } from './lib/api.js';
import { ROUTER_BASENAME } from './lib/base.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Two minutes. An operator moving between sections is asking the same
      // handful of questions over and over, and at thirty seconds a lap of the
      // panel refetched everything it had just been told. What changes under
      // an operator changes because they changed it, and every mutation
      // invalidates what it touched.
      staleTime: 2 * 60_000,
      // Ten minutes in cache after the last component stops using it, so
      // coming back to a section renders from what is already there and
      // revalidates behind the content rather than behind a spinner.
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Auth and validation failures will not fix themselves.
        if (error instanceof ApiRequestError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={ROUTER_BASENAME}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
