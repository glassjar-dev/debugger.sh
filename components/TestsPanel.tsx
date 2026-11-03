'use client';

import { FlaskConical } from 'lucide-react';

import type { Lang } from '@/components/constants';
import type { TestInfo, TestResult, TestRunState } from '@/lib/testing/protocol';

import { EmptyState } from './EmptyState';

export type TestsPanelProps = {
  lang: Lang;
  state: TestRunState | null;
  isRunning: boolean;
};

export function TestsPanel({ lang, state, isRunning }: TestsPanelProps) {
  const tests = state?.tests ?? [];
  const results = state?.results ?? new Map<string, TestResult>();
  const passed = [...results.values()].filter((r) => r.status === 'passed').length;
  const failed = [...results.values()].filter(
    (r) => r.status === 'failed' || r.status === 'errored',
  ).length;

  // Results from a C++ run don't belong to the Python or Rust code on screen.
  if (lang !== 'c') {
    return (
      <aside className="ide-panel">
        <EmptyState icon={<FlaskConical size={18} />} title="Tests are for C++">
          The test runner works with C++ programs that use <code>SimpleTest.h</code>.
        </EmptyState>
      </aside>
    );
  }

  if (!state || (!tests.length && !state.error && !state.terminated)) {
    return (
      <aside className="ide-panel">
        {isRunning ? (
          <EmptyState icon={<FlaskConical size={18} />} title="Running">
            Test results appear here if your program has tests.
          </EmptyState>
        ) : (
          <EmptyState icon={<FlaskConical size={18} />} title="No test results yet">
            Write a <code>PROVIDED_TEST</code> or <code>STUDENT_TEST</code>, then press Run to see
            which ones pass.
          </EmptyState>
        )}
      </aside>
    );
  }

  let summary: string;
  let tone: 'error' | undefined;
  if (isRunning && !state.finished) summary = 'Running tests…';
  else if (state.error) {
    tone = 'error';
    summary = "Couldn't run the tests. See the Terminal for details.";
  } else if (state.terminated) summary = state.terminated.message ?? state.terminated.reason;
  else summary = `${passed} of ${tests.length} passed`;

  return (
    <aside className="ide-panel">
      <div className="ide-tests-summary" data-tone={tone}>
        <span>{summary}</span>
        {tests.length > 0 && (
          <span className="ide-tests-bar" aria-hidden>
            <span style={{ width: `${(passed / tests.length) * 100}%`, background: 'var(--gj-ok)' }} />
            <span style={{ width: `${(failed / tests.length) * 100}%`, background: 'var(--gj-danger)' }} />
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0' }}>
        {tests.map((test) => (
          <TestRow key={test.key} test={test} result={results.get(test.key)} />
        ))}
      </div>
    </aside>
  );
}

function TestRow({ test, result }: { test: TestInfo; result?: TestResult }) {
  const status = result?.status;
  const mark =
    status === 'passed' ? '✓' : status === 'failed' || status === 'errored' ? '✕' : status === 'running' ? '…' : '';
  const failed = status === 'failed' || status === 'errored';
  const failLine = result?.line ?? test.line;

  return (
    <div className="ide-test-row" data-status={status}>
      <div className="ide-test-head">
        <span className="ide-test-badge" aria-label={status ?? 'not run'}>
          {mark}
        </span>
        <span className="ide-test-name">{test.name}</span>
      </div>
      {failed && (result?.message || result?.actual || result?.expected) && (
        <div className="ide-test-detail">
          {result?.message && <div>{result.message}</div>}
          {result?.actual && (
            <div>
              {failLine != null && (
                <>
                  <span style={{ fontWeight: 700 }}>Line {failLine}</span>
                  {': '}
                </>
              )}
              {result.actual.expression} = {result.actual.value}
            </div>
          )}
          {result?.expected && (
            <div>
              expected {result.expected.expression} = {result.expected.value}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
