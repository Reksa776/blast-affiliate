// AffiliateOS — client address for rate-limit keys (pre-P0.6 fix, TD-7C-A5).
//
// `x-forwarded-for` is attacker-controlled unless a proxy overwrites it. Trusting
// it unconditionally (the P0.5 behaviour) let anyone rotate the rate-limit bucket
// by sending a different header value on each request, which defeats the limit.
//
// Rule: proxy headers are read ONLY when `TRUST_PROXY=true`, which must be set
// only when the deployment really sits behind a proxy that rewrites them.
//
// Deviation from the fix draft, deliberate: there is no `(req as any).ip`
// fallback. Next.js does not expose the socket address on `NextRequest`, and
// `x-real-ip` is just another header, so treating it as the "unforgeable" fallback
// would keep the same hole under a different name. Without a trusted proxy the
// answer is `"unknown"`, which collapses everyone into one bucket: a global limit
// is safe, a spoofable one is not.

import type { NextRequest } from "next/server";

export const UNKNOWN_CLIENT_IP = "unknown";

export function getClientIp(req: NextRequest): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded !== null) {
      // Left-most entry is the original client when the proxy appends.
      const first = forwarded.split(",")[0]?.trim();
      if (first !== undefined && first !== "") return first;
    }

    const realIp = req.headers.get("x-real-ip");
    if (realIp !== null && realIp.trim() !== "") return realIp.trim();
  }

  return UNKNOWN_CLIENT_IP;
}
