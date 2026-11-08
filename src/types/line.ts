/** Line Launcher public config contract, schema 1. JSON uses snake_case. */
export const LINE_SCHEMA_VERSION = 1 as const;
export const LINE_SUPPORTED_FEATURES = [
  "custom-auth-v1",
  "zip-sha256-v1",
  "launch-manifest-v1",
  "private-ipc-v1",
  "skin-upload-v1",
] as const;
export type LineFeature = (typeof LINE_SUPPORTED_FEATURES)[number];

/**
 * One account per project. The player signs in once and reaches every server
 * this provider lists, so credentials and the wardrobe live here, not on a
 * server.
 */
export interface LineAccountAuth {
  /** POST { username, password }; HTTPS only. */
  login_url: string;
  /** Same request/response contract as login_url. Omit to disable registration. */
  register_url?: string;
}

export interface LineProvider {
  id: string;
  name: string;
  logo_url?: string;
  auth: LineAccountAuth;
  /** Account-wide wardrobe. Absent = skins stay local-only. */
  wardrobe?: LineWardrobeConfig;
}

/** Per-server game-join endpoints; a ticket authorises one specific server. */
export interface LineLaunchAuth {
  /** POST bearer provider session; issues a one-shot launch ticket. */
  launch_ticket_url?: string;
  /** HTTPS endpoint the game mod exchanges the ticket at. */
  session_exchange_url?: string;
}

export interface LineDistribution {
  /** Immutable HTTPS archive URL. Redirects are revalidated by Rust. */
  url: string;
  /** Lowercase, 64-character SHA-256 of the complete ZIP. Required. */
  sha256: string;
  /** Exact compressed size; also used to reject oversized responses early. */
  size_bytes: number;
  /** Exact sum of regular-file sizes after extraction, excluding directories. */
  unpacked_size_bytes: number;
}

/** Skin model. "classic" = 4px arms, "slim" = 3px arms. */
export type SkinModel = "classic" | "slim";

/**
 * Optional wardrobe endpoints. Rust requires both together and HTTPS for each.
 * Providers that rely on it should list `skin-upload-v1` in required_features.
 */
export interface LineWardrobeConfig {
  /** GET with bearer session -> { model, texture_url }; 404 when unset. */
  skin_url: string;
  /** POST raw PNG with bearer + X-Skin-Model; DELETE resets to the default. */
  skin_upload_url: string;
}

/** Current skin as reported by the provider. */
/** One texture kept in the local history. `id` is the SHA-256 of the PNG. */
export interface SkinEntry {
  id: string;
  name: string;
  model: SkinModel;
  width: number;
  height: number;
  sizeBytes: number;
  addedAt: number;
}

export interface SkinLibrary {
  /** Newest first. */
  skins: SkinEntry[];
  /** The active skin for the whole account. null = standard look. */
  active: string | null;
  /** What the provider last accepted; drives the automatic sync. */
  synced: string | null;
}

/** Outcome of the automatic upload. There is no manual send action. */
export interface SkinSyncResult {
  status: "unchanged" | "synced";
  skin: SkinState | null;
}

export interface SkinLibrarySnapshot {
  library: SkinLibrary;
  limit: number;
}

export interface SkinState {
  model: SkinModel;
  textureUrl: string;
}

export interface LineServer {
  /** Stable, lowercase ASCII slug; never accept a filesystem path from JSON. */
  id: string;
  name: string;
  description: string;
  /** Square mark. Rust normalizes the legacy `logo_url` into this field. */
  icon_url?: string;
  /** Wide hero image for the card and the detail header. */
  banner_url?: string;
  /** @deprecated Accepted from providers, normalized to icon_url by Rust. */
  logo_url?: string;
  /** Provider's release identifier. Change it when the distribution changes. */
  version: string;
  minecraft_version?: string;
  auth?: LineLaunchAuth;
  distribution: LineDistribution;
}

export interface LineConfig {
  schema_version: typeof LINE_SCHEMA_VERSION;
  /** Strict SemVer. Checked numerically, including prerelease precedence. */
  min_launcher_version: string;
  provider: LineProvider;
  /** Defaults to 300 s; Rust validates the range 60–86400 s. */
  cache_ttl_seconds?: number;
  /** Additional required capabilities. Unknown features fail closed. */
  required_features?: LineFeature[];
  servers: LineServer[];
}

/** What the launcher window does once the game starts. */
export type AfterLaunch = "keep" | "minimize" | "close";

/**
 * Player settings. Deliberately narrow: there is no free-form JVM argument
 * field, because launch hardening rejects -javaagent and classpath injection.
 * `javaPath` is only a hint — Rust re-checks it against the runtimes it can
 * actually discover and execute.
 */
export interface LauncherSettings {
  /** null = size the heap from physical memory automatically. */
  heapMb: number | null;
  javaPath: string | null;
  sidebarCollapsed: boolean;
  afterLaunch: AfterLaunch;
  windowWidth: number;
  windowHeight: number;
  windowMaximized: boolean;
}

