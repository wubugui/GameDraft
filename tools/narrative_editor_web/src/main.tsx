import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { NarrativeEditorApp } from './NarrativeEditorApp';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NarrativeEditorApp />
  </React.StrictMode>,
);
