/**
 * Wire types for the cloud provider routes (integrations, offers, one-click provisioning),
 * derived from the API's route definitions (`apps/api/src/contracts/providers.ts`) so the
 * dashboard cannot drift from them.
 *
 * Type-only: nothing from the API source reaches the bundle.
 *
 * @module
 */
import type {
  BodyOf,
  getIntegration,
  getNodeProvision,
  listProviderOffers,
  provisionNode,
  ResponseOf,
} from "../../../../api/src/contracts";

/** A workspace's connection to one provider. Never carries the token itself. */
export type ProviderIntegration = ResponseOf<typeof getIntegration, 200>;
/** `GET …/providers/{provider}/offers` response: priced offers and the recommended picks. */
export type ProviderOffers = ResponseOf<typeof listProviderOffers, 200>;
/** One orderable plan in one region. */
export type ProviderOffer = ProviderOffers["offers"][number];
/** A suggested offer and why. */
export type OfferRecommendation = ProviderOffers["recommendations"][number];
/** Role an offer list is filtered for. */
export type OfferRole = ProviderOffers["role"];
/** `POST …/nodes/provision` body. */
export type ProvisionNodeBody = BodyOf<typeof provisionNode>;
/** One one-click provisioning run. */
export type NodeProvision = ResponseOf<typeof getNodeProvision, 200>;
/** State of a provisioning run. */
export type NodeProvisionStatus = NodeProvision["status"];
