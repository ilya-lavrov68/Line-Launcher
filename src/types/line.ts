import type { ServerLayout } from "@/lib/line/server-layout";

/** Line Launcher public config contract, schema 1. JSON uses snake_case. */
export const LINE_SCHEMA_VERSION = 1 as const;
export const LINE_SUPPORTED_FEATURES = [
  "custom-auth-v1",
  "zip-sha256-v1",
  "launch-manifest-v1",
  "private-ipc-v1",
  "offline-launch-v1",
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
  /**
   * Where this project's players write for support. Absent = the provider runs
   * no desk, and «Связаться с провайдером» is not offered.
   */
  support_email?: string;
}

/** Per-server game-join endpoints; a ticket authorises one specific server. */
export interface LineLaunchAuth {
  /** POST bearer provider session; issues a one-shot launch ticket. */
  launch_ticket_url?: string;
  /** HTTPS endpoint the game mod exchanges the ticket at. */
  session_exchange_url?: string;
}

export interface LineDistribution {
  /**
   * HTTPS URL of the archive. Publishing a new build means putting a new ZIP
   * here — the launcher measures what it downloads, so this is the only field
   * a provider has to fill in.
   */
  url: string;
  /**
   * Optional pin. When present the archive must hash to exactly this; when
   * absent the digest computed during download becomes the build's identity.
   */
  sha256?: string;
  /** Optional pin: exact compressed size, checked as the stream arrives. */
  size_bytes?: number;
  /** Optional pin: exact sum of file sizes after extraction. */
  unpacked_size_bytes?: number;
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

export type LaunchMode = "ticket" | "offline" | "minecraft";

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
  /** Missing/default ticket endpoints keep launch disabled. Offline is explicit. */
  launch_mode?: LaunchMode;
  /** Host or host:port the client joins right after launch (Minecraft mode). */
  server_address?: string;
  /** When false, the provider disables the test-world button. Defaults to true. */
  test_mode_enabled?: boolean;
  /** `pack.json` beside the instance ZIP; it decides whether the pack changed. */
  pack_manifest_url?: string;
  /** Optional resource-pack checking; the defaults are on. */
  anticheat?: LineAnticheat;
  /** Where the build comes from; absent = the archive in `distribution`. */
  source?: LineSource;
  auth?: LineLaunchAuth;
  distribution: LineDistribution;
}

/**
 * Where a server's build comes from. Absent = `distribution`, which is what
 * every config written before 0.15 means.
 *
 * The launcher installs all three into the same kind of release, so nothing
 * downstream — launch, repair, rollback, the pack check — sees a difference.
 */
export interface LineSource {
  kind: "packwiz" | "modrinth";
  /** `packwiz`: raw `pack.toml` (github.com/.../raw/..., raw.githubusercontent.com). */
  pack_toml_url?: string;
  /** `modrinth`: project slug or id. */
  project?: string;
  /** `modrinth`: exact version id or number; absent = newest release. */
  version?: string;
}

/** Provider-side resource-pack checking. Absent = the defaults. */
export interface LineAnticheat {
  /** Keyword scan on resource packs; mod composition is checked separately. */
  scan_resourcepacks?: boolean;
  /** Unioned with the built-in list; cannot remove a built-in word. */
  extra_keywords?: string[];
  /** sha256 of packs the provider vouches for, even if a keyword matches. */
  allow?: string[];
}

/** What «Проверить сборку» found. Empty lists = clean. */
export interface PackCheckResult {
  findings: string[];
  foreign: string[];
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

/**
 * What the launcher window does once the game starts.
 *
 * `tray` hides the window and keeps the process alive in the notification
 * area: minimizing leaves it in the taskbar, which on a full-screen game is
 * the difference between "out of the way" and "still there".
 */
export type AfterLaunch = "keep" | "minimize" | "close" | "tray";

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
  /** Backdrop theme id; unknown or absent means the default gradient. */
  backdrop?: string | null;
  /**
   * Interface language code (`ru`, `en`, `de`, `fr`). Unknown or absent means
   * the UI follows the system language, then Russian.
   */
  language?: string | null;
  /** Pack-download rate in KiB/s; 0 or absent means unlimited. */
  downloadLimitKib?: number;
  windowWidth: number;
  windowHeight: number;
  windowMaximized: boolean;
  /**
   * How the player grouped the catalogue. Player-owned: the provider does not
   * know about sections, because renaming a folder it did not create would be
   * reordering someone else's list. Absent = one flat list, as before 0.13.
   */
  serverLayout?: ServerLayout | null;
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
  | "CONFIRMATION_REQUIRED"
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
  zipRepair?: ZipRepairPlan;
  javaDownload?: JavaDownloadPlan;
}

