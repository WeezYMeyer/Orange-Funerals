// Quotes, invoices, the Finance tab and Business settings.
// Mounted inside the admin router (after the staff login check).
//
// Each funeral can have one quote and one invoice. The invoice is
// normally created from the quote. Documents are printable pages —
// staff use the browser's Print → Save as PDF to send them.

const express = require("express");
const db = require("../lib/db");
const { parseServiceDate, fmtDateLong } = require("../lib/crewMessages");

const router = express.Router();

// ---------------------------------------------------------------- helpers

function getSettings() {
  return Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));
}

// "3 000,50" / "R3000" / "3000.5" -> 300050 cents
function toCents(value) {
  const n = parseFloat(String(value || "").replace(/[R\s]/gi, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function toNumber(value) {
  const n = parseFloat(String(value || "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 300050 -> "R3 000.50"
function fmtR(cents) {
  const neg = cents < 0;
  const [whole, dec] = (Math.abs(cents) / 100).toFixed(2).split(".");
  return `${neg ? "-" : ""}R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${dec}`;
}

// Today's date in South Africa as YYYY-MM-DD.
function todaySA() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
}
function addDays(ymd, days) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + (parseInt(days, 10) || 0));
  return d.toISOString().slice(0, 10);
}
function fmtYmd(ymd) {
  if (!ymd) return "—";
  return fmtDateLong(ymd).replace(/^\w+ /, ""); // "16 October 2026"
}

// Extra lines (gear, USB copies, …): [{ label, qty, unit_cents }]
function lineCents(it) {
  return Math.round((Number(it.qty) || 0) * (Number(it.unit_cents) || 0));
}
function itemsCents(items) {
  return items.reduce((sum, it) => sum + lineCents(it), 0);
}
// Older documents had a single extra_label/extra_cents line.
function docItems(doc) {
  try {
    const items = JSON.parse(doc.extra_items || "null");
    if (Array.isArray(items)) return items;
  } catch {}
  return doc.extra_label ? [{ label: doc.extra_label, qty: 1, unit_cents: doc.extra_cents || 0 }] : [];
}
// The funeral's extra gear (entered once, on the funeral) as quote lines.
function parseGearJson(json) {
  try {
    const g = JSON.parse(json || "[]");
    return Array.isArray(g) ? g : [];
  } catch {
    return [];
  }
}
function gearToItems(stream) {
  return parseGearJson(stream.extra_gear).map((g) => ({
    label: g.item,
    qty: parseFloat(String(g.qty || "1").replace(",", ".")) || 1,
    unit_cents: Number(g.price_cents) || 0,
  }));
}
function docGear(doc) {
  return parseGearJson(doc.gear_items);
}
// Drop "other items" that are really funeral gear, so nothing is charged twice.
function withoutGear(items, gear) {
  const names = new Set(gear.map((g) => String(g.label).trim().toLowerCase()));
  return items.filter((it) => !names.has(String(it.label).trim().toLowerCase()));
}
function isFrozen(doc) {
  return doc.kind === "invoice" && Boolean(doc.paid_at); // paid invoices never change
}

// Re-pull the funeral's gear into its quote and unpaid invoice and fix their totals.
// Called whenever the funeral or one of its documents is saved.
function syncDocsForStream(streamId) {
  const stream = db.prepare("SELECT * FROM streams WHERE id = ?").get(streamId);
  if (!stream) return;
  const docs = db.prepare("SELECT * FROM documents WHERE stream_id = ?").all(streamId);

  // One-off tidy-up for documents made before gear had prices on the funeral:
  // if a gear line has no price but a document already priced the same item,
  // carry that price over to the funeral.
  const rawGear = parseGearJson(stream.extra_gear);
  let gearChanged = false;
  for (const g of rawGear) {
    if (Number(g.price_cents)) continue;
    for (const d of docs) {
      const hit = docItems(d).find((it) => String(it.label).trim().toLowerCase() === String(g.item).trim().toLowerCase() && it.unit_cents);
      if (hit) { g.price_cents = hit.unit_cents; gearChanged = true; break; }
    }
  }
  if (gearChanged) {
    stream.extra_gear = JSON.stringify(rawGear);
    db.prepare("UPDATE streams SET extra_gear = ? WHERE id = ?").run(stream.extra_gear, stream.id);
  }

  const gear = gearToItems(stream);
  const upd = db.prepare("UPDATE documents SET gear_items = ?, extra_items = ?, total_cents = ? WHERE id = ?");
  for (const d of docs) {
    if (isFrozen(d)) continue;
    const doc = { ...d, gear, items: withoutGear(docItems(d), gear) };
    upd.run(JSON.stringify(gear), JSON.stringify(doc.items), totalCents(doc), d.id);
  }
}

function transportCents(doc) {
  return doc.charge_transport ? Math.round(doc.transport_km * doc.transport_rate_cents) : 0;
}
function totalCents(doc) {
  return doc.package_cents + transportCents(doc) + itemsCents(doc.gear || []) + itemsCents(doc.items || []);
}

function nextNumber(kind) {
  const prefix = kind === "quote" ? "Q" : "INV";
  const rows = db.prepare("SELECT number FROM documents WHERE kind = ?").all(kind);
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.number.replace(/\D/g, ""), 10) || 0), 0);
  return prefix + String(max + 1).padStart(4, "0");
}

