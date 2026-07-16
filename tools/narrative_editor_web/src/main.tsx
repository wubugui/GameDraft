import { installResizeObserverQuiet } from './utils/resizeObserverQuiet';

installResizeObserverQuiet();

import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { NarrativeEditorApp } from './NarrativeEditorApp';
import { EditorErrorBoundary } from './components/EditorErrorBoundary';
import { applyEditorPreferences, loadEditorPreferencesLocal } from './utils/editorPreferences';

// 首帧防闪：先用本地兜底值应用一次；真正的工程偏好由 useEditorPreferences 经 bridge 异步加载覆盖。
applyEditorPreferences(loadEditorPreferencesLocal());

if (import.meta.env.PROD) {
  console.info('[narrative-editor] build', import.meta.url);
}

document.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <EditorErrorBoundary>
      <NarrativeEditorApp />
    </EditorErrorBoundary>
  </React.StrictMode>,
);
