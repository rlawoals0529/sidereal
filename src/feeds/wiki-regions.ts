/**
 * Where a Wikimedia edit gets drawn, and why that is not where the editor was.
 *
 * A recentchange record carries no location. Not a coarse one, not an IP-derived one, none.
 * So the honest options are to leave the largest feed out of the sky entirely, or to place
 * each edit by something we do know about it and label that clearly. This file is the
 * second option: a wiki's language edition has a primary region, that is real published
 * metadata about the wiki, and every event placed from this table is stamped
 * `placement: "regional"` so the panel can say what it is looking at.
 *
 * Two things about this table are easy to get wrong.
 *
 * **A point here is the language's home region, not a population centroid and not a claim
 * about any editor.** `en` sits on the United Kingdom because that is where English comes
 * from, not because English Wikipedia is edited from there; most of it is not. `en`, `es`,
 * `pt`, `fr`, `ru` and `ar` are the weakest rows in the table for exactly that reason, and
 * they are also the busiest. The `regional` stamp is doing real work on those rows and the
 * UI must not drop it.
 *
 * **A missing row means the event is dropped, not defaulted.** See `regionForWikiDomain`.
 */

export type WikiRegion = {
  lat: number;
  lon: number;
  /** Named region, for the panel. This is the thing we are actually asserting. */
  name: string;
};

/**
 * Keyed by the full first label of the domain, `ja` from `ja.wikipedia.org`.
 *
 * Hyphenated editions are listed in full rather than folded onto their prefix. Folding
 * looks tidy and is wrong: `zh-yue` is Cantonese and belongs on Guangdong, not on the
 * point used for `zh`. If an edition is not listed it is not guessed at.
 *
 * Deliberately absent, and these are the interesting absences rather than an oversight:
 * `eo`, `ia`, `io`, `vo` and `la`. Esperanto, Interlingua, Ido, Volapuk and Latin are
 * constructed or historical and have no living primary region, so there is no fact to
 * place them by. They take the same path as an unrecognised domain.
 */
