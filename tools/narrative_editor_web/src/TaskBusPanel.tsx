import { useMemo, useState } from 'react';
import { navigateTo } from './bridge';
import type {
  TaskIndex,
  TaskIssueDef,
  TaskPlaneDef,
  TaskQuestDef,
  TaskReferenceDef,
  TaskSceneEntityDef,
  ValidationIssueDef,
} from './types';

const ISSUE_KIND_ICON: Record<string, string> = {
  emptyPlane: '🌐',
  danglingSignalNoEmit: '📡',
  danglingEmitDeclared: '📣',
  badRef: '🔗',
};

const ISSUE_KIND_LABEL: Record<string, string> = {
  emptyPlane: '空位面',
  danglingSignalNoEmit: '悬空信号',
  danglingEmitDeclared: '空声明',
  badRef: '坏引用',
};

const KIND_ICON: Record<string, string> = {
  dialogue: '💬',
  scenario: '🎬',
  minigame: '🎮',
  zone: '🟦',
  cutscene: '🎞️',
  npc: '🧍',
  hotspot: '📍',
  scene: '🗺️',
  quest: '📜',
  plane: '🌐',
};

const KIND_LABEL: Record<string, string> = {
  dialogue: '对话图',
  scenario: 'Scenario',
  minigame: '小游戏',
  zone: 'Zone',
  cutscene: '过场',
  npc: 'NPC',
  hotspot: '热点',
  scene: '场景',
  quest: '任务',
  plane: '位面',
};

const VIA_LABEL: Record<string, string> = {
  condition: '条件引用',
  plane: '位面归属',
  wrapper: 'wrapper 镜像',
};

function kindTag(kind: string): string {
  return `${KIND_ICON[kind] ?? '•'} ${KIND_LABEL[kind] ?? kind}`;
}

interface TaskBusRow {
  key: string;
  kind: string;
  title: string;
  meta?: string;
  haystack: string;
  onOpen: () => void;
}

