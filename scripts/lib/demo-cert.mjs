// The demo provider's self-signed certificate, kept usable across runs.
//
// `.provider/` is gitignored and survives between demos. The certificate is
// issued for 30 days, so a demo that worked last month would otherwise reuse an
// expired file and fail with a TLS error that looks like a launcher bug. This
// module checks expiry, clock skew and the subject alternative names before the
// file is reused, and reissues it when any of them is wrong.
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findOpenSsl, openSslHelp } from "./find-openssl.mjs";

/** Reissue rather than hand out a certificate that dies during a demo. */
export const MIN_VALID_MS = 24 * 60 * 60 * 1000;
export const CERT_DAYS = 30;

/**
 * Is this PEM file still usable for `host`?
 * @returns {{ valid: boolean, reason: string | null, validTo: string | null }}
 */
export function inspectCertificate(certPath, host = "127.0.0.1") {
  if (!existsSync(certPath))
    return { valid: false, reason: "файла нет", validTo: null };
  let cert;
  try {
    cert = new X509Certificate(readFileSync(certPath));
  } catch {
    return { valid: false, reason: "файл не читается как PEM", validTo: null };
  }
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  const now = Date.now();
  if (!Number.isFinite(to))
    return { valid: false, reason: "не разобран срок действия", validTo: null };
  if (Number.isFinite(from) && from - now > 60_000)
    return {
      valid: false,
      reason: "дата начала действия в будущем (проверьте часы)",
      validTo: cert.validTo,
    };
  if (to - now < MIN_VALID_MS)
    return {
      valid: false,
      reason:
        to <= now ? "срок действия истёк" : "истекает меньше чем через сутки",
      validTo: cert.validTo,
    };
  const matches = net.isIP(host) ? cert.checkIP(host) : cert.checkHost(host);
  if (!matches)
    return {
      valid: false,
      reason: `в сертификате нет адреса ${host}`,
      validTo: cert.validTo,
    };
  return { valid: true, reason: null, validTo: cert.validTo };
}

/**
 * Reuses `.provider/tls.crt` when it is still valid, otherwise issues a new
 * key pair. Never touches the OS trust store.
 * @returns {{ certPath: string, keyPath: string, created: boolean,
 *             reused: boolean, validTo: string | null, reason: string | null }}
 */
export function ensureCertificate(dir, host = "127.0.0.1") {
  const certPath = path.join(dir, "tls.crt");
  const keyPath = path.join(dir, "tls.key");
  const state = inspectCertificate(certPath, host);
  if (state.valid && existsSync(keyPath)) {
    return {
      certPath,
      keyPath,
      created: false,
      reused: true,
      validTo: state.validTo,
      reason: null,
    };
  }
  const reason = existsSync(keyPath) ? state.reason : "нет закрытого ключа";
  const openssl = findOpenSsl();
  if (!openssl) throw new Error(openSslHelp());
  // A stale key with a fresh certificate (or the reverse) is worse than no
  // pair at all, so both files go before reissuing.
  rmSync(certPath, { force: true });
  rmSync(keyPath, { force: true });
  const result = spawnSync(
    openssl.path,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      String(CERT_DAYS),
      "-subj",
      `/CN=${host}`,
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Не удалось создать сертификат разработки (${openssl.path}).\n` +
        (result.stderr || String(result.error)) +
        "\n" +
        openSslHelp(),
    );
  }
  const issued = inspectCertificate(certPath, host);
  if (!issued.valid) {
    throw new Error(
      `Новый сертификат почему-то непригоден: ${issued.reason}. Проверьте openssl и системные часы.`,
    );
  }
  return {
    certPath,
    keyPath,
    created: true,
    reused: false,
    validTo: issued.validTo,
    reason,
  };
}
