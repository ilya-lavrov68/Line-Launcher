/**
 * The one provider baked into this build by `branding/provider.json`.
 * A provider builds their own launcher; their servers come from the config.
 */
export interface BakedProvider {
  /** HTTPS config.json URL. Empty only in an unconfigured template. */
  configUrl: string;
}
