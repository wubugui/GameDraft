import { useCallback, useEffect, useRef, useState } from 'react';
import { loadProjection, validateNarrativeDataRemote } from '../bridge';
import { mergeValidationIssues, validateNarrativeData } from '../editorModel';
import type { NarrativeGraphsFileDef, ProjectionResult, ValidationIssueDef } from '../types';

const DEFER_MS = 400;

const emptyProjection: ProjectionResult = {
  schemaVersion: 1,
  triggerEdges: [],
  readEdges: [],
  stateCommandEdges: [],
  warnings: [],
};

export function useDeferredWorkspace() {
  const [projection, setProjection] = useState<ProjectionResult>(emptyProjection);
  const [validationIssues, setValidationIssues] = useState<ValidationIssueDef[]>([]);
  const [remoteSyncing, setRemoteSyncing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  const applyLocalValidation = useCallback((data: NarrativeGraphsFileDef) => {
    setValidationIssues(validateNarrativeData(data));
  }, []);

  const runRemoteSync = useCallback(async (data: NarrativeGraphsFileDef) => {
    const requestId = ++requestIdRef.current;
    setRemoteSyncing(true);
    try {
      const [remoteIssues, nextProjection] = await Promise.all([
        validateNarrativeDataRemote(data),
        loadProjection(data),
      ]);
      if (requestId !== requestIdRef.current) return;
      setValidationIssues(mergeValidationIssues(validateNarrativeData(data), remoteIssues));
      setProjection(nextProjection);
    } finally {
      if (requestId === requestIdRef.current) setRemoteSyncing(false);
    }
  }, []);

  const scheduleRemoteSync = useCallback((data: NarrativeGraphsFileDef) => {
    applyLocalValidation(data);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runRemoteSync(data);
    }, DEFER_MS);
  }, [applyLocalValidation, runRemoteSync]);

  const flushRemoteSync = useCallback(async (data: NarrativeGraphsFileDef) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    applyLocalValidation(data);
    await runRemoteSync(data);
  }, [applyLocalValidation, runRemoteSync]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return {
    projection,
    validationIssues,
    remoteSyncing,
    applyLocalValidation,
    scheduleRemoteSync,
    flushRemoteSync,
    setValidationIssues,
    setProjection,
  };
}