function loadStream(req, res) {
  const stream = db.prepare("SELECT * FROM streams WHERE slug = ?").get(req.params.slug);
  if (!stream) res.status(404).send("Stream not found");
  return stream;
}
function loadDoc(stream, kind) {
  const doc = db.prepare("SELECT * FROM documents WHERE stream_id = ? AND kind = ?").get(stream.id, kind);
  if (doc) {
    doc.items = docItems(doc);
    doc.gear = docGear(doc);
  }
  return doc;
}

// A starting point for a new quote/invoice: copy the quote if there is
// one, otherwise use the defaults from Business settings.
function draftFor(stream, kind) {
  const s = getSettings();
  const issue = todaySA();
  const service = parseServiceDate(stream.service_date);
  let due;
  if (kind === "quote") {
    due = addDays(issue, s.quote_valid_days || 7);
  } else {
    due = addDays(issue, s.invoice_due_days || 0);
    if (service && service.ymd > due) due = service.ymd; // due before the service
  }

  const quote = kind === "invoice" ? loadDoc(stream, "quote") : null;
  const base = quote || {
    bill_to_name: stream.contact_name || "",
    bill_to_phone: stream.contact_phone || "",
    bill_to_email: "",
    bill_to_address: "",
    package_label: s.package_label,
    package_details: s.package_details,
    package_cents: toCents(s.package_price),
    charge_transport: 0,
    transport_km: 0,
    transport_rate_cents: toCents(s.transport_rate),
    items: [],
    notes: "",
  };
  const gear = gearToItems(stream); // always the funeral's current gear
  return {
    ...base, id: null, kind, number: null, issue_date: issue, due_date: due, paid_at: null,
    gear, items: withoutGear(base.items || [], gear),
  };
}

function readDocForm(body) {
  const doc = {
    issue_date: /^\d{4}-\d{2}-\d{2}$/.test(body.issueDate || "") ? body.issueDate : todaySA(),
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || "") ? body.dueDate : null,
    bill_to_name: String(body.billToName || "").trim(),
    bill_to_phone: String(body.billToPhone || "").trim(),
    bill_to_email: String(body.billToEmail || "").trim(),
    bill_to_address: String(body.billToAddress || "").trim(),
    package_label: String(body.packageLabel || "").trim() || "Streaming Package",
    package_details: String(body.packageDetails || "").trim(),
    package_cents: toCents(body.packagePrice),
    charge_transport: body.chargeTransport === "1" ? 1 : 0,
    transport_km: toNumber(body.transportKm),
    transport_rate_cents: toCents(body.transportRate),
    extra_label: null,
    extra_cents: 0,
    notes: String(body.notes || "").trim(),
  };
  const labels = [].concat(body.itemLabel || []);
  const qtys = [].concat(body.itemQty || []);
  const prices = [].concat(body.itemPrice || []);
  doc.items = labels
    .map((l, i) => ({
      label: String(l || "").trim().slice(0, 200),
      qty: toNumber(qtys[i]) || 1,
      unit_cents: toCents(prices[i]),
    }))
    .filter((it) => it.label);
  doc.extra_items = JSON.stringify(doc.items);
  doc.total_cents = totalCents(doc);
  const error = !doc.bill_to_name ? "Please enter who the document is addressed to." : null;
  return { doc, error };
}

