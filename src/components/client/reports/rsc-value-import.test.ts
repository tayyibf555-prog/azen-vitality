// THE 500 THIS PINS: reports-view.tsx (a SERVER page) once imported the value
// PAY_DEFAULT_PRESET from flagship-reports.tsx (a "use client" module). Under
// React Server Components every export of a client module becomes a
// client-reference proxy on the server side - constants included - so the
// "string" matched no presetWindow case, the window came back undefined, and
// the owner's reports page crashed at render. tsc, vitest (plain node ignores
// the directive) and the production build all stayed green: render-time only.
//
// The durable rule: a "use client" module may hand a server component nothing
// but components to render. Shared VALUES live in a plain module both sides
// import - here, report-window.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const VIEW = "src/components/client/reports/reports-view.tsx";
const FLAGSHIP = "src/components/client/reports/flagship-reports.tsx";

describe("the server page and the client module share values only through report-window", () => {
  it("reports-view imports PAY_DEFAULT_PRESET from the pure module, never the client one", () => {
    const src = readFileSync(VIEW, "utf8");
    expect(src).toContain('import { PAY_DEFAULT_PRESET } from "@/lib/reports/report-window"');
    const fromFlagship = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/flagship-reports"/);
    expect(fromFlagship, "reports-view imports something from ./flagship-reports").not.toBeNull();
    expect(fromFlagship![1]).not.toContain("PAY_DEFAULT_PRESET");
  });

  it("flagship-reports (use client) exports no runtime constants at all", () => {
    const src = readFileSync(FLAGSHIP, "utf8");
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
    // `export const NAME: Type = value` in a client module is a server-side trap;
    // components (export function X / export default) are the only safe exports.
    expect(src).not.toMatch(/export const [A-Z_]+\s*[:=]/);
  });
});
