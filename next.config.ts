import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project so Turbopack does not pick up a
  // parent lockfile (there is an unrelated package-lock.json higher up).
  turbopack: {
    root: __dirname,
  },
  experimental: {
    // Client router cache for the force-dynamic dashboard pages (default is 0:
    // every tab switch re-renders on the server even if you left the page a
    // second ago). dynamic: a just-visited page is restored INSTANTLY on revisit
    // for 30s; static: hover-prefetched pages (router.prefetch in the sidebars)
    // stay usable for 2 minutes. Bounded staleness is fine here: the underlying
    // Dentally display reads are themselves cached ~60s server-side.
    staleTimes: {
      dynamic: 30,
      static: 120,
    },
  },
};

export default nextConfig;
