import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  LINE_GAME_EVENT,
  LINE_MC_GAME_EVENT,
  LINE_MC_INSTALL_EVENT,
  LINE_PROGRESS_EVENT,
  toLineError,
  type AuthCredentials,
  type AuthMode,
  type AuthSessionInfo,
  type ConfigSnapshot,
  type InstallProgress,
  type InstallReceipt,
  type GameStatus,
  type ReleaseHistory,
  type RollbackResult,
  type JavaRuntimeInfo,
  type LauncherSettings,
  type McGameStatus,
  type McInstallProgress,
  type McInstallRequest,
  type McInstalled,
  type McLaunchRequest,
  type McPlayRequest,
  type SettingsSnapshot,
  type SkinModel,
  type SkinState,
  type SkinLibrarySnapshot,
  type SkinSyncResult,
} from "@/types/line";

export class DesktopRequiredError extends Error {
  constructor() {
    super("Откройте Line Launcher в настольном приложении.");
    this.name = "DesktopRequiredError";
  }
}

async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) throw new DesktopRequiredError();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toLineError(error);
  }
}

export const lineApi = {
  cachedConfig: () => call<ConfigSnapshot | null>("get_cached_config"),
  fetchConfig: (url: string, force = false) =>
    call<ConfigSnapshot>("fetch_line_config", { url, force }),
  authenticate: (mode: AuthMode, credentials: AuthCredentials) =>
    call<AuthSessionInfo>(mode === "login" ? "line_login" : "line_register", {
      request: credentials,
    }),
  logout: () => call<void>("line_logout"),
  /** Restores the account after a reload; never returns a token. */
  session: () => call<AuthSessionInfo | null>("line_session"),
  installedBuild: (serverId: string) =>
    call<InstallReceipt | null>("get_installed_build", { serverId }),
  install: (serverId: string, operationId: string) =>
    call<InstallReceipt>("download_and_extract_zip", { serverId, operationId }),
  cancel: (operationId: string) =>
    call<boolean>("cancel_install", { operationId }),
  launch: (serverId: string) => call<GameStatus>("launch_game", { serverId }),
  stopGame: (serverId: string) => call<boolean>("stop_game", { serverId }),
  gameStatus: (serverId: string) =>
    call<GameStatus>("get_game_status", { serverId }),
  history: (serverId: string) =>
    call<ReleaseHistory>("list_release_history", { serverId }),
  rollback: (serverId: string, sha256: string) =>
    call<RollbackResult>("rollback_release", { serverId, sha256 }),
  settings: () => call<SettingsSnapshot>("get_settings"),
  saveSettings: (settings: LauncherSettings) =>
    call<SettingsSnapshot>("save_settings", { settings }),
  javaRuntimes: () => call<JavaRuntimeInfo[]>("list_java_runtimes"),
  probeJavaPath: (path: string) =>
    call<JavaRuntimeInfo>("probe_java_path", { path }),
  clearConfigCache: () => call<boolean>("clear_config_cache"),
  skin: () => call<SkinState | null>("get_skin"),
  skinLibrary: () => call<SkinLibrarySnapshot>("list_skin_library"),
  addSkin: (name: string, model: SkinModel, png: number[]) =>
    call<SkinLibrarySnapshot>("add_skin_to_library", { name, model, png }),
  renameSkin: (id: string, name: string) =>
    call<SkinLibrarySnapshot>("rename_skin", { id, name }),
  deleteSkin: (id: string) =>
    call<SkinLibrarySnapshot>("delete_skin_from_library", { id }),
  skinTexture: (id: string) => call<number[]>("read_skin_texture", { id }),
  setActiveSkin: (id: string | null) =>
    call<SkinLibrarySnapshot>("set_active_skin", { id }),
  /** Automatic and idempotent: pushes the active skin, or resets when none. */
  syncActiveSkin: () => call<SkinSyncResult>("sync_active_skin"),
  /** Drops the "already uploaded" marker after an account change. */
  forgetSyncedSkin: () => call<SkinLibrarySnapshot>("forget_synced_skin"),
  // ------------------------------------------------------------- Minecraft
  /** Installs a vanilla or loader profile from the official endpoints. */
  mcInstall: (request: McInstallRequest) =>
    call<McInstalled>("mc_install", { request }),
  mcListInstalled: (instanceId: string) =>
    call<string[]>("mc_list_installed", { instanceId }),
  /** Offline identity: provider nickname + the launcher's stable UUID. */
  mcLaunch: (request: McLaunchRequest) =>
    call<McGameStatus>("mc_launch", { request }),
  /** One button: verify-or-download the profile, then auto-join the server. */
  mcPlay: (request: McPlayRequest) =>
    call<McGameStatus>("mc_play", { request }),
  mcStop: (instanceId: string) => call<boolean>("mc_stop", { instanceId }),
  mcStatus: (instanceId: string) =>
    call<McGameStatus>("mc_status", { instanceId }),
  onMcGame: async (
    instanceId: string,
    callback: (status: McGameStatus) => void,
  ): Promise<UnlistenFn> => {
    if (!isTauri()) throw new DesktopRequiredError();
    return listen<McGameStatus>(LINE_MC_GAME_EVENT, (event) => {
      if (event.payload.instanceId === instanceId) callback(event.payload);
    });
  },
  onMcProgress: async (
    instanceId: string,
    callback: (progress: McInstallProgress) => void,
  ): Promise<UnlistenFn> => {
    if (!isTauri()) throw new DesktopRequiredError();
    return listen<McInstallProgress>(LINE_MC_INSTALL_EVENT, (event) => {
      if (event.payload.instanceId === instanceId) callback(event.payload);
    });
  },
  onGame: async (
    serverId: string,
    callback: (status: GameStatus) => void,
  ): Promise<UnlistenFn> => {
    if (!isTauri()) throw new DesktopRequiredError();
    return listen<GameStatus>(LINE_GAME_EVENT, (event) => {
      if (event.payload.serverId === serverId) callback(event.payload);
    });
  },
  onProgress: async (
    operationId: string,
    callback: (progress: InstallProgress) => void,
  ): Promise<UnlistenFn> => {
    if (!isTauri()) throw new DesktopRequiredError();
    return listen<InstallProgress>(LINE_PROGRESS_EVENT, (event) => {
      if (event.payload.operationId === operationId) callback(event.payload);
    });
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof DesktopRequiredError) return error.message;
  return toLineError(error).message;
}
