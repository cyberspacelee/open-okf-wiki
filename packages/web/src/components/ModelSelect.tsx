import { Link } from "react-router-dom";
import type { ModelProfilePublic } from "../api";
import { Label } from "@/components/ui/label";

type Props = {
  models: ModelProfilePublic[];
  value: string;
  onChange: (profileId: string) => void;
  defaultModelProfileId?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  "data-testid"?: string;
  /** Show empty option for optional selection. */
  allowEmpty?: boolean;
  emptyLabel?: string;
};

export function ModelSelect({
  models,
  value,
  onChange,
  defaultModelProfileId,
  id = "model-profile",
  required,
  disabled,
  "data-testid": testId = "model-profile-select",
  allowEmpty,
  emptyLabel = "Select a model…",
}: Props) {
  if (models.length === 0) {
    return (
      <div className="field" data-testid="model-select-empty">
        <Label htmlFor={id}>Model</Label>
        <p className="muted small">
          No models configured.{" "}
          <Link to="/settings" className="inline-link ml-0">
            Add a model in Settings
          </Link>{" "}
          first.
        </p>
      </div>
    );
  }

  return (
    <div className="field">
      <Label htmlFor={id}>Model</Label>
      <select
        id={id}
        className="model-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        data-testid={testId}
      >
        {allowEmpty ? <option value="">{emptyLabel}</option> : null}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {defaultModelProfileId === m.id ? " (default)" : ""}
            {" - "}
            {m.modelId}
          </option>
        ))}
      </select>
      <span className="field-hint">
        Models are managed in{" "}
        <Link to="/settings">Settings</Link>. Base URL and API key are not set per workspace.
      </span>
    </div>
  );
}
