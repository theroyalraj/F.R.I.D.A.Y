import React from 'react';
import ReactDOM from 'react-dom/client';
import { SetupWizard } from './SetupWizard';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SetupWizard />
  </React.StrictMode>,
);
