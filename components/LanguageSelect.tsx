'use client';

import { useRef, type KeyboardEvent } from 'react';

import { LANGS, type Lang } from '@/components/constants';

export type LanguageSelectProps = {
  value: Lang;
  onChange: (lang: Lang) => void;
  disabled?: boolean;
};

/** Brand-ish dot per language, so the current one reads at a glance. */
const LANG_DOT: Record<Lang, string> = {
  c: '#7cc4ff',
  python: '#fbbf24',
  rust: '#fb7c4a',
};

/** Every language visible at once, as a segmented radio group. */
export function LanguageSelect({ value, onChange, disabled }: LanguageSelectProps) {
  const langs = Object.keys(LANGS) as Lang[];
  const refs = useRef<Partial<Record<Lang, HTMLButtonElement | null>>>({});

  // Arrow keys move between languages, like a native radio group.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = langs[(langs.indexOf(value) + step + langs.length) % langs.length]!;
    onChange(next);
    refs.current[next]?.focus();
  };

  return (
    <div
      className="ide-lang-segment"
      role="radiogroup"
      aria-label="Language"
      onKeyDown={onKeyDown}
      title={disabled ? 'Stop the program to switch language' : undefined}
    >
      {langs.map((lang) => {
        const selected = lang === value;
        return (
          <button
            key={lang}
            ref={(el) => {
              refs.current[lang] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className="ide-lang-option"
            disabled={disabled}
            onClick={() => onChange(lang)}
          >
            <span
              className="ide-lang-dot"
              style={{ background: LANG_DOT[lang], opacity: selected ? 1 : 0.45 }}
              aria-hidden
            />
            {LANGS[lang].label}
          </button>
        );
      })}
    </div>
  );
}
