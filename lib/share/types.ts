import type { DockState } from '@/components/dock/types';
import type { Lang } from '@/components/constants';

/** Serializable workspace snapshot stored as `shares/<id>.json`. Extend freely. */
export type WorkspaceState = {
  lang: Lang;
  /** Every file by workspace path; the entry file (`main.cpp`, …) is always present. */
  files: Record<string, string>;
  /** Empty folders. */
  dirs?: string[];
  layout?: DockState;
};
