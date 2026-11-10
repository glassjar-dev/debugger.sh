'use client';

/**
 * Main-thread adapters that give every language the same `LanguageService`.
 * Workers start lazily, the first time the editor shows that language, and
 * then live for the rest of the page.
 */

import type { Lang } from '@/components/constants';
import type { FromWorker } from './worker/host';
import type {
  CompletionItem,
  CompletionKind,
  CompletionResult,
  DefinitionTarget,
  Diagnostic,
  HoverResult,
  InlayHint,
  LanguageService,
  Position,
  Range,
  ServiceStatus,
  Severity,
  SignatureResult,
} from './types';

type Listener<T extends unknown[]> = (...args: T) => void;

class Emitter<T extends unknown[]> {
  private listeners = new Set<Listener<T>>();
  last: T | null = null;
  /** `replay`: new listeners get the last value right away (status, not diagnostics). */
  constructor(private readonly replay = true) {}
  on(listener: Listener<T>) {
    this.listeners.add(listener);
    if (this.replay && this.last) listener(...this.last);
    return () => void this.listeners.delete(listener);
  }
  emit(...args: T) {
    this.last = args;
    for (const l of this.listeners) l(...args);
  }
}

// ---------------------------------------------------------------------------
// C++ and Rust: our own workers (see lib/intellisense/worker/host.ts)
// ---------------------------------------------------------------------------

class WorkerService implements LanguageService {
  private worker: Worker;
  private nextId = 1;
  private calls = new Map<number, (value: unknown) => void>();
  private diagnostics = new Emitter<[number, Diagnostic[]]>(false);
  private status = new Emitter<[ServiceStatus]>();

  constructor(
    create: () => Worker,
    readonly triggerCharacters: readonly string[],
    readonly signatureTriggers: readonly string[],
    private readonly hasInlayHints: boolean,
  ) {
    this.status.emit({ state: 'loading', detail: 'Starting' });
    this.worker = create();
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if ('type' in msg) {
        if (msg.type === 'diagnostics') this.diagnostics.emit(msg.version, msg.diagnostics);
        else this.status.emit(msg.status);
        return;
      }
      const resolve = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.error) console.warn('[intellisense]', msg.error);
      resolve?.(msg.error ? null : msg.result ?? null);
    };
    this.worker.onerror = (event) => this.status.emit({ state: 'error', detail: event.message || 'worker failed' });
  }

  private call<T>(method: string, params: unknown): Promise<T | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.calls.set(id, resolve as (value: unknown) => void);
      this.worker.postMessage({ id, method, params });
    });
  }

  update(text: string, version: number) {
    this.worker.postMessage({ type: 'update', text, version });
  }
  complete(text: string, pos: Position) {
    return this.call<CompletionResult>('complete', { text, pos });
  }
  hover(text: string, pos: Position) {
    return this.call<HoverResult>('hover', { text, pos });
  }
  signature(text: string, pos: Position) {
    return this.call<SignatureResult>('signature', { text, pos });
  }
  definition(text: string, pos: Position) {
    return this.call<DefinitionTarget[]>('definition', { text, pos });
  }
  async inlayHints(text: string) {
    if (!this.hasInlayHints) return [];
    return (await this.call<InlayHint[]>('inlayHints', { text })) ?? [];
  }
  onDiagnostics(listener: (version: number, diagnostics: Diagnostic[]) => void) {
    return this.diagnostics.on(listener);
  }
  onStatus(listener: (status: ServiceStatus) => void) {
    return this.status.on(listener);
  }
}

// ---------------------------------------------------------------------------
// Python: basedpyright's browser build, spoken to over LSP
// ---------------------------------------------------------------------------

const PYRIGHT_URL = '/intellisense/pyright.worker.js';
const ROOT = '/src/';
const DOC_URI = `file://${ROOT}main.py`;

type Rpc = { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };

