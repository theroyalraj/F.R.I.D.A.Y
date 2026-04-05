import React from 'react';
import ReactDOM from 'react-dom/client';
import { VoiceAppProvider } from './contexts/VoiceAppContext';
import FridayListenApp from './components/FridayListenApp';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <VoiceAppProvider>
      <FridayListenApp />
    </VoiceAppProvider>
  </React.StrictMode>,
);
