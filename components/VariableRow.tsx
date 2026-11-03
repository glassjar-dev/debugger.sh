"use client";

import { useEffect, useState } from "react";

import {
  presentStanfordVariable,
  stanfordCollectionName,
} from "@/lib/stanford/formatters";

import type { DapVariable } from "./dap-types";
import { toDebugVariable } from "@/lib/telemetry/map";
import { Telemetry } from "@/lib/telemetry/client";

export type VariableRowProps = {
  variable: DapVariable;
  expand: (variablesReference: number) => DapVariable[];
  depth: number;
};

export function VariableRow({ variable, expand, depth }: VariableRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DapVariable[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const stanfordName = stanfordCollectionName(variable.type);
  // Once presented, only offer expand if there are logical children (empty → no chevron).
  const expandable =
    children !== null ? children.length > 0 : variable.variablesReference > 0;
  const displayValue =
    summary ?? (stanfordName ? stanfordName : variable.value);
  const displayType = stanfordName ?? variable.type;

  // Re-present whenever the DAP variable identity changes (new pause / step).
  // Stale variablesReference handles from a previous stop must not be reused.
  useEffect(() => {
    setExpanded(false);
    setChildren(null);
    setSummary(null);
    if (!stanfordName || variable.variablesReference <= 0) return;
    const presented = presentStanfordVariable(variable, expand);
    if (presented) {
      setSummary(presented.summary);
      setChildren(presented.children);
    }
  }, [variable, expand, stanfordName]);

  const toggle = () => {
    if (!expandable) return;
    const next = !expanded;
    let revealed = children;
    if (next && revealed === null && variable.variablesReference > 0) {
      const presented = presentStanfordVariable(variable, expand);
      if (presented) {
        setSummary(presented.summary);
        revealed = presented.children;
      } else {
        revealed = expand(variable.variablesReference);
      }
      setChildren(revealed);
    }
    Telemetry.log("debug_variable", {
      id: toDebugVariable(variable).id,
      expanded: next,
      ...(next ? { children: (revealed ?? []).map(toDebugVariable) } : {}),
    });
    setExpanded(next);
  };

  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <div
        className="ide-var-row"
        data-expandable={expandable ? "true" : undefined}
        onClick={toggle}
      >
        <span className="ide-var-chevron" data-open={expanded ? "true" : undefined}>
          {expandable ? "▸" : ""}
        </span>
        <span className="ide-var-name" title={variable.name}>
          {variable.name}
        </span>
        {displayType && (
          <span className="ide-var-type" title={displayType}>
            {displayType}
          </span>
        )}
        <span className="ide-var-value" title={displayValue}>
          {displayValue}
        </span>
      </div>
      {expanded &&
        children?.map((child, index) => (
          <VariableRow
            key={`${child.name}-${index}`}
            variable={child}
            expand={expand}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}
