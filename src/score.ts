// Chrollo scoring — TF-saturation with length normalization. This is BM25
// with the IDF (rare-term) term INTENTIONALLY DROPPED.
//
// Why no IDF: the rare-term boost requires a global dictionary of how often
// each word appears across the whole corpus — building it means scanning every
// line of every session (~13s over 267 files / 28k lines), which freezes the
// UI on every search. The user already chose the search words, so the system
// re-deriving "which word is rare" pays a 13s tax for a judgment the user
// already made. Dropped permanently — see SPEC §3.3.
//
// What survives from BM25: saturation (5 hits < 5× a 1-hit score) and length
// normalization (a hit in a short line beats a hit in a long one). These need
// no global state — only the candidate's own token count and a local average
// line length computed from the candidate set.

const K1 = 1.5; // saturation rate
const B = 0.75; // length-normalization strength

// Saturated, length-normalized term frequency for ONE query term in ONE line.
// Callers sum this across the query terms present in the line.
//
//   termFreq - times the term appears in the candidate line
//   lineLen  - token length of the candidate line
//   avgLen   - average line length across the candidate set (computed locally)
export function tfSaturation(termFreq: number, lineLen: number, avgLen: number): number {
  const norm = 1 - B + B * (avgLen > 0 ? lineLen / avgLen : 0);
  return (termFreq * (K1 + 1)) / (termFreq + K1 * norm);
}
