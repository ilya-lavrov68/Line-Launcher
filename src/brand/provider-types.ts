/** One provider baked into the build by `branding/provider.json`. */
export interface BakedProvider {
  id: string;
  name: string;
  configUrl: string;
}

export interface BakedProviders {
  /**
   * When false and the list is non-empty, the manual URL screen is hidden: the
   * player picks a built-in provider (or gets the only one) and signs in.
   */
  allowManualUrl: boolean;
  providers: BakedProvider[];
}
