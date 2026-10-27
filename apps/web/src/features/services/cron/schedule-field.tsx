/**
 * Schedule inputs shared by a cron service's settings and the new-service flow: the
 * schedule field with its live preview (checked in the browser with the shared parser,
 * so no request is made per keystroke) and the time zone picker.
 *
 * @module
 */
import { Input, Label, Select, SettingsRow } from "@roundhouse/ui";
import { type ReactNode, useId, useMemo } from "react";
import { describeSchedule, formatSlot, previewSchedule, type SchedulePreview } from "./cron-format";

/** How a field is laid out: a settings row, or label above control in a dialog. */
export type FieldLayout = "row" | "stacked";

function Field({
  layout,
  id,
  label,
  description,
  children,
}: {
  layout: FieldLayout;
  id: string;
  label: string;
  description?: string;
  children: ReactNode;
}) {
  if (layout === "row") {
    return (
      <SettingsRow label={label} description={description} htmlFor={id}>
        {children}
      </SettingsRow>
    );
  }
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

const sentence = (message: string) => `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;

/** Props for {@link SchedulePreviewText}. */
export interface SchedulePreviewTextProps {
  /** Id for `aria-describedby`. */
  id: string;
  schedule: string;
  timezone: string;
  preview: SchedulePreview;
  /** Shown instead of the format hint while the schedule is blank, e.g. after a submit. */
  blankError?: string | null;
}

/**
 * What a schedule means: its description, zone and next slot, or the parse error with
 * the offending characters underlined.
 *
 * @param props - The schedule, its zone and its checked preview.
 * @returns The line under the schedule input.
 */
export function SchedulePreviewText({
  id,
  schedule,
  timezone,
  preview,
  blankError,
}: SchedulePreviewTextProps) {
  const { error, slots } = preview;
  if (!schedule.trim()) {
    if (blankError) {
      return (
        <p id={id} role="alert" className="mt-1.5 text-xs text-danger">
          {blankError}
        </p>
      );
    }
    return (
      <p id={id} className="mt-1.5 text-xs text-muted-foreground">
        Five fields (minute hour day month weekday) or a macro such as @daily.
      </p>
    );
  }
  if (error?.code === "invalid_schedule") {
    // NOTE: An empty span (e.g. a missing field) still gets one marked cell to point at.
    const start = Math.min(error.start, schedule.length);
    const end = Math.max(start, Math.min(error.end, schedule.length));
    const marked = schedule.slice(start, end) || " ";
    return (
      <div id={id} className="mt-1.5 grid gap-1 text-xs text-danger">
        <code
          aria-hidden="true"
          className="overflow-x-auto font-mono whitespace-pre text-muted-foreground"
        >
          {schedule.slice(0, start)}
          <mark
            data-testid="schedule-error-span"
            className="rounded-xs bg-danger/15 text-danger underline decoration-danger decoration-wavy underline-offset-2"
          >
            {marked}
          </mark>
          {schedule.slice(end)}
        </code>
        <p role="alert">{sentence(error.message)}</p>
      </div>
    );
  }
  if (error) {
    return (
      <p id={id} role="alert" className="mt-1.5 text-xs text-danger">
        {sentence(error.message)}
      </p>
    );
  }
  const description = describeSchedule(schedule) ?? schedule;
  const next = slots[0];
  return (
    <p
      id={id}
      className="mt-1.5 text-xs text-muted-foreground"
      title={slots.map((slot) => formatSlot(slot, timezone)).join("\n")}
    >
      <span className="text-foreground">{description}</span> ({timezone})
      {next !== undefined ? (
        <span className="tabular-nums"> · next: {formatSlot(next, timezone)}</span>
      ) : (
        " · never runs"
      )}
    </p>
  );
}

/** Props for {@link ScheduleField}. */
export interface ScheduleFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Zone the preview reads the schedule in. */
  timezone: string;
  layout?: FieldLayout;
  autoFocus?: boolean;
  /** Error for a blank schedule, once the form was submitted. */
  blankError?: string | null;
}

/**
 * The schedule input with its live preview.
 *
 * @param props - Value, change handler, zone and layout.
 * @returns The field.
 * @example
 * <ScheduleField value={schedule} onChange={setSchedule} timezone="Europe/Berlin" />
 */
export function ScheduleField({
  value,
  onChange,
  timezone,
  layout = "row",
  autoFocus,
  blankError,
}: ScheduleFieldProps) {
  const id = useId();
  const preview = useMemo(() => previewSchedule(value, timezone), [value, timezone]);
  const invalid = value.trim() ? preview.error?.code === "invalid_schedule" : Boolean(blankError);
  return (
    <Field layout={layout} id={id} label="Schedule">
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={`${id}-preview`}
        placeholder="0 3 * * *"
        className="font-mono"
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
      />
      <SchedulePreviewText
        id={`${id}-preview`}
        schedule={value}
        timezone={timezone}
        preview={preview}
        blankError={blankError}
      />
    </Field>
  );
}

/** Props for {@link TimezoneField}. */
export interface TimezoneFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Zones to offer, `UTC` first; see `timeZones`. */
  zones: readonly string[];
  layout?: FieldLayout;
}

/**
 * The IANA time zone picker.
 *
 * @param props - Value, change handler, zones and layout.
 * @returns The field.
 */
export function TimezoneField({ value, onChange, zones, layout = "row" }: TimezoneFieldProps) {
  const id = useId();
  return (
    <Field
      layout={layout}
      id={id}
      label="Time zone"
      description={
        layout === "row" ? "The schedule follows this zone's wall clock, DST included." : undefined
      }
    >
      <Select
        id={id}
        value={value}
        aria-describedby={layout === "row" ? `${id}-description` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone.replaceAll("_", " ")}
          </option>
        ))}
      </Select>
    </Field>
  );
}
