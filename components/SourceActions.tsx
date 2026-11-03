'use client';

import { useEffect, useState } from 'react';
import { ArrowDownToDot, ArrowUpFromDot, Bug, RedoDot } from 'lucide-react';

/** "⌘" on Apple devices, "Ctrl" elsewhere. Decided after mount, since the server can't know. */
export function useModKey(): string {
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setMod('⌘');
  }, []);
  return mod;
}

export type RunStopProps = {
  isRunning: boolean;
  /** Breakpoints are set, so the run will stop at them. */
  debug: boolean;
  onRun: () => void;
  onStop: () => void;
};

/** Run (or Debug, with breakpoints) / Stop in the top bar. */
export function RunStopButton({ isRunning, debug, onRun, onStop }: RunStopProps) {
  const mod = useModKey();
  if (!isRunning) {
    const label = debug ? 'Debug' : 'Run';
    return (
      <button
        type="button"
        className="ide-btn ide-run-btn"
        data-mode={debug ? 'debug' : 'run'}
        aria-label={label}
        title={`${label} (${mod}+Enter)${debug ? ' — stops at your breakpoints' : ''}`}
        onClick={onRun}
      >
        {debug ? <Bug size={13} strokeWidth={2.25} aria-hidden /> : <PlayIcon />}
        {label}
        <kbd className="ide-kbd" aria-hidden>
          {mod}↵
        </kbd>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="ide-btn ide-stop-btn"
      aria-label="Stop"
      title="Stop the program"
      onClick={onStop}
    >
      <StopIcon />
      Stop
    </button>
  );
}

export type DebugControlsProps = {
  onContinue: () => void;
  onStepOver: () => void;
  onStepIn: () => void;
  onStepOut: () => void;
};

/** Continue / step controls — lives inside the variables pane body while paused. */
export function DebugControls({
  onContinue,
  onStepOver,
  onStepIn,
  onStepOut,
}: DebugControlsProps) {
  const mod = useModKey();
  return (
    <div className="ide-debug-bar" role="toolbar" aria-label="Debug controls">
      <button
        type="button"
        className="ide-debug-continue"
        aria-label="Continue"
        title={`Continue to the next breakpoint (${mod}+Enter)`}
        onClick={onContinue}
      >
        <PlayIcon />
        Continue
        <kbd className="ide-kbd" aria-hidden>
          {mod}↵
        </kbd>
      </button>
      <div className="ide-debug-group">
        <ActionBtn label="Step over" hint="Run this line" onClick={onStepOver}>
          <StepOverIcon />
        </ActionBtn>
        <ActionBtn label="Step into" hint="Go into the function call on this line" onClick={onStepIn}>
          <StepIntoIcon />
        </ActionBtn>
        <ActionBtn label="Step out" hint="Finish this function and return" onClick={onStepOut}>
          <StepOutIcon />
        </ActionBtn>
      </div>
    </div>
  );
}

function ActionBtn({
  label,
  hint,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="ide-action-btn"
      title={`${label}: ${hint}`}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 11 11" fill="currentColor" aria-hidden>
      <path d="M3 2 L9 5.5 L3 9 Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 11 11" fill="currentColor" aria-hidden>
      <rect x="2.5" y="2.5" width="6" height="6" />
    </svg>
  );
}

const stepIconProps = {
  size: 15,
  strokeWidth: 1.75,
  'aria-hidden': true as const,
};

function StepOverIcon() {
  return <RedoDot {...stepIconProps} />;
}

function StepIntoIcon() {
  return <ArrowDownToDot {...stepIconProps} />;
}

function StepOutIcon() {
  return <ArrowUpFromDot {...stepIconProps} />;
}
