import { useMemo } from "react";
import { encodeQr } from "../../lib/qr";

/** Modules of light margin the QR specification asks for around the symbol. */
const QUIET_ZONE = 4;

/** Props for {@link QrCode}. */
export interface QrCodeProps {
  /** What the code carries. */
  value: string;
  /** Accessible name, e.g. "QR code for your authenticator app". */
  label: string;
  /** Rendered width and height in CSS pixels. */
  size?: number;
}

/**
 * A QR code drawn as an SVG in the browser, never fetched from a QR service, so the
 * secret it carries stays on this page.
 *
 * Dark on white whatever the theme: authenticator cameras read light-on-dark codes
 * unreliably.
 *
 * @param props - Value, label and size.
 * @returns The image.
 */
export function QrCode({ value, label, size = 200 }: QrCodeProps) {
  const path = useMemo(() => {
    const qr = encodeQr(value, { errorCorrection: "M" });
    let d = "";
    qr.modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
      });
    });
    return { d, extent: qr.size + QUIET_ZONE * 2 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${path.extent} ${path.extent}`}
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect width={path.extent} height={path.extent} fill="#ffffff" />
      <path d={path.d} fill="#000000" />
    </svg>
  );
}
