import { installResizeObserverQuiet } from './utils/resizeObserverQuiet';

installResizeObserverQuiet();

import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { NarrativeEditorApp } from './NarrativeEditorApp';
import { applyEditorPreferences, loadEditorPreferences } from './utils/editorPreferences';

applyEditorPreferences(loadEditorPreferences());

document.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NarrativeEditorApp />
  </React.StrictMode>,
);
