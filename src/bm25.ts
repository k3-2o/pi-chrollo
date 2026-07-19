// Chrollo BM25 — single-term scorer. Standard Okapi BM25 with research-default
// k1=1.5 (term-frequency saturation) and b=0.75 (length normalization).
// Pure: no state, no I/O. The caller (rank.ts) sums this across the query
// terms present in a candidate line and combines with recency/cwd-boost.
//
// Compared to the old raw-IDF scorer, BM25's two ideas improve relevance:
// saturation (5 hits < 5× a 1-hit score) and length normalization (a hit in a
// short line ranks higher than a hit in a long line). No index — scores only
// the candidates ripgrep surfaced.

const K1 = 1.5; // term-frequency saturation rate
const B = 0.75; // length-normalization strength

// BM25 score contribution of ONE query term for ONE candidate line.
// Callers sum this across the query terms present in the line.
//
//   termFreq  - times the term appears in the candidate line
//   lineLen   - token length of the candidate line (document length)
//   avgLen    - average line length across the corpus (avgdl)
//   docFreq   - number of documents (lines) in the corpus containing the term
//   totalDocs - total documents (lines) in the corpus
export function bm25(
  termFreq: number,
  lineLen: number,
  avgLen: number,
  docFreq: number,
  totalDocs: number,
): number {
  // BM25 probabilistic IDF (always ≥ 0; the +1 inside log avoids negatives).
  const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
  // Length-normalized term frequency with saturation.
  const norm = 1 - B + B * (avgLen > 0 ? lineLen / avgLen : 0);
  const tf = (termFreq * (K1 + 1)) / (termFreq + K1 * norm);
  return tf * idf;
}
