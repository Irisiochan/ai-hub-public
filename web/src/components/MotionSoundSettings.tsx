import { useState, useSyncExternalStore } from 'react';
import {
  getUiPreferenceSnapshot,
  setMotionLevel,
  setSoundCueEnabled,
  setSoundEnabled,
  setSoundVolume,
  subscribeUiPreferences,
  type MotionLevel,
  type SoundCue,
} from '../preferences/store';
import { previewSounds } from '../sound';
import { Icon } from './icons';

const MOTION_OPTIONS: { value: MotionLevel; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'reduced', label: '低动效' },
  { value: 'full', label: '完整' },
];

const SOUND_OPTIONS: { value: SoundCue; label: string; note: string }[] = [
  { value: 'send', label: '发送', note: '低音量；连续发送至少间隔 300ms' },
  { value: 'assistant', label: '回复完成', note: '整轮 assistant 回复结束后一次' },
  { value: 'worker', label: 'Worker 完成', note: 'Worker 任务成功结束后一次' },
  { value: 'error', label: '错误', note: '消息或任务明确失败时一次' },
];

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) {
  return (
    <button
      type="button"
      className={`switch${checked ? ' on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

export default function MotionSoundSettings() {
  const snapshot = useSyncExternalStore(subscribeUiPreferences, getUiPreferenceSnapshot, getUiPreferenceSnapshot);
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);

  const preview = async () => {
    const played = await previewSounds();
    setPreviewNotice(played ? '正在依次播放：发送、回复完成、Worker 完成、错误' : '声音总开关已关闭，或浏览器尚未允许音频');
  };

  return (
    <section className="motion-sound-card" aria-labelledby="motion-sound-title">
      <div className="motion-sound-head">
        <span>
          <strong id="motion-sound-title">动效与声音</strong>
          <small>
            当前动效：{snapshot.effectiveMotion === 'off' ? '关闭' : snapshot.effectiveMotion === 'reduced' ? '低动效' : '完整'}
            {snapshot.motionOverride === null ? ` · 默认跟随${snapshot.systemReducedMotion ? '系统减弱动效' : '主题'}` : ' · 用户设置覆盖主题'}
          </small>
        </span>
      </div>

      <div className="preference-group">
        <span className="preference-label">动画等级</span>
        <div className="motion-level" role="group" aria-label="动画等级">
          {MOTION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={snapshot.effectiveMotion === option.value ? 'selected' : ''}
              aria-pressed={snapshot.motionOverride === option.value}
              onClick={() => setMotionLevel(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="switch-row accent">
        <span><b>声音总开关</b><small>内置 Web Audio 合成音效，不含第三方音频资产。</small></span>
        <Switch checked={snapshot.sound.enabled} label="声音总开关" onChange={setSoundEnabled} />
      </div>

      <div className="sound-cue-grid" aria-label="分项声音开关">
        {SOUND_OPTIONS.map((option) => (
          <div className="switch-row sub" key={option.value}>
            <span><b>{option.label}</b><small>{option.note}</small></span>
            <Switch
              checked={snapshot.sound.cues[option.value]}
              label={`${option.label}音效`}
              onChange={(enabled) => setSoundCueEnabled(option.value, enabled)}
            />
          </div>
        ))}
      </div>

      <div className="sound-volume-row">
        <label htmlFor="sound-volume">音量</label>
        <input
          id="sound-volume"
          type="range"
          min="0"
          max="100"
          step="5"
          value={Math.round(snapshot.sound.volume * 100)}
          onChange={(event) => setSoundVolume(Number(event.target.value) / 100)}
        />
        <output htmlFor="sound-volume">{Math.round(snapshot.sound.volume * 100)}%</output>
        <button type="button" className="ghost-btn sound-preview" onClick={() => void preview()}>
          <Icon name="send" />
          试听
        </button>
      </div>
      {previewNotice && <div className="theme-notice" role="status">{previewNotice}</div>}
    </section>
  );
}
