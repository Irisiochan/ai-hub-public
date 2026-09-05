import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelOption } from '../api';
import { visibleModelOptions } from '../modelSearch';
import { Icon } from './icons';

interface Props {
  value: string;
  options: ModelOption[];
  disabled?: boolean;
  allowCustom?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  variant?: 'runtime' | 'field';
  onChange(id: string): void;
}

export default function ModelPicker(props: Props) {
  const { value, options, disabled, allowCustom, placeholder, variant = 'runtime' } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.id === value);
  const customId = query.trim();
  const showCustom = Boolean(
    allowCustom && customId && !options.some((option) => option.id === customId),
  );
  const visible = useMemo(() => visibleModelOptions(options, query), [options, query]);
  const items = visible.items;
  const activeOption = showCustom && active === 0
    ? 'custom'
    : items[showCustom ? active - 1 : active];
  const activeDomId = activeOption === 'custom'
    ? `${listId}-custom`
    : activeOption
      ? `${listId}-${activeOption.id || 'default'}`
      : undefined;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const choose = (id: string) => {
    props.onChange(id);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    const count = items.length + (showCustom ? 1 : 0);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (count > 0) setActive((current) => (current + 1) % count);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (count > 0) setActive((current) => (current - 1 + count) % count);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (showCustom && active === 0) choose(customId);
      else if (activeOption && activeOption !== 'custom') choose(activeOption.id);
      else if (showCustom) choose(customId);
    }
  };

  if (options.length === 0) {
    return (
      <input
        className={variant === 'field' ? 'cfg-mono' : 'runtime-select'}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={props.ariaLabel}
        onChange={(event) => props.onChange(event.target.value)}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className={'model-picker' + (variant === 'field' ? ' field' : '') + (open ? ' open' : '')}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled}
        aria-label={props.ariaLabel ?? '选择模型'}
        aria-expanded={open}
        aria-controls={listId}
        title={props.title}
        onClick={() => !disabled && setOpen((current) => !current)}
      >
        <span className="model-picker-value">{selected?.label || value || placeholder || '选择模型'}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open && (
        <div className="model-picker-panel">
          <div className="model-picker-search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder={`搜索 ${options.length} 个模型`}
              aria-label="搜索模型"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeDomId}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
            />
          </div>
          <ul className="model-picker-list" id={listId} role="listbox">
            {showCustom && (
              <li>
                <button
                  type="button"
                  id={`${listId}-custom`}
                  role="option"
                  aria-selected={false}
                  className={'model-picker-option custom' + (active === 0 ? ' active' : '')}
                  onMouseEnter={() => setActive(0)}
                  onClick={() => choose(customId)}
                >
                  使用 {customId}
                </button>
              </li>
            )}
            {items.map((option, index) => {
              const offset = showCustom ? index + 1 : index;
              return (
                <li key={option.id || '__default'}>
                  <button
                    type="button"
                    id={`${listId}-${option.id || 'default'}`}
                    role="option"
                    aria-selected={option.id === value}
                    className={
                      'model-picker-option'
                      + (option.id === value ? ' selected' : '')
                      + (offset === active ? ' active' : '')
                    }
                    title={option.description}
                    onMouseEnter={() => setActive(offset)}
                    onClick={() => choose(option.id)}
                  >
                    <span>{option.label}</span>
                    {option.label !== option.id && option.id ? <small>{option.id}</small> : null}
                  </button>
                </li>
              );
            })}
            {items.length === 0 && !showCustom && (
              <li className="model-picker-empty">没有匹配的模型</li>
            )}
          </ul>
          {visible.hidden > 0 && (
            <div className="model-picker-more">还有 {visible.hidden} 个，继续输入以筛选</div>
          )}
        </div>
      )}
    </div>
  );
}
