/**
 * Runtime shape of the generated publisher constants.
 *
 * Mirrors `BrandOwner` in `branding/owner.ts`, which the generator reads. The
 * app never imports from `branding/` directly — that folder is build input, and
 * `src/brand/generated.*` is the only thing that reaches the bundle.
 */
export interface BrandOwner {
  /** Publisher support address, or null when this build has no support desk. */
  support_email: string | null;
  /** Display name used in the mail button. */
  support_name: string;
}
