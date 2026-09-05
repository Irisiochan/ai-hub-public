import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import MobileGate from './components/MobileGate';
import SessionGate from './components/SessionGate';
import { ConfirmProvider } from './components/ConfirmDialog';
import { initializeThemeSystem } from './theme/store';
import { initializeUiPreferences } from './preferences/store';
import { initializeSoundSystem } from './sound';
import './styles.css';

initializeThemeSystem();
initializeUiPreferences();
initializeSoundSystem();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfirmProvider>
      <MobileGate>
        <SessionGate>
          <App />
        </SessionGate>
      </MobileGate>
    </ConfirmProvider>
  </React.StrictMode>
);