/** LSP CompletionItemKind -> ours (1-based enum). */
const LSP_KIND: CompletionKind[] = [
  'text', 'text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module',
  'property', 'type', 'constant', 'enum', 'keyword', 'snippet', 'text', 'text', 'text', 'member', 'constant',
  'struct', 'text', 'text', 'type',
];

type LspMarkup = string | { kind?: string; value: string } | Array<string | { language: string; value: string }>;

function markupText(m: LspMarkup | undefined): string | undefined {
  if (!m) return undefined;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((p) => (typeof p === 'string' ? p : '```' + p.language + '\n' + p.value + '\n```')).join('\n\n');
  return m.value;
}

class PyrightService implements LanguageService {
  readonly triggerCharacters = ['.'];
  readonly signatureTriggers = ['(', ','];
  private workers: Worker[] = [];
  private foreground: Worker;
  private nextId = 1;
  private calls = new Map<number, (value: unknown) => void>();
  private diagnostics = new Emitter<[number, Diagnostic[]]>(false);
  private status = new Emitter<[ServiceStatus]>();
  private ready: Promise<void>;
  private text = '';
  private version = 0;
  /** LSP version -> our editor version, for matching published diagnostics. */
  private versions = new Map<number, number>();

  constructor() {
    this.status.emit({ state: 'loading', detail: 'Loading basedpyright' });
    const started = performance.now();
    this.foreground = new Worker(PYRIGHT_URL, { name: 'basedpyright' });
    this.workers.push(this.foreground);
    this.foreground.postMessage({ type: 'browser/boot', mode: 'foreground' });
    let count = 0;
    this.foreground.addEventListener('message', (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'browser/newWorker') {
        // Background analysis runs in a second worker; we only relay its port.
        const background = new Worker(PYRIGHT_URL, { name: `basedpyright-${++count}` });
        this.workers.push(background);
        background.postMessage({ type: 'browser/boot', mode: 'background', initialData: data.initialData, port: data.port }, [data.port]);
        return;
      }
      if (data?.jsonrpc) this.receive(data as Rpc);
    });
    this.foreground.onerror = (event) => this.status.emit({ state: 'error', detail: event.message || 'basedpyright failed' });
    this.ready = this.initialize().then(
      () => this.status.emit({ state: 'ready', detail: `basedpyright ready in ${Math.round(performance.now() - started)} ms` }),
      (error) => this.status.emit({ state: 'error', detail: String(error) }),
    );
  }

  private send(msg: Omit<Rpc, 'jsonrpc'>) {
    this.foreground.postMessage({ jsonrpc: '2.0', ...msg });
  }

  private request<T>(method: string, params: unknown): Promise<T | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.calls.set(id, resolve as (value: unknown) => void);
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  private receive(msg: Rpc) {
    if (msg.id != null && msg.method) {
      // Server -> client request (configuration, registerCapability, ...).
      const result = msg.method === 'workspace/configuration'
        ? ((msg.params as { items?: unknown[] })?.items ?? []).map(() => ({}))
        : null;
      this.foreground.postMessage({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.id != null) {
      const resolve = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      resolve?.(msg.error ? null : msg.result ?? null);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const params = msg.params as { uri: string; version?: number; diagnostics: LspDiagnostic[] };
      if (params.uri !== DOC_URI) return;
      const version = this.versions.get(params.version ?? this.version) ?? -1;
      this.diagnostics.emit(version, params.diagnostics.map(toDiagnostic));
    }
  }

  private async initialize() {
    await this.request('initialize', {
      processId: 1,
      rootUri: `file://${ROOT}`,
      rootPath: ROOT,
      capabilities: {
        textDocument: {
          publishDiagnostics: { tagSupport: { valueSet: [1, 2] }, versionSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: {
            completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], labelDetailsSupport: true },
          },
          signatureHelp: {
            signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
          },
          definition: {},
        },
      },
      initializationOptions: {
        files: {
          [`${ROOT}main.py`]: this.text,
          // The engine runs CPython 3.11. "standard" catches real type errors
          // without basedpyright's stricter "recommended" noise.
          [`${ROOT}pyrightconfig.json`]: JSON.stringify({ pythonVersion: '3.11', typeCheckingMode: 'standard' }),
        },
      },
    });
    this.notify('initialized', {});
    this.notify('workspace/didChangeConfiguration', { settings: {} });
    this.notify('textDocument/didOpen', {
      textDocument: { uri: DOC_URI, languageId: 'python', version: ++this.version, text: this.text },
    });
  }

  /** Brings the server's copy of the document up to `text`. */
  private async sync(text: string) {
    await this.ready;
    if (text === this.text) return;
    this.text = text;
    this.notify('textDocument/didChange', {
      textDocument: { uri: DOC_URI, version: ++this.version },
      contentChanges: [{ text }],
    });
  }

  update(text: string, version: number) {
    void this.ready.then(() => {
      if (text === this.text) return;
      this.text = text;
      this.versions.set(++this.version, version);
      this.notify('textDocument/didChange', {
        textDocument: { uri: DOC_URI, version: this.version },
        contentChanges: [{ text }],
      });
    });
  }

  async complete(text: string, pos: Position): Promise<CompletionResult | null> {
    await this.sync(text);
    const result = await this.request<{ items: LspCompletion[] } | LspCompletion[]>('textDocument/completion', {
      textDocument: { uri: DOC_URI },
      position: pos,
    });
    const raw = Array.isArray(result) ? result : result?.items;
    if (!raw?.length) return null;
    // LSP doesn't promise an order; sortText carries basedpyright's ranking.
    const items = [...raw].sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
    const line = text.split('\n')[pos.line] ?? '';
    let start = pos.character;
    while (start > 0 && /\w/.test(line[start - 1])) start--;
    const from = items[0].textEdit && 'range' in items[0].textEdit ? items[0].textEdit.range.start : { line: pos.line, character: start };
    return {
      from,
      items: items.map((item, index): CompletionItem => {
        const insert = item.textEdit?.newText ?? item.insertText ?? item.label;
        const snippet = item.insertTextFormat === 2;
        return {
          label: item.label,
          kind: LSP_KIND[item.kind ?? 1] ?? 'text',
          detail: item.labelDetails?.description ?? item.detail,
          documentation: markupText(item.documentation),
          insert: snippet ? insert.replace(/\$(\d+)/g, '${$1}').replace(/\$\{0\}/g, '${100}') : insert,
          snippet,
          // Rank by basedpyright's order; dunders sink unless asked for.
          boost: Math.round(12 - (index / items.length) * 24) - (/^__\w+__$/.test(item.label) ? 12 : 0),
          deprecated: item.tags?.includes(1),
          resolve: async () => {
            const resolved = await this.request<LspCompletion>('completionItem/resolve', item);
            if (!resolved) return null;
            const doc = markupText(resolved.documentation);
            // basedpyright puts the signature in a ```python block at the top of the docs.
            const m = doc?.match(/^```python\n([\s\S]*?)\n```\s*(?:---\s*)?([\s\S]*)$/);
            return {
              signature: m?.[1] ?? resolved.detail,
              documentation: m ? m[2].trim() || undefined : doc,
              detail: resolved.labelDetails?.description ?? resolved.detail ?? item.detail,
            };
          },
        };
      }),
    };
  }

  async hover(text: string, pos: Position): Promise<HoverResult | null> {
    await this.sync(text);
    const h = await this.request<{ contents: LspMarkup; range?: Range }>('textDocument/hover', {
      textDocument: { uri: DOC_URI },
      position: pos,
    });
    const md = markupText(h?.contents);
    if (!md) return null;
    const m = md.match(/^```python\n([\s\S]*?)\n```\s*(?:---\s*)?([\s\S]*)$/);
    const code = m?.[1];
    // "(variable) x: int" -> kind "variable", code "x: int"
    const kindMatch = code?.match(/^\((\w[\w ]*)\)\s+/);
    return {
      kind: kindMatch?.[1],
      code: kindMatch ? code!.slice(kindMatch[0].length) : code,
      markdown: (m ? m[2] : md).trim() || undefined,
      range: h?.range,
    };
  }

  async signature(text: string, pos: Position): Promise<SignatureResult | null> {
    await this.sync(text);
    const s = await this.request<LspSignatureHelp>('textDocument/signatureHelp', {
      textDocument: { uri: DOC_URI },
      position: pos,
    });
    if (!s?.signatures?.length) return null;
    const active = s.activeSignature ?? 0;
    return {
      signatures: s.signatures.map((sig) => ({
        label: sig.label,
        documentation: markupText(sig.documentation),
        parameters: (sig.parameters ?? []).map((p): [number, number] => {
          if (Array.isArray(p.label)) return p.label;
          const at = sig.label.indexOf(p.label);
          return [at, at + p.label.length];
        }),
      })),
      active,
      activeParameter: s.signatures[active]?.activeParameter ?? s.activeParameter ?? null,
    };
  }

  async definition(text: string, pos: Position): Promise<DefinitionTarget[] | null> {
    await this.sync(text);
    const r = await this.request<Array<{ uri?: string; targetUri?: string; range?: Range; targetSelectionRange?: Range }>>(
      'textDocument/definition',
      { textDocument: { uri: DOC_URI }, position: pos },
    );
    if (!r?.length) return null;
    const out: DefinitionTarget[] = [];
    for (const loc of r) {
      const uri = loc.targetUri ?? loc.uri;
      const range = loc.targetSelectionRange ?? loc.range;
      if (!uri || !range) continue;
      if (uri === DOC_URI) out.push({ kind: 'local', range });
      else {
        // Stub files live in the worker; show where the definition is.
        const path = decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/^.*typeshed-fallback\//, '');
        out.push({ kind: 'external', path, line: 0, firstLine: range.start.line + 1, snippet: '' });
      }
    }
    return out.length ? out : null;
  }

  onDiagnostics(listener: (version: number, diagnostics: Diagnostic[]) => void) {
    return this.diagnostics.on(listener);
  }
  onStatus(listener: (status: ServiceStatus) => void) {
    return this.status.on(listener);
  }
}

