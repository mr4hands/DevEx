"use client";

import { useMemo } from "react";

import type { Resource } from "@/lib/types";

export function ResourceDrawer({
  resource,
  onClose,
}: {
  resource: Resource | null;
  onClose: () => void;
}) {
  const sections = useMemo(() => buildSections(resource), [resource]);

  if (!resource) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Details</h2>
          <p className="text-xs text-muted-foreground">
            Click a resource to inspect it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">{resource.address}</h2>
          <p className="text-xs text-muted-foreground">
            {resource.type} · {resource.mode} · {resource.module || "root"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
        {sections.map((s) => (
          <section key={s.title}>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              {s.title}
            </h3>
            {s.render()}
          </section>
        ))}
      </div>
    </div>
  );
}

type Section = { title: string; render: () => React.ReactNode };

function buildSections(resource: Resource | null): Section[] {
  if (!resource) return [];
  const v = resource.values;
  const sections: Section[] = [];

  // Identity
  sections.push({
    title: "Identity",
    render: () => (
      <KeyValueGrid
        rows={[
          ["address", resource.address],
          ["type", resource.type],
          ["name", resource.name],
          ["module", resource.module || "(root)"],
          ["provider", resource.provider],
          ["mode", resource.mode],
        ]}
      />
    ),
  });

  // Type-specific helpers — give common resources nicer rendering.
  if (
    resource.type === "aws_security_group" ||
    resource.type === "aws_default_security_group"
  ) {
    sections.push(rulesSection("Ingress", v.ingress));
    sections.push(rulesSection("Egress", v.egress));
  }
  if (resource.type === "aws_vpc" || resource.type === "aws_subnet") {
    sections.push({
      title: "Networking",
      render: () => (
        <KeyValueGrid
          rows={
            [
              ["cidr_block", asString(v.cidr_block)],
              ["availability_zone", asString(v.availability_zone)],
              ["map_public_ip_on_launch", asString(v.map_public_ip_on_launch)],
            ].filter(([, val]) => val !== undefined) as [string, string][]
          }
        />
      ),
    });
  }
  if (resource.type.startsWith("aws_s3_bucket")) {
    sections.push({
      title: "Bucket",
      render: () => (
        <KeyValueGrid
          rows={
            [
              ["bucket", asString(v.bucket)],
              ["arn", asString(v.arn)],
              ["region", asString(v.region)],
            ].filter(([, val]) => val !== undefined) as [string, string][]
          }
        />
      ),
    });
  }
  if (typeof v.tags === "object" && v.tags) {
    sections.push({
      title: "Tags",
      render: () => (
        <KeyValueGrid
          rows={Object.entries(v.tags as Record<string, string>).map(
            ([k, val]) => [k, val] as [string, string],
          )}
        />
      ),
    });
  }

  // Raw attributes — always last, scroll if huge.
  sections.push({
    title: "Raw attributes",
    render: () => (
      <pre className="text-[11px] font-mono bg-muted border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
        {JSON.stringify(v, null, 2)}
      </pre>
    ),
  });

  return sections;
}

function KeyValueGrid({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No data.</p>;
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, val]) => (
        <FragmentRow key={k} k={k} v={val} />
      ))}
    </dl>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="font-mono text-muted-foreground">{k}</dt>
      <dd className="font-mono break-all">{v}</dd>
    </>
  );
}

function rulesSection(title: string, rules: unknown): Section {
  return {
    title,
    render: () => {
      if (!Array.isArray(rules) || rules.length === 0) {
        return <p className="text-xs text-muted-foreground">none</p>;
      }
      return (
        <ul className="space-y-2">
          {rules.map((rule, i) => (
            <li
              key={i}
              className="rounded border border-border bg-muted/50 px-2 py-1.5 text-xs font-mono"
            >
              <div>
                {asString((rule as Record<string, unknown>).protocol)}{" "}
                {asString((rule as Record<string, unknown>).from_port)}–
                {asString((rule as Record<string, unknown>).to_port)}
              </div>
              {Array.isArray((rule as Record<string, unknown>).cidr_blocks) && (
                <div className="text-muted-foreground">
                  {((rule as { cidr_blocks: string[] }).cidr_blocks ?? []).join(", ")}
                </div>
              )}
              {asString((rule as Record<string, unknown>).description) !== undefined && (
                <div className="text-muted-foreground">
                  {asString((rule as Record<string, unknown>).description)}
                </div>
              )}
            </li>
          ))}
        </ul>
      );
    },
  };
}

function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}
