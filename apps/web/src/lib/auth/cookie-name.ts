// AffiliateOS — session cookie name (P0.5, hardened in 8C).
//
// `__Host-` is a browser-enforced guarantee, not a naming convention: a cookie with
// that prefix is only accepted when it is `Secure`, has `Path=/`, and carries no
// `Domain` attribute. That is exactly what makes it un-forgeable from a sub-domain,
// so the prefix is used in production only — a `Secure` cookie cannot be set over
// plain http, which is how `next dev` runs locally. In development the plain name is
// used, and every cookie write still sets `Path=/` and no `Domain`, so the shape is
// ready for the prefixed name.
//
// Kept in a dependency-free module (no database, no Next.js) so the middleware, the
// test fixtures and the unit tests can share one source of truth.

export const PRODUCTION_SESSION_COOKIE_NAME = "__Host-aos_session";
export const DEVELOPMENT_SESSION_COOKIE_NAME = "aos_session";

/** `__Host-aos_session` in production, `aos_session` everywhere else. */
export function getSessionCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? PRODUCTION_SESSION_COOKIE_NAME
    : DEVELOPMENT_SESSION_COOKIE_NAME;
}
