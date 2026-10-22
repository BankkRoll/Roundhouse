import { toast } from "@openrail/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { queryKeys } from "../../queries/keys";
import { applyRealtimeMessage } from "../../queries/realtime";
import { api, isApiError } from "../api/client";
import type { PresenceUser, RealtimeLogLines, RealtimeTopic } from "../api/deploy-types";
import { endSession } from "../session";
import { RealtimeClient, type RealtimeSocket, type RealtimeStatus, realtimeUrl } from "./client";

/** What {@link useRealtime} exposes to a project's pages. */
export interface RealtimeContextValue {
  status: RealtimeStatus;
  /** People viewing the project now, as last reported by the server. */
  presence: PresenceUser[];
  /**
   * Subscribes to a log topic on the shared socket.
   *
   * @returns Unsubscribe function.
   */
  subscribeLogs: (
    topic: RealtimeTopic,
    listener: (message: RealtimeLogLines) => void,
  ) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/** Props for {@link RealtimeProvider}. */
export interface RealtimeProviderProps {
  projectId: string;
  children: ReactNode;
  /** Socket factory override (tests). */
  createSocket?: (url: string) => RealtimeSocket;
}

async function sessionIsValid(): Promise<boolean> {
  try {
    await api.getMe();
    return true;
  } catch (error) {
    // NOTE: Only a definite 401 ends the session; a network blip just means "retry".
    return !isApiError(error, 401);
  }
}

/**
 * Holds one realtime socket for a project while any of its pages is open. Messages
 * update the query caches directly; log lines go to subscribers via
 * {@link useLogSubscription}. When the API refuses the socket because the session
 * ended, the user is sent to sign in.
 *
 * @param props - Project id, children and an optional socket factory.
 * @returns The provider.
 */
export function RealtimeProvider({ projectId, children, createSocket }: RealtimeProviderProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const latest = useRef({ queryClient, router });
  latest.current = { queryClient, router };

  // NOTE: Created during render (not in an effect) so child pages can subscribe to log
  // topics in their own effects, which run before this component's.
  const client = useMemo(
    () =>
      new RealtimeClient({
        url: realtimeUrl(projectId),
        createSocket,
        onStatus: setStatus,
        onMessage: (message) => {
          if (message.type === "presence") setPresence(message.users);
          else applyRealtimeMessage(latest.current.queryClient, message);
        },
        checkSession: sessionIsValid,
        onSessionExpired: () => endSession(latest.current.queryClient, latest.current.router),
        onForbidden: () => {
          const { queryClient: client, router: current } = latest.current;
          toast({
            title: "You no longer have access to this project",
            description: "Your membership in its workspace was removed.",
            tone: "error",
          });
          void client.invalidateQueries({ queryKey: queryKeys.me });
          void current.navigate({ to: "/dashboard" });
        },
      }),
    [projectId, createSocket],
  );

  useEffect(() => {
    client.connect();
    const online = () => client.reconnectNow();
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("online", online);
      client.close();
      setPresence([]);
    };
  }, [client]);

  const subscribeLogs = useCallback<RealtimeContextValue["subscribeLogs"]>(
    (topic, listener) => client.subscribeLogs(topic, listener),
    [client],
  );
  const value = useMemo<RealtimeContextValue>(
    () => ({ status, presence, subscribeLogs }),
    [status, presence, subscribeLogs],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/**
 * Reads the project's realtime state.
 *
 * @returns Status, presence and log subscription, or `null` outside a project.
 */
export function useRealtime(): RealtimeContextValue | null {
  return useContext(RealtimeContext);
}

/**
 * Streams log lines for a topic while mounted. The listener may change between renders
 * without resubscribing.
 *
 * @param topic - Topic to follow, or `null` to follow nothing.
 * @param onLines - Receives each batch of lines.
 */
export function useLogSubscription(
  topic: RealtimeTopic | null,
  onLines: (message: RealtimeLogLines) => void,
): void {
  const subscribe = useRealtime()?.subscribeLogs;
  const listener = useRef(onLines);
  listener.current = onLines;
  const key = topic ? JSON.stringify(topic) : null;

  useEffect(() => {
    if (!key || !subscribe) return;
    return subscribe(JSON.parse(key) as RealtimeTopic, (message) => listener.current(message));
  }, [key, subscribe]);
}