export interface SettingsSnapshot {
  settings: LauncherSettings;
  /** Upper selectable heap on this machine (3/4 of RAM, capped). */
  heapCeilingMb: number;
  suggestedHeapMb: number;
  totalMemoryMb: number;
}

export interface JavaRuntimeInfo {
  path: string;
  major: number;
  version: string;
}

/** Rust IPC DTOs use camelCase (Tauri's default argument conversion). */
export interface ConfigSnapshot {
  config: LineConfig;
  sourceUrl: string;
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
}

export interface AuthSessionInfo {
  username: string;
  /** Unix epoch milliseconds. Never includes the provider access token. */
  expiresAt: number;
}

export type AuthMode = "login" | "register";
export interface AuthCredentials {
  username: string;
  password: string;
}

/** Wire representation of Rust's LineError. Messages never contain credentials. */
export type LineErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_VERSION"
  | "NETWORK"
  | "TLS_UNTRUSTED"
  | "HTTP_STATUS"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_EXISTS"
  | "RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "JAVA_REQUIRED"
  | "INTEGRITY"
  | "UNSAFE_ARCHIVE"
  | "STORAGE"
  | "DISK_SPACE"
  | "BUSY"
  | "CANCELLED"
  | "INTERNAL";

export interface LineError {
  code: LineErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
}

export type InstallPhase =
  | "downloading"
  | "verifying"
  | "extracting"
  | "committing"
  | "completed"
  | "cancelled"
  | "failed";

export interface InstallProgress {
  operationId: string;
  serverId: string;
  phase: InstallPhase;
  /** Monotonic overall progress, 0–100; not a network-speed estimate. */
  percent: number;
  receivedBytes: number;
  totalBytes: number;
  extractedBytes: number;
  unpackedBytes: number;
}

export interface InstallReceipt {
  serverId: string;
  version: string;
  sha256: string;
  installedAt: number;
  alreadyInstalled: boolean;
}

export const LINE_PROGRESS_EVENT = "line://install-progress";
export const LINE_GAME_EVENT = "line://game-status";

export interface LaunchManifest {
  schema_version: 1;
  java_major: number;
  main_class: string;
  classpath: string[];
  minecraft_version: string;
  asset_index?: string;
  assets_dir?: string;
  natives_dir?: string;
  /** log4j2 configuration inside the release. */
  logging_config?: string;
  /** Extra game arguments as `--name value` pairs; never JVM arguments. */
  game_args?: string[];
  /** Account type reported to the client. Defaults to `mojang`. */
  user_type?: "mojang" | "msa" | "legacy";
}

export type GamePhase = "idle" | "starting" | "running" | "exited" | "failed";
export interface GameStatus {
  serverId: string;
  /** Monotonic backend counter; older revisions must never overwrite newer ones. */
  revision: number;
  phase: GamePhase;
  sha256?: string;
  startedAt?: number;
  exitCode?: number;
  /** Non-sensitive lifecycle explanation from Rust. */
  message?: string;
}

export interface ReleaseHistory {
  serverId: string;
  releases: InstallReceipt[];
}

export interface RollbackResult {
  receipt: InstallReceipt;
  removedReleases: string[];
}

/**
 * Tauri events and command replies can arrive out of order. Accept a status only
 * when it is at least as new as the one already shown for the same server.
 */
export function isNewerGameStatus(
  previous: GameStatus | null | undefined,
  next: GameStatus,
): boolean {
  if (!previous || previous.serverId !== next.serverId) return true;
  return next.revision >= previous.revision;
}

export function isLineError(value: unknown): value is LineError {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  const codes: LineErrorCode[] = [
    "INVALID_INPUT",
    "UNSUPPORTED_VERSION",
    "NETWORK",
    "TLS_UNTRUSTED",
    "HTTP_STATUS",
    "INVALID_CREDENTIALS",
    "ACCOUNT_EXISTS",
    "RATE_LIMITED",
    "AUTH_REQUIRED",
    "JAVA_REQUIRED",
    "INTEGRITY",
    "UNSAFE_ARCHIVE",
    "STORAGE",
    "DISK_SPACE",
    "BUSY",
    "CANCELLED",
    "INTERNAL",
  ];
  return (
    codes.includes(error.code as LineErrorCode) &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean" &&
    (error.httpStatus === undefined ||
      (typeof error.httpStatus === "number" &&
        Number.isInteger(error.httpStatus)))
  );
}

export function toLineError(value: unknown): LineError {
  if (isLineError(value)) return value;
  // Do not display/log an unknown exception: it could contain a signed URL or token.
  return {
    code: "INTERNAL",
    message: "Не удалось выполнить операцию. Повторите попытку.",
    retryable: false,
  };
}
