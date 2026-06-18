import { cloneElement, isValidElement } from "react";
import { cn } from "@/lib/utils";

/**
 * Minimal Slot: merges its own className onto a single child element so
 * components can render `asChild` (e.g. a Button that is actually a <Link>).
 */
export function Slot({
  children,
  className,
  ...props
}: { children?: React.ReactNode; className?: string } & Record<string, unknown>) {
  if (!isValidElement(children)) return null;
  const child = children as React.ReactElement<{ className?: string }>;
  return cloneElement(child, {
    ...props,
    className: cn(className, child.props.className),
  });
}
