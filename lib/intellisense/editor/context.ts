import type { EditorState, Text } from '@codemirror/state';
import type { LanguageService, Position } from '../types';
import type { CodeRenderer } from './render';

/** Everything the IntelliSense extensions need, built once per editor language. */
export type Ctx = {
  service: LanguageService;
  /** Fence language name for Markdown code blocks ("cpp", "python", "rust"). */
  lang: string;
  code: CodeRenderer;
  /** Highlights a snippet and returns one element per line (definition peek). */
  lines: (code: string) => HTMLElement[];
};

export function toPosition(doc: Text, offset: number): Position {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

export function toOffset(doc: Text, pos: Position): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(Math.max(1, pos.line + 1));
  return Math.min(line.from + Math.max(0, pos.character), line.to);
}

export const docText = (state: EditorState) => state.doc.toString();
