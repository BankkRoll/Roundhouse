import { EmptyState } from "@openrail/ui";
import { SparklesIcon } from "lucide-react";
import { PageHeader } from "../../components/page-header";
import { UPCOMING, type UpcomingFeature } from "./upcoming";

/**
 * Placeholder page for a section that ships in a later phase.
 *
 * @param props - Which section this is.
 * @returns The placeholder.
 */
export function ComingSoon({ feature }: { feature: UpcomingFeature }) {
  const copy = UPCOMING[feature];
  return (
    <>
      <PageHeader title={copy.title} />
      <EmptyState
        icon={<SparklesIcon />}
        eyebrow={copy.phase}
        title={`${copy.title} is on the way`}
        description={copy.body}
        className="py-20"
      />
    </>
  );
}
