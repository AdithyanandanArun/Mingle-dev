export const ACTION_TIMEOUT_MS = 10_000;
export const CONNECT_TIMEOUT_MS = 15_000;
export const LAUNCH_TIMEOUT_MS = 30_000;
export const DETACH_TIMEOUT_MS = 5_000;

export const MAX_TABS_PER_SESSION = 8;
export const MAX_TABS_GLOBAL = 32;
export const MAX_NOTICES = 10;

export const MAX_TEXT_CHARS = 20_000;
export const MAX_EVAL_CHARS = 64 * 1024;
export const MAX_SCREENSHOT_WIDTH = 1280;
export const MAX_DIALOG_MESSAGE = 2_000;

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export const STREAM_PATH = '/ws/browser';
export const STREAM_MAX_PAYLOAD = 32 * 1024;
export const STREAM_MAX_CONNECTIONS = 16;
export const STREAM_MAX_VIEWERS_PER_TAB = 2;
export const STREAM_MAX_BUFFERED = 2 * 1024 * 1024;
export const STREAM_ACK_TIMEOUT_MS = 3_000;
export const STREAM_SETTINGS = { jpegQuality: 90, maxWidth: 1920, maxHeight: 1200, minFrameIntervalMs: 1000 / 30 } as const;
export const STREAM_MAX_PENDING_INPUTS = 100;
export const STREAM_MAX_PENDING_MOVES = 16;

/** Mingle session and tab ids end up in profile paths and URLs, so keep them to a conservative alphabet. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/** evaluate: the whole expression (including awaiting a returned promise) gets this long; a synchronous run is cut off by V8 after the exec limit. */
export const EVAL_DEADLINE_MS = 7_000;
export const EVAL_EXEC_TIMEOUT_MS = 5_000;
export const EVAL_PROBE_MS = 1_000;
export const EVAL_TERMINATE_WAIT_MS = 1_500;
