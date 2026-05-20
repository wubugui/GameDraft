import type { ReactNode } from 'react';
import { ToolbarPopover } from './ToolbarPopover';
import {
  EDITOR_FONT_FAMILY_OPTIONS,
  type EditorPreferences,
} from '../utils/editorPreferences';

function SettingsField(props: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{props.label}</span>
      {props.hint ? <span className="settings-field-hint">{props.hint}</span> : null}
      {props.children}
    </label>
  );
}

export function SettingsMenu(props: {
  preferences: EditorPreferences;
  onChange: (patch: Partial<EditorPreferences>) => void;
  onReset: () => void;
}) {
  const { preferences } = props;

  return (
    <ToolbarPopover label="设置" panelClassName="settings-popover-panel" align="end">
      <div className="settings-popover-head">
        <strong>编辑器偏好</strong>
        <span className="settings-popover-sub">字体与界面表现，保存在本机</span>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">字体与界面</div>
        <SettingsField label="界面字号" hint={`${preferences.uiFontSize}px`}>
          <input
            type="range"
            min={11}
            max={18}
            step={1}
            value={preferences.uiFontSize}
            onChange={(e) => props.onChange({ uiFontSize: Number(e.target.value) })}
          />
        </SettingsField>
        <SettingsField label="界面字体">
          <select
            value={preferences.fontFamily}
            onChange={(e) => props.onChange({ fontFamily: e.target.value as EditorPreferences['fontFamily'] })}
          >
            {EDITOR_FONT_FAMILY_OPTIONS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </SettingsField>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">画布</div>
        <SettingsField label="节点标签缩放" hint={`${preferences.canvasLabelScale}%`}>
          <input
            type="range"
            min={80}
            max={140}
            step={5}
            value={preferences.canvasLabelScale}
            onChange={(e) => props.onChange({ canvasLabelScale: Number(e.target.value) })}
          />
        </SettingsField>
        <SettingsField label="连线标签缩放" hint={`${preferences.edgeLabelScale}%`}>
          <input
            type="range"
            min={80}
            max={140}
            step={5}
            value={preferences.edgeLabelScale}
            onChange={(e) => props.onChange({ edgeLabelScale: Number(e.target.value) })}
          />
        </SettingsField>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={preferences.canvasShowGrid}
            onChange={(e) => props.onChange({ canvasShowGrid: e.target.checked })}
          />
          显示画布点阵
        </label>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">检查器</div>
        <SettingsField label="JSON 字号" hint={`${preferences.inspectorJsonFontSize}px`}>
          <input
            type="range"
            min={10}
            max={18}
            step={1}
            value={preferences.inspectorJsonFontSize}
            onChange={(e) => props.onChange({ inspectorJsonFontSize: Number(e.target.value) })}
          />
        </SettingsField>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">偏好</div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={preferences.defaultShowMiniMap}
            onChange={(e) => props.onChange({ defaultShowMiniMap: e.target.checked })}
          />
          接线/调试模式默认显示小地图
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={preferences.reduceMotion}
            onChange={(e) => props.onChange({ reduceMotion: e.target.checked })}
          />
          减少界面动效
        </label>
      </div>

      <div className="settings-popover-actions">
        <button type="button" className="toolbar-btn" onClick={props.onReset}>恢复默认</button>
      </div>
    </ToolbarPopover>
  );
}
