'use client';

import type { ReactNode } from 'react';
import { Bug, CircleDot } from 'lucide-react';

import type { DapVariable, ScopeView, StackFrame } from './dap-types';
import { EmptyState } from './EmptyState';
import { DebugControls, type DebugControlsProps } from './SourceActions';
import { VariableRow } from './VariableRow';

export type VariablesPanelProps = {
  /** The current language supports breakpoints. */
  canDebug: boolean;
  isRunning: boolean;
  hasBreakpoints: boolean;
  frames: StackFrame[];
  selectedFrameId: number | null;
  onSelectFrame: (id: number) => void;
  scopes: ScopeView[];
  expandVariable: (ref: number) => DapVariable[];
  isPaused: boolean;
  debugControls?: DebugControlsProps;
};

export function VariablesPanel(props: VariablesPanelProps) {
  const hasState = props.frames.length > 0 || props.scopes.length > 0;
  return (
    <aside className="ide-panel">
      {props.isPaused && props.debugControls && <DebugControls {...props.debugControls} />}
      {hasState ? (
        <>
          {props.frames.length > 0 && <SectionHeader>Call stack</SectionHeader>}
          <div style={{ maxHeight: '38%', overflowY: 'auto', flexShrink: 0, paddingBottom: 4 }}>
            <CallStack
              frames={props.frames}
              selectedFrameId={props.selectedFrameId}
              onSelectFrame={props.onSelectFrame}
            />
          </div>
          {props.scopes.length > 0 && <SectionHeader>Variables</SectionHeader>}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}>
            <Variables scopes={props.scopes} expandVariable={props.expandVariable} />
          </div>
        </>
      ) : (
        <NotPaused {...props} />
      )}
    </aside>
  );
}

/** What to do to see anything here, depending on where the user is. */
function NotPaused({ canDebug, isRunning, hasBreakpoints }: VariablesPanelProps) {
  if (!canDebug) {
    return (
      <EmptyState icon={<Bug size={18} />} title="No debugger for this language">
        Variables show up here for languages that support breakpoints.
      </EmptyState>
    );
  }
  if (isRunning) {
    return (
      <EmptyState icon={<Bug size={18} />} title={hasBreakpoints ? 'Waiting for a breakpoint' : 'Running'}>
        {hasBreakpoints
          ? 'The program pauses when it reaches a line with a breakpoint.'
          : 'No breakpoints set, so the program runs straight through.'}
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<CircleDot size={18} />} title={hasBreakpoints ? 'Ready to debug' : 'Pause your program'}>
      {hasBreakpoints ? (
        <>Press Debug. The program stops at your breakpoints and its variables appear here.</>
      ) : (
        <>Click a line number to set a breakpoint, then press Debug to step through your code.</>
      )}
    </EmptyState>
  );
}

function CallStack({
  frames,
  selectedFrameId,
  onSelectFrame,
}: Pick<VariablesPanelProps, 'frames' | 'selectedFrameId' | 'onSelectFrame'>) {
  if (frames.length === 0) return null;
  return (
    <>
      {frames.map((f) => {
        const selected = selectedFrameId === f.id;
        return (
          <button
            key={f.id}
            type="button"
            className="ide-frame"
            data-selected={selected ? 'true' : undefined}
            onClick={() => onSelectFrame(f.id)}
          >
            <span>{f.name}</span>
            {f.line != null && <span className="ide-frame-line">line {f.line}</span>}
          </button>
        );
      })}
    </>
  );
}

function Variables({
  scopes,
  expandVariable,
}: Pick<VariablesPanelProps, 'scopes' | 'expandVariable'>) {
  if (scopes.length === 0) return null;
  return (
    <>
      {scopes.map((scope) => (
        <div key={scope.name} style={{ marginBottom: 6 }}>
          <div className="ide-scope-name">{scope.name}</div>
          {scope.variables.map((v) => (
            <VariableRow key={v.name} variable={v} expand={expandVariable} depth={0} />
          ))}
        </div>
      ))}
    </>
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  return <div className="ide-section-header">{children}</div>;
}
