import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "./query-client";
import { useCachedQueryData } from "./use-cached-query-data";

describe("useCachedQueryData", () => {
  it("follows the cache without observing, so it can't replace the query's queryFn", async () => {
    const queryClient = createQueryClient({ retry: false });
    const queryFn = vi.fn().mockResolvedValue({ name: "fresh" });
    queryClient.setQueryData(["thing"], { name: "cached" });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCachedQueryData<{ name: string }>(["thing"]), {
      wrapper,
    });
    expect(result.current).toEqual({ name: "cached" });
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: ["thing"] })
        ?.getObserversCount(),
    ).toBe(0);

    await act(() => queryClient.fetchQuery({ queryKey: ["thing"], queryFn, staleTime: 0 }));
    expect(result.current).toEqual({ name: "fresh" });
    expect(queryFn).toHaveBeenCalledOnce();
    expect(renderHook(() => useCachedQueryData(["missing"]), { wrapper }).result.current).toBe(
      undefined,
    );
  });
});
