export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function slugifyStatKey(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[%/]/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseNumberish(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = normalizeWhitespace(value);
  if (!raw || raw === "-" || raw === "None") {
    return null;
  }

  if (/^\d+:\d{2}$/.test(raw)) {
    const [minutes, seconds] = raw.split(":").map(Number);
    return minutes * 60 + seconds;
  }

  if (/^\d+(\.\d+)?s$/.test(raw)) {
    return Number(raw.slice(0, -1));
  }

  if (/^\d+(\.\d+)?%$/.test(raw)) {
    return Number(raw.slice(0, -1));
  }

  if (/^\d+\/\d+$/.test(raw)) {
    const [made, attempts] = raw.split("/").map(Number);
    return attempts === 0 ? null : made / attempts;
  }

  const cleaned = raw.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return Number(cleaned);
  }

  return null;
}

export function isFinalsRound(roundLabel) {
  return /final/i.test(String(roundLabel ?? ""));
}
