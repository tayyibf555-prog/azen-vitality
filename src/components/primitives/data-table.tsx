import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: string;
  /** Cell renderer. */
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  empty,
  className,
  maxRows,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  className?: string;
  /** Cap the visible rows to this many, keeping a long table from turning a page
   *  into an endless scroll. A quiet footer notes how many more there are. Omit
   *  to show every row. Kept side-effect free so this stays a shared component
   *  usable from both server and client views. */
  maxRows?: number;
}) {
  if (rows.length === 0 && empty) {
    return <>{empty}</>;
  }

  const alignClass = (a?: Column<T>["align"]) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

  const capped = typeof maxRows === "number" && maxRows > 0 && rows.length > maxRows;
  const visibleRows = capped ? rows.slice(0, maxRows) : rows;

  return (
    <div className={className}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line text-left">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-faint",
                    alignClass(c.align),
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr
                key={getRowKey(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-b border-line last:border-0",
                  onRowClick && "cursor-pointer transition-colors hover:bg-[#f7f9fc]",
                )}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-3 py-3 text-ink", alignClass(c.align), c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {capped ? (
        <p className="border-t border-line px-3 pt-2.5 text-center text-xs font-medium text-faint">
          Showing {maxRows} of {rows.length}
        </p>
      ) : null}
    </div>
  );
}
