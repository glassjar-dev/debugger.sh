/**
 * IntelliSense for the CodeMirror editor: one call builds completion, hover,
 * signature help, live diagnostics, go-to-definition and inlay hints on top
 * of a `LanguageService`.
 */

import type { Extension } from '@codemirror/state';
import type { LRLanguage } from '@codemirror/language';
import type { Highlighter } from '@lezer/highlight';
import type { LanguageService } from '../types';
import { completion } from './completion';
import type { Ctx } from './context';
import { diagnostics } from './diagnostics';
import { definition, hover } from './hover';
import { inlayHints } from './inlay';
import { makeCodeRenderer, makeLineRenderer } from './render';
import { signatureHelp } from './signature';
import { statusPill } from './status';
import { intellisenseTheme } from './theme';

export function intellisense(options: {
  service: LanguageService;
  language: LRLanguage;
  highlighter: Highlighter;
  /** Markdown fence name: "cpp", "python" or "rust". */
  lang: string;
}): Extension {
  const ctx: Ctx = {
    service: options.service,
    lang: options.lang,
    code: makeCodeRenderer(options.language.parser, options.highlighter),
    lines: makeLineRenderer(options.language.parser, options.highlighter),
  };
  return [
    completion(ctx),
    hover(ctx),
    signatureHelp(ctx),
    diagnostics(ctx),
    definition(ctx),
    inlayHints(ctx),
    statusPill(ctx),
    intellisenseTheme,
  ];
}
