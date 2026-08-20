import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { parseCopilotMarkdown, type CopilotBlock, type CopilotInline } from "@/lib/copilot/markdown";

// ---------------------------------------------------------------------------
// THE CO-PILOT'S ANSWER, TYPESET.
//
// The other half of src/lib/copilot/markdown.ts: that file turns the reply into
// blocks, this one turns blocks into elements. The split is what makes the
// security claim checkable — the parser can be tested without a renderer, and
// the renderer has exactly one job, which is to put a string in a text position.
//
// THERE IS NO dangerouslySetInnerHTML IN THIS FILE AND THERE MUST NEVER BE ONE.
// Every string below reaches the DOM as a React text child or as the href of an
// anchor whose scheme the parser has already proved. React escapes text children,
// so a reply containing "<script>" renders the characters "<script>" and nothing
// executes. copilot-markdown.test.ts renders this component against hostile input
// and asserts on the markup, so the claim is pinned rather than promised.
//
// NO "use client". This component holds no state and no handler, so it stays a
// plain component that either tree can render: the page chat (a client component)
// imports it, and so does a node test that renders it with react-dom/server.
// Marking it a client boundary would buy nothing and cost the test its renderer.
// ---------------------------------------------------------------------------

function Inline({ runs }: { runs: CopilotInline[] }) {
  return (
    <>
      {runs.map((run, index) => {
        if (run.kind === "bold") {
          return (
            <strong key={index} className="font-semibold text-navy">
              {run.text}
            </strong>
          );
        }
        if (run.kind === "code") {
          return (
            <code
              key={index}
              className="rounded border border-line bg-card-muted px-1 py-px font-mono text-[0.85em] text-navy"
            >
              {run.text}
            </code>
          );
        }
        if (run.kind === "link") {
          return (
            <a
              key={index}
              href={run.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-deep underline decoration-line-strong underline-offset-2 hover:decoration-blue-deep"
            >
              {run.text}
            </a>
          );
        }
        return <Fragment key={index}>{run.text}</Fragment>;
      })}
    </>
  );
}

function Block({ block }: { block: CopilotBlock }) {
  if (block.kind === "heading") {
    return block.level === 2 ? (
      <h2 className="pt-1 text-[15px] font-semibold tracking-[-0.01em] text-navy">
        <Inline runs={block.inline} />
      </h2>
    ) : (
      <h3 className="pt-0.5 text-[13.5px] font-semibold tracking-[-0.01em] text-navy">
        <Inline runs={block.inline} />
      </h3>
    );
  }

  if (block.kind === "rule") {
    return <hr className="border-t border-line" />;
  }

  if (block.kind === "list") {
    const items = block.items.map((item, index) => (
      <li key={index} className="pl-1">
        <Inline runs={item} />
      </li>
    ));
    return block.ordered ? (
      <ol className="list-decimal space-y-1 pl-5 marker:font-semibold marker:text-faint">{items}</ol>
    ) : (
      <ul className="list-disc space-y-1 pl-5 marker:text-faint">{items}</ul>
    );
  }

  if (block.kind === "table") {
    return (
      // Its own scroller. A wide table must never be the reason the whole chat
      // column scrolls sideways.
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[22rem] border-collapse text-[13px]">
          <thead>
            <tr>
              {block.head.map((cell, index) => (
                <th
                  key={index}
                  scope="col"
                  className="border-b border-line-strong px-2 py-1.5 text-left font-semibold text-navy"
                >
                  <Inline runs={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-line last:border-0">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-2 py-1.5 align-top text-ink">
                    <Inline runs={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <p>
      {block.lines.map((line, index) => (
        <Fragment key={index}>
          {/* The author's own line breaks, kept. See the note on
              CopilotParagraphBlock: a record read back as "Status: …" over
              several short lines is the co-pilot's normal output shape, and
              reflowing it into a sentence is a legibility regression. */}
          {index > 0 ? <br /> : null}
          <Inline runs={line} />
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Render one co-pilot reply.
 *
 * `text` is the raw string from /api/copilot. Renders nothing at all for an
 * empty or whitespace-only reply rather than an empty bordered box.
 */
export function CopilotProse({ text, className }: { text: string; className?: string }) {
  const blocks = parseCopilotMarkdown(text);
  if (blocks.length === 0) return null;
  return (
    <div className={cn("space-y-3 text-[14.5px] leading-[1.65] text-ink", className)}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
