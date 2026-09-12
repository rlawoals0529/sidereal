# sidereal

A night sky you leave open while you work. Everything in it is real.

## Design read

An ambient, real-time companion for people at a desk, with an observatory language,
leaning toward native CSS plus WebGL over yozora's night palettes.

    DESIGN_VARIANCE 8   MOTION_INTENSITY 7   VISUAL_DENSITY 3

## The one rule

**Every light traces to a measured event. Nothing here is decorative.**

If something moves, something happened. If a star is dim, it is dim because the thing it
stands for is small or old or far away, and the panel will say which. This is the same rule
pc-audit runs on, applied to pixels instead of numbers: no light that is not earned.

The rule has teeth. A renderer that emits a particle with no backing event fails a test.

## Three layers, all real

**The world.** Live public feeds become celestial phenomena.

| Feed | Becomes | Cadence |
|---|---|---|
| Wikimedia EventStreams (SSE) | meteors, one per edit | continuous, ~100/sec globally |
| USGS earthquakes (GeoJSON) | slow deep pulses at true coordinates | minutes |
| ISS position | a satellite on its real track | 1 Hz |
| NOAA OVATION aurora | the auroral band, at real intensity | ~5 min |

**The people.** Every other visitor right now is a light in the same sky, over one
WebSocket into one Durable Object. You see them, they see you.

**You.** The daily reason. Start a focus session and your star ignites and holds steady
while the drifting ones stay in motion. The session is timed by the sky itself, which
rotates at real sidereal rate. Streaks persist.

## Honesty about placement

Earthquakes, the ISS and the aurora carry true coordinates from their source.

Wikipedia edits do not. An edit is placed by the **language edition's primary region**,
which is real metadata about the wiki, not a claim about where the editor was sitting.
Every meteor's panel says so. We do not have that measurement, so we do not print it.

## What this is not

Not a dashboard. There is no chart, no KPI, no number pinned to a corner unless you ask
a specific light what it is. The information is in the sky's behaviour.
