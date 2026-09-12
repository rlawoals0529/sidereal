/**
 * The Cloudflare runtime surface this slice touches, declared by hand.
 *
 * Normally this is `@cloudflare/workers-types` and one line in `tsconfig.json`. Neither is
 * mine to add here, so instead of a dependency this is a hand-written declaration of
 * exactly the API used and nothing else. Two things follow from that and are worth knowing
 * before editing:
 *
 * - It is not the full runtime. Reaching for a platform API that is not declared here is a
 *   type error rather than an implicit `any`, which is the behaviour we want: it forces the
 *   declaration to stay an honest record of what is actually used.
 * - It merges with the DOM lib rather than replacing it. `WebSocket`, `Response` and
 *   `crypto` come from DOM and are augmented below where the Workers versions differ.
 *
 * Replace the whole file with `@cloudflare/workers-types` the moment a dependency can be
 * added. See `DEPS.md`.
 */
export {};

declare global {
  interface WebSocket {
    /** Persists a value alongside the socket so it survives a hibernation. Max 16 KB. */
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
  }

  /** `new WebSocketPair()` yields `{0: client, 1: server}`. Typed as indices rather than
   *  via `Object.values`, which loses the tuple order that the whole thing depends on. */
  class WebSocketPair {
    readonly 0: WebSocket;
    readonly 1: WebSocket;
  }

  class WebSocketRequestResponsePair {
    constructor(request: string, response: string);
    getRequest(): string;
    getResponse(): string;
  }

  /** Workers lets a 101 response carry the client half of the pair. */
  interface ResponseInit {
    webSocket?: WebSocket | null;
  }

  interface DurableObjectId {
    toString(): string;
  }

  interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTimeMs: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  }

  interface DurableObjectState {
    readonly id: DurableObjectId;
    readonly storage: DurableObjectStorage;
    /** Hands the socket to the runtime so the object may hibernate while it stays open. */
    acceptWebSocket(ws: WebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): WebSocket[];
    setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
    getWebSocketAutoResponse(): WebSocketRequestResponsePair | null;
    getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  }

  interface DurableObjectStub {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  }

  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}
