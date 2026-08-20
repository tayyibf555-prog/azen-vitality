import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { CopilotProse } from "@/components/platform/copilot-prose";

const render = (t: string) => renderToStaticMarkup(createElement(CopilotProse, { text: t }));
const hrefs = (h: string) => [...h.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const tags = (h: string) => [...new Set([...h.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()))];
const OK = new Set(["div","p","br","strong","code","a","ul","ol","li","h2","h3","hr","table","thead","tbody","tr","th","td"]);

describe("ADVERSARIAL XSS probe (vectors not in the lane's own list)", () => {
  const VECTORS: [string, string][] = [
    ["uppercase scheme", "HTTPS://evil.test/x"],
    ["mixed scheme", "HtTpS://evil.test/x"],
    ["backslash authority", "https://evil.test\\@good.test/x"],
    ["null byte", "https://good.test\u0000javascript:alert(1)"],
    ["href quote break", 'https://good.test/a"><script>alert(1)</script>'],
    ["single-quote break", "https://good.test/a'><img src=x onerror=alert(1)>"],
    ["backtick break", "https://good.test/a`onload=alert(1)"],
    ["entity double-escape", "&#60;script&#62;alert(1)&##60;/script&#62;"],
    ["numeric entity", "&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;"],
    ["nested markup in bold", "**<img src=x onerror=alert(1)>**"],
    ["nested markup in code", "`<svg onload=alert(1)>`"],
    ["md link javascript", "[click me](javascript:alert(1))"],
    ["md link data", "[click me](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
    ["md image", "![alt](https://evil.test/x.png)"],
    ["vbscript bare", "vbscript:msgbox(1)"],
    ["protocol-relative", "//evil.test/x"],
    ["crlf in url", "https://good.test/a\r\nLocation: https://evil.test"],
    ["unicode LTR override", "https://good.test/\u202Egnp.exe"],
    ["tab-split scheme", "http\t://evil.test"],
    ["comment breakout", "-->< script>alert(1)</script><!--"],
    ["srcdoc iframe", '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'],
    ["form action", '<form action="https://evil.test"><input name=x>'],
    ["base tag", '<base href="https://evil.test/">'],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
    ["object data", '<object data="javascript:alert(1)"></object>'],
    ["math mtext", "<math><mtext><script>alert(1)</script></mtext></math>"],
    ["template", "<template><script>alert(1)</script></template>"],
  ];

  it.each(VECTORS)("%s produces no executable element or scheme", (_label, payload) => {
    for (const wrap of [payload, `## ${payload}`, `- ${payload}`, `| ${payload} | b |\n| --- | --- |\n| c | d |`]) {
      const html = render(wrap);
      expect(tags(html).filter((t) => !OK.has(t)), `unauthored tag from: ${wrap}`).toEqual([]);
      for (const h of hrefs(html)) {
        expect(/^https?:\/\//.test(h), `href escaped the allow-list: ${h}`).toBe(true);
      }
      // The real property: the payload may appear as ESCAPED TEXT (correct), but
      // must produce no ELEMENT and no ATTRIBUTE. Decoding entities back would be
      // testing my own unescaper, so assert on the markup React actually emits.
      const authoredOnly = html.replace(/<\/?(?:div|p|br|strong|code|a|ul|ol|li|h2|h3|hr|table|thead|tbody|tr|th|td)\b[^>]*>/g, "");
      expect(authoredOnly, `a raw tag survived from: ${wrap}`).not.toMatch(/<[a-zA-Z]/);
      expect(authoredOnly, `a raw attribute survived from: ${wrap}`).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    }
  });

  it("does not hang on pathological input (ReDoS / quadratic scan)", () => {
    const bombs = [
      "-".repeat(40_000),
      "*".repeat(20_000),
      "`".repeat(20_000),
      "|".repeat(20_000),
      ("a|".repeat(5_000)) + "\n" + ("-|".repeat(5_000)),
      "https://" + "a".repeat(30_000),
      " ".repeat(20_000) + "- x",
      ("**a" .repeat(6_000)),
      "#".repeat(20_000) + " x",
    ];
    for (const b of bombs) {
      const t0 = Date.now();
      render(b);
      const ms = Date.now() - t0;
      expect(ms, `pathological input took ${ms}ms`).toBeLessThan(2_000);
    }
  });
});
