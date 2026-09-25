import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import MobileGate from './app/MobileGate';
import SessionGate from './app/SessionGate';
import { ConfirmProvider } from './platform/ConfirmDialog';
import { initializeThemeSystem } from './settings/theme/store';
import { initializeUiPreferences } from './settings/preferences/store';
import { initializeSoundSystem } from './settings/sound';
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
