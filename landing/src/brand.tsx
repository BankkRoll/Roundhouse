/**
 * Square lime logo mark, drawn the same as the dashboard's.
 *
 * @param props - Pixel size (defaults to 22).
 * @returns The mark, hidden from assistive tech (the product name sits next to it).
 */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path
        d="M9 11h14M9 16h14M9 21h9"
        stroke="var(--accent-foreground)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