export interface JavaDownloadPlan {
  schema: number;
  serverId: string;
  instanceId: string;
  releaseSha256: string;
  major: number;
  purpose: "loader" | "launch";
  source: "adoptium" | "mojang";
  prepareOnly: boolean;
  testMode: boolean;
}

export interface ZipRepairPlan {
  schema: number;
  serverId: string;
  instanceId: string;
  releaseSha256: string;
  minecraftVersion: string;
  profileId: string;
  detectedLoader: string | null;
  requestedLoader: string | null;
  generatedProfile: boolean;
  installLoader: boolean;
  missingFromArchive: string[];
  liveAssetIssues: number;
  liveAssetBytes: number;
  liveRuntimeIssues: number;
  liveRuntimeFiles: string[];
  liveRuntimeBytes: number;
  liveRuntimeSkipped: number;
  prepareOnly: boolean;
  testMode: boolean;
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

export type GamePhase =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "failed"
  /** Refused on purpose: the integrity or resource-pack check said no. */
  | "blocked";
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
    "CONFIRMATION_REQUIRED",
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

/**
 * Any thrown value → a `LineError`.
 *
 * The fallback message is not a literal here: this module is imported by tests
 * and by code that never renders, and a frozen Russian string would be the one
 * sentence on a German screen that stayed Russian. `fallback` lets a caller
 * that already has a translator pass the sentence in; without one the
 * catalogue is read at call time.
 */
export function toLineError(value: unknown, fallback?: string): LineError {
  if (isLineError(value)) return value;
  // Do not display/log an unknown exception: it could contain a signed URL or token.
  return {
    code: "INTERNAL",
    message: fallback ?? "Не удалось выполнить операцию. Повторите попытку.",
    retryable: false,
  };
}

/**
 * Minecraft profiles installed through `mc-launcher-core` (official Mojang and
 * loader endpoints). Additive to the provider ZIP pipeline: these instances
 * live under `<app-data>/minecraft/<instanceId>/` and never touch provider
 * releases. The account is offline: `online-mode=true` servers reject it.
 */
export const LINE_MC_INSTALL_EVENT = "line://mc-install-progress";
export const LINE_MC_GAME_EVENT = "line://mc-game-status";

export type McLoaderKind = "fabric" | "quilt" | "forge" | "neoforge";

export interface McLoaderRequest {
  kind: McLoaderKind;
  /** Omitted or empty = latest stable version of that loader. */
  version?: string;
}

export interface McInstallRequest {
  instanceId: string;
  minecraftVersion: string;
  loader?: McLoaderRequest;
}

export interface McInstalled {
  instanceId: string;
  /** With a loader this differs from the requested Minecraft version. */
  versionId: string;
}

export interface McLaunchRequest {
  instanceId: string;
  versionId: string;
  /** The client joins immediately; the launcher never leaves it in the menu. */
  serverAddress: string;
}

/**
 * «Играть»: read `pack.json`, download the instance ZIP or confirm the installed
 * copy is current, fill any gaps from the official hosts, then join the server.
 * Everything except `serverId` defaults to what the provider published.
 */
export interface McPlayRequest {
  serverId: string;
  instanceId?: string;
  minecraftVersion?: string;
  loader?: McLoaderRequest;
  serverAddress?: string;
  testMode?: boolean;
  prepareOnly?: boolean;
  approveZipRepair?: ZipRepairPlan;
  approveJavaDownload?: JavaDownloadPlan;
}

/** `pack.json`: a ZIP of a whole `.minecraft`, described for the launcher. */
export interface LinePackManifest {
  schema_version: number;
  url: string;
  sha256: string;
  size_bytes: number;
  unpacked_size_bytes: number;
  revision?: string;
  minecraft_version?: string;
}

export interface McInstallProgress {
  instanceId: string;
  stage: string;
  label: string;
  receivedBytes: number;
  totalBytes?: number;
  filesDone?: number;
  filesTotal?: number;
  finished: boolean;
}

export interface McGameStatus {
  instanceId: string;
  versionId: string;
  phase: GamePhase;
  startedAt?: number;
  exitCode?: number;
  message?: string;
}
