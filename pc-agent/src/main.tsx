import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from './contexts/AuthContext';
import { VoiceAppProvider } from './contexts/VoiceAppContext';
import AuthGuard from './components/AuthGuard';
import FridayListenApp from './components/FridayListenApp';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <VoiceAppProvider>
        <AuthGuard>
          <FridayListenApp />
        </AuthGuard>
      </VoiceAppProvider>
    </AuthProvider>
  </React.StrictMode>,
);