function TaskBusGroup(props: { title: string; count: number; rows: TaskBusRow[]; emptyHint: string }) {
  if (props.count === 0) {
    return (
      <details className="entity-wrapper-card">
        <summary>
          <span>{props.title}</span>
          <small>0</small>
        </summary>
        <div className="muted">{props.emptyHint}</div>
      </details>
    );
  }
  return (
    <details className="entity-wrapper-card" open>
      <summary>
        <span>{props.title}</span>
        <small>{props.count}</small>
      </summary>
      {props.rows.length > 0 ? (
        <div className="task-bus-rows">
          {props.rows.map((row) => (
            <button key={row.key} type="button" className="task-bus-row" onClick={row.onOpen} title={`跳转到 ${row.title}`}>
              <span className="task-bus-kind">{kindTag(row.kind)}</span>
              <span className="task-bus-title">{row.title}</span>
              {row.meta && <span className="task-bus-meta">{row.meta}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="muted">没有命中搜索结果。</div>
      )}
    </details>
  );
}

export function TaskBusPanel(props: {
  index: TaskIndex;
  compositionLabel?: string;
  issues?: TaskIssueDef[];
  onFocusIssue?: (issue: ValidationIssueDef) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const match = (haystack: string) => !q || haystack.toLowerCase().includes(q);

  const issues = props.issues ?? [];
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const filteredIssues = issues.filter((i) =>
    match(`${i.kind} ${ISSUE_KIND_LABEL[i.kind] ?? i.kind} ${i.message}`),
  );
  const openIssue = (issue: TaskIssueDef) => {
    if (issue.focus && props.onFocusIssue) {
      props.onFocusIssue(issue.focus);
      return;
    }
    if (issue.navigate) navigateTo(issue.navigate.kind, issue.navigate.id);
  };

  const referenceRows = useMemo<TaskBusRow[]>(
    () =>
      props.index.references.map((ref: TaskReferenceDef, i) => ({
        key: `ref:${ref.elementId}:${ref.kind}:${ref.id}:${i}`,
        kind: ref.kind,
        title: ref.label || ref.id,
        meta: ref.id,
        haystack: `${ref.kind} ${ref.id} ${ref.label} ${ref.elementId}`,
        onOpen: () => navigateTo(ref.kind, ref.id),
      })),
    [props.index.references],
  );

  const planeRows = useMemo<TaskBusRow[]>(
    () =>
      props.index.planes.map((plane: TaskPlaneDef, i) => ({
        key: `plane:${plane.id}:${i}`,
        kind: 'plane',
        title: plane.label || plane.id,
        meta: `${plane.id} · 状态: ${plane.states.join(' / ') || '—'}`,
        haystack: `${plane.id} ${plane.label} ${plane.states.join(' ')}`,
        onOpen: () => navigateTo('plane', plane.id),
      })),
    [props.index.planes],
  );

  const entityRows = useMemo<TaskBusRow[]>(
    () =>
      props.index.sceneEntities.map((entity: TaskSceneEntityDef, i) => ({
        key: `entity:${entity.navId}:${entity.kind}:${i}`,
        kind: entity.kind,
        title: entity.label || entity.entityId,
        meta: `${entity.sceneId}:${entity.entityId} · ${VIA_LABEL[entity.via] ?? entity.via}`,
        haystack: `${entity.kind} ${entity.sceneId} ${entity.entityId} ${entity.label} ${entity.via}`,
        onOpen: () => navigateTo(entity.kind, entity.navId),
      })),
    [props.index.sceneEntities],
  );

  const questRows = useMemo<TaskBusRow[]>(
    () =>
      props.index.quests.map((quest: TaskQuestDef, i) => ({
        key: `quest:${quest.id}:${i}`,
        kind: 'quest',
        title: quest.label || quest.id,
        meta: `${quest.id} · ${VIA_LABEL[quest.via] ?? quest.via}`,
        haystack: `${quest.id} ${quest.label} ${quest.via}`,
        onOpen: () => navigateTo('quest', quest.id),
      })),
    [props.index.quests],
  );

  const filteredRefs = referenceRows.filter((r) => match(r.haystack));
  const filteredPlanes = planeRows.filter((r) => match(r.haystack));
  const filteredEntities = entityRows.filter((r) => match(r.haystack));
  const filteredQuests = questRows.filter((r) => match(r.haystack));

  return (
    <div className="entity-view">
      <div className="property-summary">
        <b>{props.compositionLabel || props.index.compositionId || '（未选择编排）'}</b>
        <div className="property-summary-grid">
          <div className="property-summary-row"><span>问题</span><strong className={errorCount ? 'task-bus-issue-error' : undefined}>{issues.length}</strong></div>
          <div className="property-summary-row"><span>引用</span><strong>{props.index.references.length}</strong></div>
          <div className="property-summary-row"><span>位面</span><strong>{props.index.planes.length}</strong></div>
          <div className="property-summary-row"><span>场景实体</span><strong>{props.index.sceneEntities.length}</strong></div>
          <div className="property-summary-row"><span>任务</span><strong>{props.index.quests.length}</strong></div>
        </div>
      </div>
      <div className="field">
        <label>搜索（kind / id / label）</label>
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="entity-wrapper-list">
        <details className={`entity-wrapper-card${errorCount ? ' task-bus-issues-error' : ''}`} open={issues.length > 0}>
          <summary>
            <span>{errorCount ? '⛔ ' : issues.length ? '⚠️ ' : ''}问题（信号断链 / 空位面 / 坏引用）</span>
            <small className={errorCount ? 'task-bus-issue-error' : undefined}>{issues.length}</small>
          </summary>
          {issues.length === 0 ? (
            <div className="muted">本编排未发现问题。</div>
          ) : filteredIssues.length === 0 ? (
            <div className="muted">没有命中搜索结果。</div>
          ) : (
            <div className="task-bus-rows">
              {filteredIssues.map((issue, i) => (
                <button
                  key={`issue:${issue.kind}:${i}`}
                  type="button"
                  className={`task-bus-row ${issue.severity}`}
                  onClick={() => openIssue(issue)}
                  title={issue.message}
                >
                  <span className="task-bus-kind">
                    {ISSUE_KIND_ICON[issue.kind] ?? '•'} {issue.severity === 'error' ? '错' : '警'}·{ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}
                  </span>
                  <span className="task-bus-title">{issue.message}</span>
                </button>
              ))}
            </div>
          )}
        </details>
        <TaskBusGroup title="引用（对话图 / Scenario / 小游戏 / 过场 / Zone）" count={props.index.references.length} rows={filteredRefs} emptyHint="本编排没有 blackbox 引用。" />
        <TaskBusGroup title="位面（各状态 activePlane）" count={props.index.planes.length} rows={filteredPlanes} emptyHint="本编排没有状态点名位面。" />
        <TaskBusGroup title="场景实体（条件引用 / 位面归属）" count={props.index.sceneEntities.length} rows={filteredEntities} emptyHint="没有场景实体引用本编排。" />
        <TaskBusGroup title="镜像任务" count={props.index.quests.length} rows={filteredQuests} emptyHint="没有任务镜像本编排。" />
      </div>
    </div>
  );
}
