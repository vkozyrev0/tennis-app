// T-shirt size constants (audit M14): single source of truth, importable
// from anywhere in app.js without TDZ concerns. The labels mirror
// backend/app/shirtops.py SHIRT_LABELS so frontend display + server
// validation can't drift.

export const SHIRT_CODES = ["YS", "YM", "YL", "AS", "AM", "AL", "AXL"];
export const SHIRT_LABEL = {
  YS: "Youth Small", YM: "Youth Medium", YL: "Youth Large",
  AS: "Adult Small", AM: "Adult Medium", AL: "Adult Large",
  AXL: "Adult Extra Large",
};
export const SHIRT_LABELS = SHIRT_CODES.map((c) => SHIRT_LABEL[c]);
// Token→letter map used by _canonShirtCode: "small" → "S", etc. Lives here so
// any future size-label changes stay in one file.
export const SIZE_TOKEN = {
  s: "S", sm: "S", small: "S",
  m: "M", med: "M", medium: "M",
  l: "L", lg: "L", large: "L",
  xl: "XL", xlarge: "XL", extralarge: "XL", xxl: "XL", xxxl: "XL",
};
