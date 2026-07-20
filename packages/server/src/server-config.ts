/**
 * Server bind config (shared by health + listen).
 */
import { isLanAccessEnabled } from "./http-util.ts";

export const host = process.env.OKF_WIKI_HOST ?? "127.0.0.1";
export const port = Number(process.env.OKF_WIKI_PORT ?? "8787");
export const allowLan = isLanAccessEnabled();

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LAN_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function isPrivateOrLinkLocalHost(value: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  return false;
}

/** Refuse non-loopback bind without OKF_WIKI_ALLOW_LAN=1. Call once at startup. */
export function assertBindPolicy(): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    if (!allowLan) {
      process.stderr.write(
        `refusing to bind non-loopback host "${host}" without OKF_WIKI_ALLOW_LAN=1\n` +
          `  local only:  OKF_WIKI_HOST=127.0.0.1 (default)\n` +
          `  LAN access:  OKF_WIKI_ALLOW_LAN=1 OKF_WIKI_HOST=0.0.0.0\n`,
      );
      process.exit(1);
    }
    if (!LAN_BIND_HOSTS.has(host) && !isPrivateOrLinkLocalHost(host)) {
      process.stderr.write(
        `refusing to bind host "${host}" even with LAN enabled (use 0.0.0.0 or a private IP)\n`,
      );
      process.exit(1);
    }
  }
}
