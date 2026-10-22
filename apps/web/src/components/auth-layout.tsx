import type { ReactNode } from "react";
import { Brand } from "./brand";

/** Props for {@link AuthLayout}. */
export interface AuthLayoutProps {
  /** Card heading. */
  title: string;
  /** Text under the heading. */
  description?: ReactNode;
  /** Card body. */
  children: ReactNode;
  /** Content above the card, such as a step indicator. */
  above?: ReactNode;
  /** Max card width in px. Defaults to 420. */
  width?: number;
}

/**
 * Centered single-card layout for sign-in, setup and invites.
 *
 * @param props - Heading, description and body.
 * @returns The page.
 */
export function AuthLayout({ title, description, children, above, width = 420 }: AuthLayoutProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full" style={{ maxWidth: width }}>
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        {above}
        <section className="rounded-lg border border-border bg-surface p-6">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description ? (
            <div className="mt-1 text-sm text-muted-foreground">{description}</div>
          ) : null}
          <div className="mt-5">{children}</div>
        </section>
      </div>
    </main>
  );
}
