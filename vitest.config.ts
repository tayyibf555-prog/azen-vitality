import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // `next/font/google` is a build-time placeholder rewritten by Next's SWC loader;
      // outside `next build` it is empty and calling a font throws. Alias it to a stub
      // so components that self-host a font render under vitest. Test-only: `next build`
      // never reads this config and uses the real loader.
      "next/font/google": resolve(
        __dirname,
        "src/components/landing/bespoke/__mocks__/next-font-google.ts",
      ),
    },
  },
});
