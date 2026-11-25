import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { BrowserRouter } from 'react-router';
import { createQueryClient } from './lib/query.js';
import { AppRoutes } from './routes/AppRoutes.js';
import { ApiHandlers } from './shell/StepUp.js';

export function App(): ReactElement {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ApiHandlers />
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
