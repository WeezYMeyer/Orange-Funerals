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

function transportCents(doc) {
  return doc.charge_transport ? Math.round(doc.transport_km * doc.transport_rate_cents) : 0;
}
function totalCents(doc) {
  return doc.package_cents + transportCents(doc) + (doc.extra_label ? doc.extra_cents : 0);
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
  return db.prepare("SELECT * FROM documents WHERE stream_id = ? AND kind = ?").get(stream.id, kind);
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
    extra_label: "",
    extra_cents: 0,
    notes: "",
  };
  return { ...base, id: null, kind, number: null, issue_date: issue, due_date: due, paid_at: null };
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
    extra_label: String(body.extraLabel || "").trim(),
    extra_cents: toCents(body.extraAmount),
    notes: String(body.notes || "").trim(),
  };
  if (!doc.extra_label) doc.extra_cents = 0;
  doc.total_cents = totalCents(doc);
  const error = !doc.bill_to_name ? "Please enter who the document is addressed to." : null;
  return { doc, error };
}

const helpers = { fmtR, fmtYmd, transportCents };

// ------------------------------------------------------- quote / invoice

const KIND = ":kind(quote|invoice)";

router.get(`/streams/:slug/${KIND}/edit`, (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
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
      stream, doc: { ...doc, kind, number: existing && existing.number, id: existing && existing.id }, error, ...helpers,
    });
  }

  const cols = Object.keys(doc);
  if (existing) {
    db.prepare(
      `UPDATE documents SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, prepared_by = @prepared_by,
         updated_at = datetime('now') WHERE id = @id`
    ).run({ ...doc, id: existing.id, prepared_by: req.session.staffId });
  } else {
    db.prepare(
      `INSERT INTO documents (stream_id, kind, number, prepared_by, ${cols.join(", ")})
       VALUES (@stream_id, @kind, @number, @prepared_by, ${cols.map((c) => "@" + c).join(", ")})`
    ).run({ ...doc, stream_id: stream.id, kind, number: nextNumber(kind), prepared_by: req.session.staffId });
  }
  res.redirect(`/admin/streams/${stream.slug}/${kind}`);
});

// Printable page (Print → Save as PDF).
router.get(`/streams/:slug/${KIND}`, (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  const doc = loadDoc(stream, req.params.kind);
  if (!doc) return res.redirect(`/admin/streams/${stream.slug}/${req.params.kind}/edit`);
  const preparer = db
    .prepare("SELECT name, email FROM staff WHERE id = ?")
    .get(doc.prepared_by || req.session.staffId);
  res.render("admin/document-view", {
    stream,
    doc,
    preparer: preparer ? { name: preparer.name, email: preparer.email.replace(/\.removed\.\d+$/, "") } : null,
    s: getSettings(),
    serviceDateText: stream.service_date ? fmtDateLong(stream.service_date) : null,
    ...helpers,
  });
});

router.post("/streams/:slug/invoice/:state(paid|unpaid)", (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  db.prepare("UPDATE documents SET paid_at = ? WHERE stream_id = ? AND kind = 'invoice'").run(
    req.params.state === "paid" ? todaySA() : null,
    stream.id
  );
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
  "bank_name", "bank_account_holder", "bank_account_number", "bank_branch_code", "bank_account_type", "bank_swift",
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