export const WIKI_REGIONS: Readonly<Record<string, WikiRegion>> = {
  // Europe
  en: { lat: 54.0, lon: -2.0, name: "United Kingdom" },
  simple: { lat: 54.0, lon: -2.0, name: "United Kingdom (Simple English)" },
  de: { lat: 51.2, lon: 10.4, name: "Germany" },
  nds: { lat: 53.4, lon: 9.9, name: "Northern Germany" },
  fr: { lat: 46.6, lon: 2.4, name: "France" },
  br: { lat: 48.2, lon: -3.0, name: "Brittany" },
  oc: { lat: 44.0, lon: 2.5, name: "Occitania" },
  co: { lat: 42.2, lon: 9.1, name: "Corsica" },
  es: { lat: 40.4, lon: -3.7, name: "Spain" },
  ca: { lat: 41.8, lon: 1.5, name: "Catalonia" },
  eu: { lat: 43.0, lon: -2.5, name: "Basque Country" },
  gl: { lat: 42.7, lon: -8.0, name: "Galicia" },
  ast: { lat: 43.3, lon: -6.0, name: "Asturias" },
  an: { lat: 41.6, lon: -0.9, name: "Aragon" },
  it: { lat: 42.8, lon: 12.6, name: "Italy" },
  scn: { lat: 37.6, lon: 14.0, name: "Sicily" },
  nap: { lat: 40.9, lon: 14.3, name: "Naples" },
  vec: { lat: 45.5, lon: 11.9, name: "Veneto" },
  lmo: { lat: 45.6, lon: 9.7, name: "Lombardy" },
  pms: { lat: 45.1, lon: 7.9, name: "Piedmont" },
  sc: { lat: 40.1, lon: 9.0, name: "Sardinia" },
  "roa-tara": { lat: 40.5, lon: 17.2, name: "Taranto" },
  pt: { lat: 39.5, lon: -8.0, name: "Portugal" },
  nl: { lat: 52.2, lon: 5.3, name: "Netherlands" },
  "nds-nl": { lat: 52.7, lon: 6.5, name: "Low Saxon Netherlands" },
  fy: { lat: 53.1, lon: 5.8, name: "Friesland" },
  li: { lat: 51.2, lon: 5.9, name: "Limburg" },
  lb: { lat: 49.8, lon: 6.1, name: "Luxembourg" },
  ga: { lat: 53.2, lon: -8.0, name: "Ireland" },
  cy: { lat: 52.4, lon: -3.7, name: "Wales" },
  gd: { lat: 57.0, lon: -4.5, name: "Scotland" },
  mt: { lat: 35.9, lon: 14.4, name: "Malta" },
  is: { lat: 65.0, lon: -18.0, name: "Iceland" },
  sv: { lat: 62.0, lon: 15.0, name: "Sweden" },
  no: { lat: 61.0, lon: 9.0, name: "Norway" },
  nb: { lat: 61.0, lon: 9.0, name: "Norway" },
  nn: { lat: 61.0, lon: 9.0, name: "Norway" },
  da: { lat: 56.0, lon: 10.0, name: "Denmark" },
  fi: { lat: 64.0, lon: 26.0, name: "Finland" },
  et: { lat: 58.6, lon: 25.0, name: "Estonia" },
  "fiu-vro": { lat: 57.8, lon: 26.9, name: "Voru, Estonia" },
  lv: { lat: 56.9, lon: 24.6, name: "Latvia" },
  lt: { lat: 55.2, lon: 23.9, name: "Lithuania" },
  "bat-smg": { lat: 55.9, lon: 22.3, name: "Samogitia, Lithuania" },
  pl: { lat: 52.0, lon: 19.1, name: "Poland" },
  cs: { lat: 49.8, lon: 15.5, name: "Czechia" },
  sk: { lat: 48.7, lon: 19.7, name: "Slovakia" },
  hu: { lat: 47.2, lon: 19.5, name: "Hungary" },
  ro: { lat: 45.9, lon: 25.0, name: "Romania" },
  bg: { lat: 42.7, lon: 25.5, name: "Bulgaria" },
  el: { lat: 39.0, lon: 22.0, name: "Greece" },
  sr: { lat: 44.0, lon: 21.0, name: "Serbia" },
  sh: { lat: 44.0, lon: 18.0, name: "Western Balkans" },
  hr: { lat: 45.1, lon: 15.5, name: "Croatia" },
  bs: { lat: 44.0, lon: 18.0, name: "Bosnia and Herzegovina" },
  sl: { lat: 46.1, lon: 14.8, name: "Slovenia" },
  mk: { lat: 41.6, lon: 21.7, name: "North Macedonia" },
  sq: { lat: 41.2, lon: 20.1, name: "Albania" },
  ru: { lat: 55.8, lon: 37.6, name: "Russia" },
  uk: { lat: 49.0, lon: 31.5, name: "Ukraine" },
  be: { lat: 53.7, lon: 27.9, name: "Belarus" },
  "be-tarask": { lat: 53.7, lon: 27.9, name: "Belarus" },
  hy: { lat: 40.1, lon: 45.0, name: "Armenia" },
  ka: { lat: 42.0, lon: 43.5, name: "Georgia" },
  ce: { lat: 43.4, lon: 45.7, name: "Chechnya" },
  tt: { lat: 55.8, lon: 49.1, name: "Tatarstan" },
  ba: { lat: 54.7, lon: 56.0, name: "Bashkortostan" },

  // Middle East, Central and South Asia
  he: { lat: 31.5, lon: 34.9, name: "Israel" },
  ar: { lat: 24.7, lon: 46.7, name: "Arabian Peninsula" },
  arz: { lat: 26.8, lon: 30.8, name: "Egypt" },
  fa: { lat: 32.5, lon: 53.7, name: "Iran" },
  ku: { lat: 37.0, lon: 43.5, name: "Kurdistan" },
  ckb: { lat: 35.6, lon: 45.4, name: "Sorani Kurdistan" },
  ps: { lat: 33.9, lon: 67.7, name: "Afghanistan" },
  ur: { lat: 30.4, lon: 69.3, name: "Pakistan" },
  sd: { lat: 26.0, lon: 68.9, name: "Sindh" },
  az: { lat: 40.3, lon: 47.8, name: "Azerbaijan" },
  kk: { lat: 48.0, lon: 67.0, name: "Kazakhstan" },
  uz: { lat: 41.4, lon: 64.6, name: "Uzbekistan" },
  ky: { lat: 41.2, lon: 74.8, name: "Kyrgyzstan" },
  tg: { lat: 38.9, lon: 71.3, name: "Tajikistan" },
  tk: { lat: 39.0, lon: 59.6, name: "Turkmenistan" },
  tr: { lat: 39.0, lon: 35.0, name: "Turkiye" },
  mn: { lat: 46.9, lon: 103.8, name: "Mongolia" },
  hi: { lat: 22.0, lon: 79.0, name: "India" },
  sa: { lat: 22.0, lon: 79.0, name: "India" },
  bho: { lat: 25.6, lon: 85.1, name: "Bihar" },
  bn: { lat: 23.7, lon: 90.4, name: "Bangladesh" },
  ta: { lat: 11.1, lon: 78.7, name: "Tamil Nadu" },
  te: { lat: 16.5, lon: 79.7, name: "Andhra Pradesh" },
  ml: { lat: 10.5, lon: 76.3, name: "Kerala" },
  kn: { lat: 15.3, lon: 75.7, name: "Karnataka" },
  mr: { lat: 19.5, lon: 75.5, name: "Maharashtra" },
  gu: { lat: 22.3, lon: 71.2, name: "Gujarat" },
  pa: { lat: 31.1, lon: 75.3, name: "Punjab" },
  or: { lat: 20.5, lon: 84.8, name: "Odisha" },
  as: { lat: 26.2, lon: 92.9, name: "Assam" },
  ne: { lat: 28.4, lon: 84.1, name: "Nepal" },
  si: { lat: 7.9, lon: 80.8, name: "Sri Lanka" },

  // East and Southeast Asia
  zh: { lat: 35.0, lon: 105.0, name: "China" },
  "zh-classical": { lat: 35.0, lon: 105.0, name: "China" },
  "zh-yue": { lat: 22.4, lon: 114.1, name: "Guangdong and Hong Kong" },
  "zh-min-nan": { lat: 23.7, lon: 120.9, name: "Taiwan and Fujian" },
  wuu: { lat: 31.2, lon: 121.5, name: "Shanghai and Jiangnan" },
  ja: { lat: 36.2, lon: 138.3, name: "Japan" },
  ko: { lat: 36.5, lon: 127.9, name: "Korea" },
  vi: { lat: 16.0, lon: 107.8, name: "Vietnam" },
  th: { lat: 15.1, lon: 101.0, name: "Thailand" },
  lo: { lat: 18.2, lon: 103.9, name: "Laos" },
  km: { lat: 12.6, lon: 104.9, name: "Cambodia" },
  my: { lat: 21.0, lon: 96.0, name: "Myanmar" },
  id: { lat: -2.5, lon: 118.0, name: "Indonesia" },
  jv: { lat: -7.3, lon: 110.4, name: "Java" },
  su: { lat: -6.9, lon: 107.6, name: "West Java" },
  "map-bms": { lat: -7.4, lon: 109.2, name: "Banyumas, Java" },
  ms: { lat: 4.2, lon: 102.0, name: "Malaysia" },
  tl: { lat: 12.9, lon: 122.0, name: "Philippines" },
  ceb: { lat: 10.3, lon: 123.9, name: "Cebu, Philippines" },
  war: { lat: 11.8, lon: 125.0, name: "Samar, Philippines" },

  // Africa
  sw: { lat: -6.0, lon: 35.0, name: "Swahili coast" },
  am: { lat: 9.1, lon: 40.5, name: "Ethiopia" },
  ti: { lat: 15.2, lon: 39.0, name: "Eritrea" },
  so: { lat: 5.2, lon: 46.2, name: "Somalia" },
  ha: { lat: 11.5, lon: 8.5, name: "Northern Nigeria" },
  yo: { lat: 7.4, lon: 3.9, name: "Southwest Nigeria" },
  ig: { lat: 6.0, lon: 7.4, name: "Southeast Nigeria" },
  wo: { lat: 14.5, lon: -14.5, name: "Senegal" },
  ln: { lat: -2.9, lon: 23.6, name: "Congo basin" },
  rw: { lat: -1.9, lon: 29.9, name: "Rwanda" },
  mg: { lat: -18.8, lon: 46.9, name: "Madagascar" },
  af: { lat: -29.0, lon: 24.0, name: "South Africa" },
  zu: { lat: -28.5, lon: 30.9, name: "KwaZulu-Natal" },
  xh: { lat: -32.3, lon: 27.0, name: "Eastern Cape" },
  kab: { lat: 36.6, lon: 4.1, name: "Kabylia" },

  // Americas and Oceania
  ht: { lat: 19.0, lon: -72.3, name: "Haiti" },
  qu: { lat: -13.5, lon: -71.9, name: "Quechua Andes" },
  ay: { lat: -16.5, lon: -68.1, name: "Aymara altiplano" },
  gn: { lat: -23.4, lon: -58.4, name: "Paraguay" },
  nah: { lat: 19.4, lon: -99.1, name: "Central Mexico" },
  mi: { lat: -41.0, lon: 174.0, name: "New Zealand" },
  haw: { lat: 20.8, lon: -156.3, name: "Hawaii" },
  sm: { lat: -13.8, lon: -172.1, name: "Samoa" },
  to: { lat: -21.2, lon: -175.2, name: "Tonga" },
  fj: { lat: -17.7, lon: 178.0, name: "Fiji" },
};

/**
 * The region for a wiki domain, or `null` when we have no fact to place it by.
 *
 * `null` means the caller drops the event. That decision is argued in `wiki.ts`, because it
 * is a decision about the feed and not about this table.
 *
 * Note what is NOT here: there is no prefix fallback. `zh-yue.wikipedia.org` is not quietly
 * served the `zh` row, and `test.wikidata.org` is not quietly served anything. A fallback
 * that fires on an unrecognised input is a guess wearing the same badge as a lookup, and
 * once one exists nobody can tell from a rendered sky which rows were guessed.
 */
export function regionForWikiDomain(domain: string): WikiRegion | null {
  const firstLabel = domain.split(".")[0];
  if (firstLabel === undefined) return null;
  return WIKI_REGIONS[firstLabel.toLowerCase()] ?? null;
}
