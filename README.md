# sidereal

A night sky you leave open while you work. Everything in it is real.

Meteors are Wikipedia edits, one per edit, arriving at the rate people actually make them.
The slow rings are earthquakes, at their true coordinates, sized by what the seismograph
said. The one moving point that is the same point frame to frame is the ISS, on its real
track. The band near the pole is the aurora, at the probability NOAA is forecasting right
now. And the steady lights are other people who have it open too.

The sky turns at the real sidereal rate, one revolution every 23h56m04s, so an event on
the far side of the planet is genuinely below your horizon until the world brings it round.
That is why it is worth leaving open. It is a clock you can look at.

## The rule

**Every light traces to a measured event. Nothing here is decorative.**

If something moves, something happened. There are no ambient particles, no glow added
because the frame looked empty. A renderer that emits a light with no backing event fails
a test, by name.

This is the same rule that runs [pc-audit](https://github.com/rlawoals0529/pc-audit),
moved from numbers to pixels: never print what you did not measure.

## Where things are placed, and the one place we guess

Earthquakes, the ISS and the aurora carry true coordinates, straight from the source.

A Wikipedia edit does not. Nothing in the feed says where the editor was sitting, and
inventing a coordinate would be a lie drawn at sixty frames a second. So an edit is placed
by its language edition's primary region, which is real metadata about the wiki rather than
a claim about a person, and every meteor's panel says exactly that when you ask it.

## Feeds

| Source | Becomes |
|---|---|
| [Wikimedia EventStreams](https://stream.wikimedia.org/v2/stream/recentchange) | meteors |
| [USGS earthquake feed](https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson) | ground pulses |
| [wheretheiss.at](https://api.wheretheiss.at/v1/satellites/25544) | the station |
| [NOAA OVATION](https://services.swpc.noaa.gov/json/ovation_aurora_latest.json) | the auroral band |

No API keys. Nothing here costs anyone money to serve.

## Built with

Cloudflare Workers and a Durable Object for the shared room, chosen because Durable Objects
hold WebSockets with no cold start, and a page that makes you wait forty seconds for a
sleeping server is a page nobody sees twice. WebGL for the sky.
[yozora](https://github.com/rlawoals0529/yozora) for the palettes, all fifteen of them.
