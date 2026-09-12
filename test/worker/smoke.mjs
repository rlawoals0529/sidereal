/**
 * The four things the pure-class tests cannot reach, checked against a real runtime.
 *
 * `test/worker/room.test.ts` tests every decision the server makes, and it does that against a
 * plain class because installing a workers test pool this repo does not declare would be green
 * here and red on a clean install. What that leaves untested is not decisions, it is runtime
 * obligations: that the upgrade actually happens, that the socket we hand back is the client
 * half, that an attachment survives the object being rebuilt underneath it, and that the alarm
 * really fires. None of those can be reasoned about, so they are driven here instead.
 *
 * Run against a live `wrangler dev`. Not part of `npm test`, because it needs a server.
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8799";
const TOKEN = process.env.INGEST_TOKEN ?? "smoke-token-local-only";
const WS = BASE.replace(/^http/, "ws") + "/sky";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

/** Open a socket and collect frames until `done(frames)` is satisfied or the deadline passes. */
function listen(done, ms = 6000, onOpen) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const frames = [];
    const timer = setTimeout(() => {
      ws.close();
      resolve({ frames, timedOut: true, ws });
    }, ms);
    ws.addEventListener("open", () => onOpen?.(ws));
    ws.addEventListener("message", (e) => {
      try {
        frames.push(JSON.parse(e.data));
      } catch {
        frames.push({ t: "unparseable", raw: String(e.data).slice(0, 80) });
      }
      if (done(frames)) {
        clearTimeout(timer);
        resolve({ frames, timedOut: false, ws });
      }
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error("socket error: " + (e?.message ?? "unknown")));
    });
  });
}

const has = (frames, t) => frames.some((f) => f.t === t);

// 1 and 2. The upgrade happens and the half we were handed is the client half, which is only
// provable by receiving something the server sent on it.
const first = await listen((f) => has(f, "welcome"), 8000, (ws) =>
  ws.send(JSON.stringify({ t: "hello", palette: "twilight-comet" })),
);
const welcome = first.frames.find((f) => f.t === "welcome");
check("the upgrade completes and the client half receives", Boolean(welcome));
check("welcome carries an id and a server clock", Boolean(welcome?.you) && Number.isFinite(welcome?.serverNow));

// 3. Two sockets, and the second must be told about the first. This is the attachment surviving
// a real round trip through the runtime rather than living in a closure.
const a = new WebSocket(WS);
await new Promise((r) => a.addEventListener("open", r));
a.send(JSON.stringify({ t: "hello", palette: "twilight-comet" }));
await new Promise((r) => setTimeout(r, 400));
const second = await listen((f) => has(f, "welcome"), 6000, (ws) =>
  ws.send(JSON.stringify({ t: "hello", palette: "starfall-dusk" })),
);
const w2 = second.frames.find((f) => f.t === "welcome");
check("a second visitor is told who is already here", (w2?.others?.length ?? 0) >= 1,
  `others=${w2?.others?.length ?? 0}`);

// A leave has to reach the survivor, which means the eviction path read the attachment back.
const leaveSeen = listen((f) => has(f, "leave"), 6000, (ws) =>
  ws.send(JSON.stringify({ t: "hello", palette: "twilight-comet" })));
await new Promise((r) => setTimeout(r, 500));
a.close();
const leftFrames = await leaveSeen;
check("a departure reaches the visitors who stayed", has(leftFrames.frames, "leave"));

// 4. The alarm fires, which is what drives the feeds. Proof is an events frame arriving without
// anyone having pushed one, on a socket that just sits there.
const ticked = await listen((f) => has(f, "events"), 20000, (ws) =>
  ws.send(JSON.stringify({ t: "hello", palette: "twilight-comet" })));
const batch = ticked.frames.filter((f) => f.t === "events");
check("the alarm fires and the room ticks on its own", batch.length > 0, `frames=${batch.length}`);
const live = batch.flatMap((f) => f.batch ?? []);
check("the tick carries real events from the live feeds", live.length > 0, `events=${live.length}`);
if (live.length) {
  const kinds = [...new Set(live.map((e) => e.kind))];
  console.log(`      kinds seen: ${kinds.join(", ")}`);
  console.log(`      sample: ${JSON.stringify(live[0]).slice(0, 150)}`);
}

// Auth fails closed, checked rather than assumed.
const noAuth = await fetch(`${BASE}/stats`);
check("stats refuses an unauthenticated caller", noAuth.status === 401 || noAuth.status === 403,
  `status=${noAuth.status}`);
const withAuth = await fetch(`${BASE}/stats`, { headers: { authorization: `Bearer ${TOKEN}` } });
check("stats answers an authenticated one", withAuth.ok, `status=${withAuth.status}`);
if (withAuth.ok) console.log("      " + (await withAuth.text()).slice(0, 200));

console.log(failures === 0 ? "\nall smoke checks passed" : `\n${failures} smoke check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
