import { useCallback, useEffect, useRef, useState } from "react";
import type { Event, Run } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "Idempotency-Key": key ?? crypto.randomUUID(),
            "X-Pi-Console": "1",
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/console/login")
      window.dispatchEvent(new CustomEvent("pi:unauthorized"));
    throw new ApiError(
      value.error?.message ?? "The request failed",
      response.status,
      value.error?.code,
    );
  }
  return value as T;
}
export function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setData(undefined);
    setError("");
    api<T>(path)
      .then((value) => {
        if (current) setData(value);
      })
      .catch((error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [path, revision]);
  return { data, error, reload, setData };
}
// Keep the same idempotency key when a user retries an uncertain response.
// A successful request ends the attempt; the next intentional action is new.
export function useMutation() {
  const attempts = useRef(new Map<string, string>());
  return useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    const identity = path + JSON.stringify(body);
    const key = attempts.current.get(identity) ?? crypto.randomUUID();
    attempts.current.set(identity, key);
    const result = await api<T>(path, body, key);
    attempts.current.delete(identity);
    return result;
  }, []);
}
export async function allRuns(session: string): Promise<Run[]> {
  const runs: Run[] = [];
  let after: string | null = null;
  do {
    const page: { data: Run[]; next_cursor: string | null } = await api(
      `/v1/sessions/${session}/runs${after ? "?after=" + after : ""}`,
    );
    runs.push(...page.data);
    after = page.next_cursor;
  } while (after);
  return runs;
}
export async function allEvents(session: string): Promise<Event[]> {
  const events: Event[] = [];
  let after = "0";
  while (true) {
    const page = await api<{ data: Event[]; next_cursor: string }>(
      `/v1/sessions/${session}/events?after=${after}`,
    );
    events.push(...page.data);
    if (page.data.length < 100) return events;
    after = page.next_cursor;
  }
}

// A single reconnecting stream replays from the last committed sequence. HTTP
// errors stay visible, and unmount aborts both the reader and its retry timer.
export async function watchEvents(
  session: string,
  signal: AbortSignal,
  receive: (event: Event) => void,
  status: (status: "live" | "connecting" | "reconnecting") => void,
) {
  let cursor = "0";
  while (!signal.aborted) {
    try {
      const response = await fetch(
        `/v1/sessions/${session}/events?stream=true&after=${cursor}`,
        { signal, credentials: "same-origin" },
      );
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent("pi:unauthorized"));
        return;
      }
      if (!response.ok || !response.body)
        throw new Error("Event stream unavailable");
      status("live");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const payload = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!payload) continue;
            const event = JSON.parse(payload) as Event;
            if (BigInt(event.seq) > BigInt(cursor)) {
              cursor = event.seq;
              receive(event);
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    status("reconnecting");
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, 2000);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
export function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const navigate = (path: string) => {
  window.location.hash = path;
};
export const shortId = (id: string) => id.slice(0, 4) + "…" + id.slice(-8);
export const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export const duration = (start?: string | null, end?: string | null) =>
  start
    ? (
        (new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) /
        1000
      ).toFixed(1) + "s"
    : "—";
export const pending = (status: string) =>
  ["queued", "running", "waiting", "cancelling"].includes(status);
