import type { ReactNode } from 'react';

/** A centered hint for a panel with nothing to show yet. */
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="ide-empty">
      <div className="ide-empty-icon" aria-hidden>
        {icon}
      </div>
      <div className="ide-empty-title">{title}</div>
      <div className="ide-empty-body">{children}</div>
    </div>
  );
}
