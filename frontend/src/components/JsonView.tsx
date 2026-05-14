import { useState } from "react";

interface Props {
  value: unknown;
  name?: string;
  depth?: number;
  defaultOpen?: boolean;
}

export default function JsonView({
  value,
  name,
  depth = 0,
  defaultOpen = true,
}: Props) {
  if (value === null) return <Leaf name={name} v={<Token kind="null">null</Token>} />;
  if (typeof value === "boolean")
    return <Leaf name={name} v={<Token kind="bool">{String(value)}</Token>} />;
  if (typeof value === "number")
    return <Leaf name={name} v={<Token kind="num">{value}</Token>} />;
  if (typeof value === "string")
    return (
      <Leaf name={name} v={<Token kind="str">&quot;{value}&quot;</Token>} />
    );

  if (Array.isArray(value))
    return (
      <Collapsible
        name={name}
        depth={depth}
        defaultOpen={defaultOpen && depth < 2}
        summary={`Array(${value.length})`}
      >
        {value.map((item, i) => (
          <JsonView
            key={i}
            value={item}
            name={String(i)}
            depth={depth + 1}
            defaultOpen={defaultOpen && depth < 1}
          />
        ))}
      </Collapsible>
    );

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <Collapsible
        name={name}
        depth={depth}
        defaultOpen={defaultOpen && depth < 2}
        summary={`{${entries.length}}`}
      >
        {entries.map(([k, v]) => (
          <JsonView
            key={k}
            name={k}
            value={v}
            depth={depth + 1}
            defaultOpen={defaultOpen && depth < 1}
          />
        ))}
      </Collapsible>
    );
  }
  return null;
}

function Leaf({ name, v }: { name?: string; v: React.ReactNode }) {
  return (
    <div className="font-mono text-xs leading-5 pl-4">
      {name !== undefined && <Key>{name}</Key>}
      {v}
    </div>
  );
}

function Collapsible({
  name,
  depth,
  summary,
  defaultOpen,
  children,
}: {
  name?: string;
  depth: number;
  summary: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={depth === 0 ? "" : "pl-4"}>
      <button
        onClick={() => setOpen(!open)}
        className="font-mono text-xs leading-5 text-left hover:bg-slate-800/50 rounded px-1 -ml-1"
      >
        <span className="text-slate-500 select-none w-3 inline-block">
          {open ? "▾" : "▸"}
        </span>
        {name !== undefined && <Key>{name}</Key>}
        <span className="text-slate-500">{summary}</span>
      </button>
      {open && <div className="border-l border-slate-800 ml-2">{children}</div>}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <span className="text-sky-400">{children}: </span>;
}

function Token({
  kind,
  children,
}: {
  kind: "str" | "num" | "bool" | "null";
  children: React.ReactNode;
}) {
  const color =
    kind === "str"
      ? "text-emerald-300"
      : kind === "num"
        ? "text-amber-300"
        : kind === "bool"
          ? "text-pink-300"
          : "text-slate-500";
  return <span className={color}>{children}</span>;
}