type LspCompletion = {
  label: string;
  kind?: number;
  detail?: string;
  labelDetails?: { detail?: string; description?: string };
  documentation?: LspMarkup;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { range: Range; newText: string };
  tags?: number[];
  sortText?: string;
};

type LspSignatureHelp = {
  signatures: Array<{
    label: string;
    documentation?: LspMarkup;
    parameters?: Array<{ label: string | [number, number] }>;
    activeParameter?: number;
  }>;
  activeSignature?: number;
  activeParameter?: number;
};

type LspDiagnostic = {
  range: Range;
  severity?: number;
  message: string;
  code?: string | number;
  tags?: number[];
};

const SEVERITY: Severity[] = ['error', 'error', 'warning', 'info', 'hint'];

function toDiagnostic(d: LspDiagnostic): Diagnostic {
  return {
    range: d.range,
    severity: SEVERITY[d.severity ?? 1] ?? 'error',
    message: d.message,
    code: d.code != null ? String(d.code) : undefined,
    source: 'basedpyright',
    unnecessary: d.tags?.includes(1) || undefined,
  };
}

// ---------------------------------------------------------------------------

const services: Partial<Record<Lang, LanguageService>> = {};

export function getLanguageService(lang: Lang): LanguageService {
  let service = services[lang];
  if (service) return service;
  if (lang === 'c') {
    service = new WorkerService(
      () => new Worker(new URL('./worker/cpp.worker.ts', import.meta.url), { type: 'module', name: 'clang-intellisense' }),
      ['.', '>', ':'],
      ['(', ','],
      false,
    );
  } else if (lang === 'rust') {
    service = new WorkerService(
      () => new Worker(new URL('./worker/rust.worker.ts', import.meta.url), { type: 'module', name: 'rust-intellisense' }),
      ['.', ':'],
      ['(', ','],
      true,
    );
  } else {
    service = new PyrightService();
  }
  services[lang] = service;
  return service;
}
