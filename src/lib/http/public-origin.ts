import "server-only";

/**
 * MVP-5.16 finding: on Netlify, a Route Handler's `request.url` origin
 * resolves to the internal per-deploy hash subdomain
 * (e.g. `https://<deploy-id>--marqos-staging.netlify.app`), not the
 * stable public domain the request actually arrived on — confirmed by
 * direct observation (`curl` against the production URL returned a
 * `Location` header containing the deploy-hash host), not assumed from
 * documentation. Using `request.url` directly for an OAuth `redirect_uri`
 * would produce a value that changes on every deploy and would never
 * match what's registered with a real OAuth provider.
 *
 * The standard, correct fix for a reverse-proxied request is to prefer
 * the forwarded-host headers the proxy sets, falling back to `Host`, and
 * only falling back to the request URL's own origin as a last resort
 * (e.g. local dev, where no proxy rewrites anything).
 */
export function resolvePublicOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = forwardedHost ?? request.headers.get("host");

  if (host) {
    const protocol = forwardedProto ?? (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${protocol}://${host}`;
  }

  return new URL(request.url).origin;
}
