import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@hz/ui/styles.css';
import './styles/fonts.css';
import './styles/app.css';
import { App } from './App.js';
import { initTheme } from './lib/theme.js';

initTheme();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
