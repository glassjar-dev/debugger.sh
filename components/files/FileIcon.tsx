import { Braces, File, FileCode2, FileText, Folder, FolderOpen } from 'lucide-react';

import { extname } from '@/lib/workspace/paths';

/** Icon and tint per extension, matching the editor's syntax palette. */
const KINDS: Record<string, { Icon: typeof File; color: string }> = {
  c: { Icon: FileCode2, color: '#60a5fa' },
  cc: { Icon: FileCode2, color: '#60a5fa' },
  cpp: { Icon: FileCode2, color: '#60a5fa' },
  cxx: { Icon: FileCode2, color: '#60a5fa' },
  h: { Icon: FileCode2, color: '#c084fc' },
  hh: { Icon: FileCode2, color: '#c084fc' },
  hpp: { Icon: FileCode2, color: '#c084fc' },
  py: { Icon: FileCode2, color: '#facc15' },
  rs: { Icon: FileCode2, color: '#fb923c' },
  json: { Icon: Braces, color: '#4ade80' },
  toml: { Icon: Braces, color: '#4ade80' },
  md: { Icon: FileText, color: '#94a3b8' },
  txt: { Icon: FileText, color: '#94a3b8' },
};

export function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  const { Icon, color } = KINDS[extname(path)] ?? { Icon: File, color: '#8b929e' };
  return <Icon className="gj-file-icon" size={size} strokeWidth={1.75} color={color} aria-hidden />;
}

export function FolderIcon({ open, size = 14 }: { open: boolean; size?: number }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon className="gj-file-icon" size={size} strokeWidth={1.75} color="#7cc4ff" aria-hidden />;
}
