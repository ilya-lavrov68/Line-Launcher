export declare const MIN_VALID_MS: number;
export declare const CERT_DAYS: number;

export interface CertificateState {
  valid: boolean;
  reason: string | null;
  validTo: string | null;
}

export function inspectCertificate(
  certPath: string,
  host?: string,
): CertificateState;

export interface EnsuredCertificate {
  certPath: string;
  keyPath: string;
  created: boolean;
  reused: boolean;
  validTo: string | null;
  reason: string | null;
}

/** Reuses the pair while it is valid, otherwise reissues it. Throws on failure. */
export function ensureCertificate(
  dir: string,
  host?: string,
): EnsuredCertificate;
