/**
 * Nested produce trail for the wiki_produce tool card (Claude/OpenCode style).
 * Domain → leaf hierarchy; only running/error open by default.
 */

import { cn } from "@/lib/utils";
import type { ProduceUnit } from "../hooks/project/produce";
import { produceDisplayRoots } from "../hooks/project/produce";
import { ProduceUnitCard } from "./ProduceUnitCard";

export type ProduceTrailProps = {
  units: ProduceUnit[];
  /** Unit id to force-open + highlight (AgentTree focus). */
  focusedUnitId?: string | null;
  className?: string;
};

export function ProduceTrail({ units, focusedUnitId = null, className }: ProduceTrailProps) {
  const roots = produceDisplayRoots(units);
  if (roots.length === 0) return null;

  return (
    <div
      className={cn("flex min-w-0 w-full flex-col gap-1.5", className)}
      data-testid="produce-trail"
    >
      {roots.map((unit) => (
        <ProduceUnitCard
          key={unit.unitId ?? `${unit.role}-${unit.status}`}
          unit={unit}
          focusedUnitId={focusedUnitId}
          depth={0}
        />
      ))}
    </div>
  );
}
