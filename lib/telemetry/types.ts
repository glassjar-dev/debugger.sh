import type { DockState } from "@/components/dock/types";

export type Language = "c" | "python" | "rust";

export type Pane = "editor" | "variables" | "output" | "tests";

export type TestExpression = {
  /** The expression whose value is `value` */
  expression: string;
  /** The value of expression */
  value: string;
};

export type TestCase = {
  name: string;
  passed: boolean;
  expected?: TestExpression;
  actual?: TestExpression;
  /** Line reported by the test case, if any */
  line?: number;
  /** Failure message provided by the library */
  message?: string;
};

export type DebugVariable = {
  id: string;
  name: string;
  type: string;
  value: string;
};

export type DebugFrame = {
  /** 0-based index of this frame. 0 is the top-most (most recent) frame. */
  index: number;
  /** The name of this frame (e.g. the function name) */
  name: string;
  /** List of args in this frame (undefined if empty) */
  args?: DebugVariable[];
  /** List of locals in this frame (undefined if empty) */
  locals?: DebugVariable[];
};

export type TelemetryDetails = {
  /** The page is usable: a share has finished loading, or a blank IDE is ready. */
  session: {
    /** Persistent anonymous id for user identification, stored in local storage. */
    stable_id: string;
    /** Set when the page was opened from a share */
    share_id?: string;
    /** Language selected when the session became ready. */
    language: Language;
    /** Contents of the file at the start of the session */
    code?: string;
    /** Layout at the start of the session */
    layout: DockState;
    /** CSS viewport information  */
    viewport: {
      width: number;
      height: number;
      pointer: "coarse" | "fine" | "none";
    };
    /** Browser's user agent string */
    user_agent: string;
    /** Minutes east of UTC. */
    timezone_offset_min: number;
  };

  /**
   * These edits form a perfect log of all textual changes to the document, such that
   * replaying the log losslessly captures all changes to the document.
   *
   * With that said, to save on egress, two edits may be merged together if:
   *
   *  1. They occur within 500ms of one another.
   *  2. It is possible to represent them as a single edit (i.e. they are textually adjacent)
   *  3. They share the same reason.
   *
   * For example, consider two edits A happens before B that satisfy (1) and (3), where
   *
   * ```
   * A = { offset: 0, deleted: 2, inserted: "hel" }
   * B = { offset: 3, deleted: 0, inserted: "lo" }
   * ```
   *
   * it is possible to merge these edits into a single edit
   *
   * ```
   * A|B = { offset: 0, deleted: 2, inserted: "hello" }
   * ```
   *
   * However, edits like
   *
   * ```
   * A' = { offset: 0, deleted: 2, inserted: "hel" }
   * B' = { offset: 4, deleted: 0, inserted: "o" }
   * ```
   *
   * cannot be merged since they are not adjacent.
   *
   * Put simply, these rules state that it is possible to debounce edits, so long as they are
   * temporally and textually adjacent and have the same reason.
   *
   * If multiple simultaneous edits occur, their timestamp should be artificially incremented by the smallest supported resolution
   * on the client to spread them out into a total order.
   */
  edit: {
    /** The start position in the document before the edit */
    offset: number;
    /** Count of deleted characters. `undefined` means 0 (an insertion) */
    deleted?: number;
    /** The characters that were inserted. `undefined` means "" (a deletion) */
    inserted?: string;
    /** Whether or not this edit was the result of:
     *
     * - paste: 		Pasting into the document (e.g. with Ctrl+V)
     * - undo:			Undoing a change (e.g. with Ctrl+Z)
     * - redo:			Redoing a change (e.g. with Ctrl+Shift+Z)
     * - language:	Changing the document language (i.e. from C++ to Python)
     * - undefined:	A normal keyboard edit to the document
     */
    reason?: "paste" | "undo" | "redo" | "language";
    /** If the language changes, which language did it change to? */
    language?: Language;
  };

  /** A run of the code began */
  run_start: null;

  /**
   * A run emitted output (either stdout or stderr) or received input (stdin).
   */
  run_io: {
    /**
     * What kind of IO was this?
     * stdin is line buffered.
     * stdout/stderr is debounced and aggregated over a 500ms window.
     */
    kind: "stdin" | "stdout" | "stderr";
    /** The raw input or output. */
    data: string;
  };

  /** A run of the code stopped */
  run_stop: {
    /**
     * - stopped: 	User stopped an ongoing run
     * - error:				An unexpected error occurred during running.
     * - completed:		The run ran to completion
     */
    reason: "completed" | "error" | "stopped";
    /** Process exit code. `undefined` for error and stopped. */
    exit_code?: number;
    /** Toolchain build time, when available */
    build_ms?: number;
    /** Process time, when available */
    run_ms?: number;
    /** Test case information after running, if available */
    tests?: TestCase[];
  };

  /** A breakpoint was added or removed */
  debug_breakpoint: {
    /** 1-based line. */
    line: number;
    /** Whether the breakpoint was added or removed */
    added: boolean;
  };

  /** The debugger paused. */
  debug_stop: {
    /** Why execution stopped. */
    reason: "breakpoint" | "step" | "exception" | "pause";
    /** 1-based line of the top frame in the user's file. `undefined` if the stop is outside that file. */
    line?: number;
    /** Number of visible stack frames shown to the user */
    frame_count: number;
    top_frame?: DebugFrame;
  };

  /** We continued or stepped in the debugger */
  debug_step: {
    kind: "continue" | "over" | "in" | "out";
  };

  /** A stack frame was selected in the variables panel. */
  debug_frame: {
    frame: DebugFrame;
  };

  /** A variable row was expanded or collapsed. */
  debug_variable: {
    /** The ID of the variable that was expanded or collapsed */
    id: string;
    /** Whether the variable was expanded (true) or collapsed (false) */
    expanded: boolean;
    /**
     * The revealed children of this variable if expanded.
     * Undefined if collapsed.
     */
    children?: DebugVariable[];
  };

  /**
   * A new share ID was successfully created
   */
  share: {
    share_id: string;
  };

  /** The dock settled after a change. One event at the end of a drag, not per pixel. */
  layout_changed: {
    layout: DockState;
  };

  /** An unexpected error occurred in the page (an uncaught exception) */
  error: {
    /** The error class type */
    type: string;
    /** The reason for the error (i.e. the error serialized to a string) */
    reason: string;
  };

  /**
   * Stands in for an event that was too large to store. Keeps the original event's
   * session and timestamp, so the gap shows up in the timeline.
   */
  telemetry_dropped: {
    reason: 'too_large';
    /** Name of the event that was dropped */
    event: string;
    /** Size of the dropped event as one JSON line, in UTF-8 bytes */
    bytes: number;
  };
};

export type TelemetryEvent = keyof TelemetryDetails;

/**
 * Write only log. RLS allows inserting, but not updates/deletions/reading.
 */
export type TelemetryRecord<E extends TelemetryEvent = TelemetryEvent> = {
  /** Autoincrementing event id. Column type: bigint. */
  id: number;
  /** Unique ID of this session, one per page load */
  session_id: string;
  /** UTC time the event occurred, stamped by the client. Column type: timestamptz. */
  timestamp: string;
  event: E;
  /** Column type: jsonb. null if the event has no additional data associated with it. */
  details: TelemetryDetails[E];
};
