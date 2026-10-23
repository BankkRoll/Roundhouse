import type { ServicePageProps } from "../service-layout";
import { DomainsSection } from "./domains-section";

/**
 * A service's domains: the same section Settings shows, on its own tab.
 *
 * @param props - Workspace, project and service ids.
 * @returns The tab.
 */
export function DomainsTab(props: ServicePageProps) {
  return (
    <div className="max-w-[50rem]">
      <DomainsSection {...props} />
    </div>
  );
}