const helpers = { fmtR, fmtYmd, transportCents, lineCents };

// ------------------------------------------------------- quote / invoice

const KIND = ":kind(quote|invoice)";

router.get(`/streams/:slug/${KIND}/edit`, (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  syncDocsForStream(stream.id);
  const doc = loadDoc(stream, req.params.kind) || draftFor(stream, req.params.kind);
  res.render("admin/document-form", { stream, doc, error: null, ...helpers });
});

router.post(`/streams/:slug/${KIND}/edit`, (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  const kind = req.params.kind;
  const existing = loadDoc(stream, kind);
  const { doc, error } = readDocForm(req.body);
  if (error) {
    return res.render("admin/document-form", {
      stream,
      doc: { ...doc, gear: existing && isFrozen(existing) ? existing.gear : gearToItems(stream), kind,
             number: existing && existing.number, id: existing && existing.id, paid_at: existing && existing.paid_at },
      error, ...helpers,
    });
  }

  // Gear comes from the funeral (a paid invoice keeps what it was paid on).
  doc.gear = existing && isFrozen(existing) ? existing.gear : gearToItems(stream);
  doc.items = withoutGear(doc.items, doc.gear);
  doc.extra_items = JSON.stringify(doc.items);
  doc.gear_items = JSON.stringify(doc.gear);
  doc.total_cents = totalCents(doc);

  const cols = Object.keys(doc).filter((c) => c !== "items" && c !== "gear");
  const row = { ...doc };
  delete row.items; // stored as JSON in extra_items
  delete row.gear;  // stored as JSON in gear_items
  if (existing) {
    db.prepare(
      `UPDATE documents SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, prepared_by = @prepared_by,
         updated_at = datetime('now') WHERE id = @id`
    ).run({ ...row, id: existing.id, prepared_by: req.session.staffId });
  } else {
    db.prepare(
      `INSERT INTO documents (stream_id, kind, number, prepared_by, ${cols.join(", ")})
       VALUES (@stream_id, @kind, @number, @prepared_by, ${cols.map((c) => "@" + c).join(", ")})`
    ).run({ ...row, stream_id: stream.id, kind, number: nextNumber(kind), prepared_by: req.session.staffId });
  }
  res.redirect(`/admin/streams/${stream.slug}/${kind}`);
});

// Printable page (Print → Save as PDF).
router.get(`/streams/:slug/${KIND}`, (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  syncDocsForStream(stream.id);
  const doc = loadDoc(stream, req.params.kind);
  if (!doc) return res.redirect(`/admin/streams/${stream.slug}/${req.params.kind}/edit`);
  const preparer = db
    .prepare("SELECT name, email FROM staff WHERE id = ?")
    .get(doc.prepared_by || req.session.staffId);
  const all = getSettings();
  const p = stream.branch === "capetown" ? "ct_bank_" : "bank_";
  const bank = {
    name: all[p + "name"], branchName: all[p + "branch_name"], holder: all[p + "account_holder"],
    number: all[p + "account_number"], branchCode: all[p + "branch_code"], type: all[p + "account_type"],
    swift: all[p + "swift"], label: stream.branch === "capetown" ? "Cape Town" : "Pretoria",
  };
  res.render("admin/document-view", {
    stream,
    doc,
    bank,
    preparer: preparer ? { name: preparer.name, email: preparer.email.replace(/\.removed\.\d+$/, "") } : null,
    s: getSettings(),
    serviceDateText: stream.service_date ? fmtDateLong(stream.service_date) : null,
    ...helpers,
  });
});

router.post("/streams/:slug/invoice/:state(paid|unpaid)", (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  // Bring the invoice up to date with the funeral before it is frozen (or after unfreezing).
  if (req.params.state === "paid") syncDocsForStream(stream.id);
  db.prepare("UPDATE documents SET paid_at = ? WHERE stream_id = ? AND kind = 'invoice'").run(
    req.params.state === "paid" ? todaySA() : null,
    stream.id
  );
  if (req.params.state === "unpaid") syncDocsForStream(stream.id);
  res.redirect(req.get("Referer") || `/admin/streams/${stream.slug}`);
});

