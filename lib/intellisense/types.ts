/**
 * The editor's view of a language backend. Every backend (clang, rustc +
 * rust-analyzer, basedpyright) is adapted to this one shape so the CodeMirror
 * layer, and its look, is shared by all three languages.
 *
 * Positions are LSP-style: 0-based line, 0-based UTF-16 character.
 */

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };

export type CompletionKind =
  | 'function'
  | 'method'
  | 'constructor'
  | 'field'
  | 'variable'
  | 'class'
  | 'struct'
  | 'enum'
  | 'member'
  | 'interface'
  | 'module'
  | 'namespace'
  | 'keyword'
  | 'snippet'
  | 'constant'
  | 'macro'
  | 'type'
  | 'property'
  | 'text';

export type CompletionItem = {
  /** What the user types to match this item. */
  label: string;
  /** What the row shows, when it differs from `label` (rust-analyzer's `push(…)`). */
  display?: string;
  kind: CompletionKind;
  /** Return type or declared type, shown dimmed on the right of the row. */
  detail?: string;
  /** Full signature, shown in the docs panel header. */
  signature?: string;
  /** Markdown documentation. */
  documentation?: string;
  /** Text to insert; a snippet in CodeMirror syntax when `snippet` is true. */
  insert?: string;
  snippet?: boolean;
  /** Higher sorts first among equally good fuzzy matches. */
  boost?: number;
  deprecated?: boolean;
  /** Extra edits applied with the item, such as an auto-added `use` line. */
  additionalEdits?: TextEdit[];
  /** Open signature help right after inserting (a call with arguments). */
  triggerSignature?: boolean;
  /** Loads documentation lazily when the row is selected (basedpyright). */
  resolve?: () => Promise<Pick<CompletionItem, 'documentation' | 'signature' | 'detail'> | null>;
};

export type CompletionResult = {
  /** Where the replaced word starts. */
  from: Position;
  items: CompletionItem[];
  /** True when the backend already filtered on the typed prefix in a way CM should not redo. */
  incomplete?: boolean;
};

export type HoverResult = {
  /** Code shown as the card's signature (highlighted in the file's language). */
  code?: string;
  /** Markdown body. */
  markdown?: string;
  /** Small label above the code, such as "method" or "local variable". */
  kind?: string;
  range?: Range;
};

export type SignatureInfo = {
  label: string;
  /** [start, end) offsets into `label`. */
  parameters: Array<[number, number]>;
  documentation?: string;
};

export type SignatureResult = {
  signatures: SignatureInfo[];
  active: number;
  activeParameter: number | null;
};

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export type Diagnostic = {
  range: Range;
  severity: Severity;
  message: string;
  /** e.g. E0308, reportAttributeAccessIssue */
  code?: string;
  /** Where the message came from, such as "clang", "rustc", "rust-analyzer". */
  source?: string;
  /** Extra notes shown under the message. */
  notes?: string[];
  /** Grays out the range (unused code). */
  unnecessary?: boolean;
  /** Machine-applicable fixes (clang fix-its, rustc suggestions). */
  fixes?: Fix[];
};

export type TextEdit = { range: Range; text: string };
export type Fix = { title: string; edits: TextEdit[] };

export type DefinitionTarget =
  | { kind: 'local'; range: Range }
  | {
      kind: 'external';
      /** Display path, e.g. "vector.h" or "alloc/src/vec/mod.rs". */
      path: string;
      /** 0-based line within `snippet` to highlight. */
      line: number;
      snippet: string;
      /** 1-based line number of the snippet's first line in the original file. */
      firstLine: number;
    };

export type InlayHint = {
  position: Position;
  label: string;
  kind: 'type' | 'parameter' | 'other';
  paddingLeft?: boolean;
  paddingRight?: boolean;
};

export type ServiceStatus =
  | { state: 'idle' }
  | { state: 'loading'; detail: string }
  | { state: 'ready'; detail?: string }
  | { state: 'error'; detail: string };

/** One per language; lives as long as the page. */
export interface LanguageService {
  /** Called on every document change (cheap; backends debounce). */
  update(text: string, version: number): void;
  complete(text: string, pos: Position, explicit: boolean): Promise<CompletionResult | null>;
  hover(text: string, pos: Position): Promise<HoverResult | null>;
  signature(text: string, pos: Position): Promise<SignatureResult | null>;
  definition(text: string, pos: Position): Promise<DefinitionTarget[] | null>;
  inlayHints?(text: string): Promise<InlayHint[]>;
  /** Diagnostics for `version`, pushed whenever the backend finishes a check. */
  onDiagnostics(listener: (version: number, diagnostics: Diagnostic[]) => void): () => void;
  onStatus(listener: (status: ServiceStatus) => void): () => void;
  /** Characters that open completion as soon as they are typed. */
  readonly triggerCharacters: readonly string[];
  readonly signatureTriggers: readonly string[];
}
