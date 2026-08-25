const { nanoid } = require("nanoid");
const db = require("./db");

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

/** Generate a unique, human-readable slug like "service-for-john-smith-x7q2f". */
function makeUniqueSlug(title) {
  const base = slugify(title) || "livestream";
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}-${nanoid(6).toLowerCase()}`;
    const exists = db.prepare("SELECT 1 FROM streams WHERE slug = ?").get(candidate);
    if (!exists) return candidate;
  }
  // Astronomically unlikely fallback.
  return `${base}-${nanoid(12).toLowerCase()}`;
}

module.exports = { slugify, makeUniqueSlug };
