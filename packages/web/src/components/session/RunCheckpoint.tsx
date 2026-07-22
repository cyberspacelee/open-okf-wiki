/**
 * Visual-only checkpoint separators (plan approved / ready to publish).
 * Does NOT restore messages or roll back Wiki Runs.
 */

import {
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
} from "@/components/ai-elements/checkpoint";

export type RunCheckpointProps = {
  label: string;
  testId?: string;
};

export function RunCheckpoint({
  label,
  testId = "session-run-checkpoint",
}: RunCheckpointProps) {
  return (
    <div className="my-3" data-testid={testId}>
      <Checkpoint>
        <CheckpointIcon />
        <CheckpointTrigger
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto px-1 py-0.5 text-xs"
          tooltip={label}
          onClick={(e) => {
            e.preventDefault();
          }}
        >
          {label}
        </CheckpointTrigger>
      </Checkpoint>
    </div>
  );
}