router.post(`/streams/:slug/${KIND}/delete`, (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  db.prepare("DELETE FROM documents WHERE stream_id = ? AND kind = ?").run(stream.id, req.params.kind);
  res.redirect(`/admin/streams/${stream.slug}#billing`);
});

// ----------------------------------------------------------------- finance

router.get("/finance", (req, res) => {
  const now = todaySA();
  const m = /^(\d{4})-(\d{2})$/.exec(req.query.month || "");
  const year = m ? +m[1] : +now.slice(0, 4);
  const month = m ? +m[2] : +now.slice(5, 7);
  const pad = (n) => String(n).padStart(2, "0");
  const monthKey = `${year}-${pad(month)}`;

  const rows = db
    .prepare(
      `SELECT s.slug, s.title, s.service_date, s.lead_source,
              q.number AS q_number, q.total_cents AS q_total,
              i.number AS i_number, i.total_cents AS i_total, i.paid_at,
              CASE WHEN i.charge_transport = 1 THEN CAST(ROUND(i.transport_km * i.transport_rate_cents) AS INTEGER) ELSE 0 END AS i_transport
       FROM streams s
       LEFT JOIN documents q ON q.stream_id = s.id AND q.kind = 'quote'
       LEFT JOIN documents i ON i.stream_id = s.id AND i.kind = 'invoice'
       WHERE substr(s.service_date, 1, 7) = ?
       ORDER BY s.service_date`
    )
    .all(monthKey)
    .map((r) => ({ ...r, dateText: r.service_date ? fmtYmd(r.service_date.slice(0, 10)) : "—" }));

  const t = { funerals: rows.length, invoiced: 0, paid: 0, outstanding: 0, quotedOnly: 0, transport: 0, noDocs: 0 };
  const bySource = {};
  for (const r of rows) {
    const src = r.lead_source || "Not recorded";
    const b = (bySource[src] = bySource[src] || { source: src, funerals: 0, invoiced: 0, paid: 0 });
    b.funerals++;
    if (r.i_number) {
      t.invoiced += r.i_total;
      t.transport += r.i_transport;
      b.invoiced += r.i_total;
      if (r.paid_at) { t.paid += r.i_total; b.paid += r.i_total; } else t.outstanding += r.i_total;
    } else if (r.q_number) {
      t.quotedOnly += r.q_total;
    } else {
      t.noDocs++;
    }
  }

  // Unpaid invoices from any month, so nothing slips through.
  const unpaid = db
    .prepare(
      `SELECT s.slug, s.title, s.service_date, i.number, i.total_cents, i.due_date
       FROM documents i JOIN streams s ON s.id = i.stream_id
       WHERE i.kind = 'invoice' AND i.paid_at IS NULL
       ORDER BY i.due_date`
    )
    .all();

  const prev = month === 1 ? `${year - 1}-12` : `${year}-${pad(month - 1)}`;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${pad(month + 1)}`;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  res.render("admin/finance", {
    rows,
    t,
    sources: Object.values(bySource).sort((a, b) => b.invoiced - a.invoiced || b.funerals - a.funerals),
    unpaid,
    monthLabel: `${MONTHS[month - 1]} ${year}`,
    prev,
    next,
    today: now,
    ...helpers,
  });
});

// --------------------------------------------------------------- settings

const SETTING_FIELDS = [
  "business_name", "business_address", "business_phone", "business_email", "business_website",
  "bank_name", "bank_branch_name", "bank_account_holder", "bank_account_number", "bank_branch_code", "bank_account_type", "bank_swift",
  "ct_bank_name", "ct_bank_branch_name", "ct_bank_account_holder", "ct_bank_account_number", "ct_bank_branch_code",
  "ct_bank_account_type", "ct_bank_swift", "crew_guidelines_message",
  "package_label", "package_details", "package_price", "transport_rate",
  "quote_valid_days", "invoice_due_days", "payment_terms", "vat_note",
];

router.get("/settings", (req, res) => {
  res.render("admin/settings", { s: getSettings(), notice: req.query.notice || null });
});

router.post("/settings", (req, res) => {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  db.transaction(() => {
    for (const k of SETTING_FIELDS) {
      if (k in req.body) upsert.run(k, String(req.body[k]).trim());
    }
  })();
  res.redirect("/admin/settings?notice=saved");
});

module.exports = router;
module.exports.syncDocsForStream = syncDocsForStream;
