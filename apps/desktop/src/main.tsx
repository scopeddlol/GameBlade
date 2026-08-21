import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { startErrorLog } from './lib/errorLog.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container is missing from index.html');
}

// Started before the app mounts, so an error during the first render is
// still in the buffer if someone reports it.
startErrorLog();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
