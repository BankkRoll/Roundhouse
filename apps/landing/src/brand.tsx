/**
 * Logo mark, drawn the same as the dashboard's (see `docs/brand/icon.svg`).
 *
 * @param props - Pixel size (defaults to 22).
 * @returns The mark, hidden from assistive tech (the product name sits next to it).
 */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className="shrink-0">
      <rect width="512" height="512" rx="112" fill="#0b0c0d" />
      <g fill="#d4f53c">
        <path d="M160 160 352 352M352 160 160 352" stroke="#d4f53c" strokeWidth="44" />
        <rect x="104" y="104" width="96" height="96" rx="20" />
        <rect x="312" y="104" width="96" height="96" rx="20" />
        <rect x="104" y="312" width="96" height="96" rx="20" />
        <rect x="312" y="312" width="96" height="96" rx="20" />
        <rect x="220" y="220" width="72" height="72" rx="14" />
      </g>
    </svg>
  );
}
