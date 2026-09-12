/**
 * The wire between one browser and the one Durable Object that owns a sky.
 *
 * Two properties are load-bearing and easy to lose later, so they are stated here rather
 * than discovered from the code:
 *
 * **Events arrive batched, presence arrives immediately.** A sky takes on the order of a
 * hundred edits a second. Sending each as its own frame would spend the whole budget on
 * framing, so world events are coalesced into one `events` message per tick. A person
 * joining or leaving is rare and is the thing a viewer is most likely to be looking at,
 * so those go out the moment they happen.
 *
 * **The server never sends the full sky twice.** `welcome` carries the current state once;
 * everything after it is a delta. A client that wants to resynchronise reconnects. This is
 * what keeps a long idle session from costing anything, which matters because the whole
 * point of this thing is that you leave it open.
 */
import type { SkyEvent } from "./event.ts";

/** Someone in the sky, as everyone else sees them. No account needed to be here. */
export type Presence = {
  /** Assigned by the server. Never the connection id, which would leak reconnects. */
  id: string;
  /** Which yozora palette they are under. Their star is drawn in their own accent. */
  palette: string;
  /** Where they are looking, in degrees. Drives the faint direction-of-gaze cue. */
  az: number;
  alt: number;
  /** True while they are in a focus session. A focused star holds; an idle one drifts. */
  focused: boolean;
  /** When they arrived, epoch ms. Older lights sit slightly steadier. */
  since: number;
};

export type ClientMessage =
  | { t: "hello"; palette: string }
  | { t: "look"; az: number; alt: number }
  | { t: "focus"; on: boolean };

export type ServerMessage =
  /** Sent once, on connect. The only message that carries whole state. */
  | { t: "welcome"; you: string; others: Presence[]; serverNow: number }
  | { t: "join"; who: Presence }
  | { t: "leave"; id: string }
  | { t: "move"; id: string; az: number; alt: number }
  | { t: "focus"; id: string; on: boolean }
  /** One tick of the world. May be empty; an empty tick is still a heartbeat. */
  | { t: "events"; batch: SkyEvent[]; serverNow: number };
