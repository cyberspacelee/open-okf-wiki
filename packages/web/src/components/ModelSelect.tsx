import { Link } from "react-router-dom";
import type { ModelProfilePublic } from "../api";
import { useI18n } from "../i18n";
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
  emptyLabel,
}: Props) {
  const { t } = useI18n();
  const placeholder = emptyLabel ?? t.modelSelect.selectPlaceholder;

  if (models.length === 0) {
    return (
      <div className="field" data-testid="model-select-empty">
        <Label htmlFor={id}>{t.modelSelect.label}</Label>
        <p className="muted small">
          {t.modelSelect.emptyBefore}
          <Link to="/settings" className="inline-link ml-0">
            {t.modelSelect.emptyLink}
          </Link>
          {t.modelSelect.emptyAfter}
        </p>
      </div>
    );
  }

  return (
    <div className="field">
      <Label htmlFor={id}>{t.modelSelect.label}</Label>
      <select
        id={id}
        className="model-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        data-testid={testId}
      >
        {allowEmpty ? <option value="">{placeholder}</option> : null}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {defaultModelProfileId === m.id ? ` ${t.modelSelect.defaultSuffix}` : ""}
            {" - "}
            {m.modelId}
          </option>
        ))}
      </select>
      <span className="field-hint">
        {t.modelSelect.hintBefore}
        <Link to="/settings">{t.modelSelect.hintLink}</Link>
        {t.modelSelect.hintAfter}
      </span>
    </div>
  );
}
