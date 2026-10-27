/**
 * Query hooks for the instance's registry storage (ADR 0005).
 *
 * @module
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RegistryStorageBody, registryApi } from "../lib/api/registry-client";

/** Cache key of the registry storage. */
export const registryKeys = { storage: ["instance", "registry-storage"] as const };

/**
 * Where builds are stored.
 *
 * @param enabled - Fetch only for instance admins.
 * @returns The query.
 */
export function useRegistryStorage(enabled = true) {
  return useQuery({
    queryKey: registryKeys.storage,
    queryFn: ({ signal }) => registryApi.get(signal),
    enabled,
  });
}

/**
 * Sets the registry bucket and caches the result.
 *
 * @returns A mutation taking the storage body.
 */
export function useSaveRegistryStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RegistryStorageBody) => registryApi.put(body),
    onSuccess: (storage) => queryClient.setQueryData(registryKeys.storage, storage),
  });
}

/**
 * Moves builds back to each builder's disk.
 *
 * @returns The mutation.
 */
export function useRemoveRegistryStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => registryApi.remove(),
    onSuccess: (storage) => queryClient.setQueryData(registryKeys.storage, storage),
  });
}
