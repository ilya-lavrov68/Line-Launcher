/**
 * Who owns this build, and where support mail goes.
 *
 * Deliberately a SEPARATE file from `line.brand.json`, and deliberately not part
 * of the brand config schema: a provider re-brands their launcher by editing
 * `line.brand.json` and `provider.json`, and neither of those files can reach
 * this one. `scripts/brand-config.ts` rejects an `owner` key inside the brand
 * config by name, so adding one is a build error rather than a silent
 * redirect of the player's diagnostics to whoever re-branded the build.
 *
 * Changing this file changes where every copy of this launcher sends reports.
 * It is the publisher's address, not the provider's; a provider's own support
 * address belongs in their `config.json` (`provider.support_email`), and the UI
 * shows a separate «Связаться с провайдером» button for it.
 */
export const OWNER = {
  /**
   * The publisher's support address. `null` disables «Отправить в …» while
   * keeping the local TXT export available. Set it and re-run `npm run brand`.
   */
  support_email: null as string | null,
  /** Shown in the mail button and the draft subject. */
  support_name: "Line Launcher",
};
