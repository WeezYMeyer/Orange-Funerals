// Quotes, invoices, the Finance tab and Business settings.
// Mounted inside the admin router (after the staff login check).
//
// Each funeral can have one quote and one invoice. The invoice is
// normally created from the quote. Documents are printable pages —
// staff use the browser's Print → Save as PDF to send them.

const express = require("express");
const db = require("../lib/db");
const { parseServiceDate, fmtDateLong } = require("../lib/crewMessages");
const crm = require("../lib/crmSync");

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
// The payment date typed in when marking paid (today if missing, never in the future).
function paidDateFrom(body) {
  const d = String((body && body.paidDate) || "");
  const today = todaySA();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today ? d : today;
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
// Everyone billed on this funeral's quote or invoice.
function billedEmails(streamId) {
  return db
    .prepare("SELECT bill_to_email AS e FROM documents WHERE stream_id = ? AND bill_to_email IS NOT NULL AND bill_to_email != ''")
    .all(streamId)
    .map((r) => r.e);
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
  // Account clients (e.g. AVBOB) are billed as the company, not the family.
  const acct = stream.account_client ? accountDetails(stream.account_client) : null;
  const base = quote || {
    bill_to_name: acct ? acct.name : stream.contact_name || "",
    bill_to_phone: acct ? acct.phone : stream.contact_phone || "",
    bill_to_email: acct ? acct.email : "",
    bill_to_address: acct ? acct.address : "",
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

// ----------------------------------------------------------- funeral homes
// Funeral homes (account clients such as AVBOB) are billed instead of the family.
// Funerals link to them by name (streams.account_client).

function funeralHomes({ includeInactive = false } = {}) {
  return db
    .prepare(`SELECT * FROM funeral_homes ${includeInactive ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`)
    .all();
}
function accountClients() {
  return funeralHomes().map((h) => h.name);
}
function findHome(name) {
  return name ? db.prepare("SELECT * FROM funeral_homes WHERE name = ? COLLATE NOCASE").get(String(name).trim()) : null;
}
// The address block printed under the funeral home's name on invoices/statements.
function homeAddress(h) {
  return [
    h.address,
    h.contact_person ? `Attn: ${h.contact_person}` : "",
    h.vat_number ? `VAT no: ${h.vat_number}` : "",
    h.reg_number ? `Reg no: ${h.reg_number}` : "",
  ].map((l) => String(l || "").trim()).filter(Boolean).join("\n");
}
// The supplier number the funeral home gave us (a branch uses its group's if it has none).
function supplierFor(h) {
  if (!h) return "";
  if (h.supplier_number) return h.supplier_number;
  const parent = h.parent_id ? db.prepare("SELECT supplier_number FROM funeral_homes WHERE id = ?").get(h.parent_id) : null;
  return (parent && parent.supplier_number) || "";
}
// A funeral home plus its branches (AVBOB + AVBOB Centurion, AVBOB Pretoria North…).
function groupNames(client) {
  const h = findHome(client);
  if (!h) return [client];
  return [h.name, ...db.prepare("SELECT name FROM funeral_homes WHERE parent_id = ?").all(h.id).map((r) => r.name)];
}
// Dropdown entries: each group ("AVBOB — all branches") followed by its branches.
function homeOptions() {
  const all = funeralHomes();
  const out = [];
  const tops = all.filter((h) => !h.parent_id || !all.some((p) => p.id === h.parent_id));
  for (const top of tops) {
    const kids = all.filter((h) => h.parent_id === top.id);
    out.push({ name: top.name, label: kids.length ? `${top.name} — all branches` : top.name });
    for (const k of kids) out.push({ name: k.name, label: `\u00a0\u00a0\u00a0\u00a0${k.name}` });
  }
  return out;
}
// "Late Rohrs · BB 12345" for a funeral billed to a funeral home.
function funeralRef(stream) {
  return [stream.late_name ? `Late ${stream.late_name}` : "", stream.bb_number ? (/^bb/i.test(stream.bb_number) ? stream.bb_number : "BB " + stream.bb_number) : ""]
    .filter(Boolean)
    .join(" · ");
}

// Billing details for a funeral home (falls back to just the name).
function accountDetails(client) {
  const h = findHome(client);
  if (!h) return { name: client, email: "", phone: "", address: "" };
  return { name: h.name, email: h.email || "", phone: h.phone || "", address: homeAddress(h) };
}

// Put the funeral home's current details on the unpaid quote/invoice of these
// funerals (after the funeral home is edited, or a funeral is moved to it).
function applyFuneralHome(streamIds) {
  const emails = [];
  const upd = db.prepare(
    `UPDATE documents SET bill_to_name = ?, bill_to_phone = ?, bill_to_email = ?, bill_to_address = ?,
       updated_at = datetime('now') WHERE id = ?`
  );
  for (const id of [].concat(streamIds)) {
    const stream = db.prepare("SELECT id, account_client FROM streams WHERE id = ?").get(id);
    if (!stream || !stream.account_client) continue;
    const a = accountDetails(stream.account_client);
    for (const d of db.prepare("SELECT * FROM documents WHERE stream_id = ?").all(id)) {
      if (isFrozen(d)) continue;
      emails.push(d.bill_to_email, a.email);
      upd.run(a.name, a.phone, a.email, a.address, d.id);
    }
  }
  crm.enqueue(emails); // billed email may have changed
}

// Letterhead + bank account for a branch (same rules as quotes/invoices).
function branchDetails(branch, preparer) {
  const all = getSettings();
  const ct = branch === "capetown";
  const p = ct ? "ct_bank_" : "bank_";
  const bank = {
    name: all[p + "name"], branchName: all[p + "branch_name"], holder: all[p + "account_holder"],
    number: all[p + "account_number"], branchCode: all[p + "branch_code"], type: all[p + "account_type"],
    swift: all[p + "swift"], label: ct ? "Cape Town" : "Pretoria",
  };
  const from = ct
    ? {
        name: all.ct_business_name || all.business_name,
        address: all.ct_business_address,
        phone: all.ct_business_phone,
        email: all.ct_business_email,
        website: all.ct_business_website || all.business_website,
      }
    : {
        name: all.business_name,
        address: all.business_address,
        phone: all.business_phone,
        email: (preparer && preparer.email) || all.business_email,
        website: all.business_website,
      };
  return { bank, from, s: all };
}

const helpers = { fmtR, fmtYmd, transportCents, lineCents, funeralRef };

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
  // The billed person goes to the Orange Platform CRM (and the old one, if the email changed).
  crm.enqueue(doc.bill_to_email, existing && existing.bill_to_email);
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
  // Letterhead: Cape Town funerals carry the Cape Town office details;
  // Pretoria keeps the main details with the preparer's email.
  const ct = stream.branch === "capetown";
  const from = ct
    ? {
        name: all.ct_business_name || all.business_name,
        address: all.ct_business_address,
        phone: all.ct_business_phone,
        email: all.ct_business_email,
        website: all.ct_business_website || all.business_website,
      }
    : {
        name: all.business_name,
        address: all.business_address,
        phone: all.business_phone,
        email: (preparer && preparer.email && preparer.email.replace(/\.removed\.\d+$/, "")) || all.business_email,
        website: all.business_website,
      };
  res.render("admin/document-view", {
    stream,
    supplier: stream.account_client ? supplierFor(findHome(stream.account_client)) : "",
    doc,
    bank,
    from,
    preparer: preparer ? { name: preparer.name, email: preparer.email.replace(/\.removed\.\d+$/, "") } : null,
    s: getSettings(),
    serviceDateText: stream.service_date ? fmtDateLong(stream.service_date) : null,
    ...helpers,
  });
});

router.post("/streams/:slug/invoice/:state(paid|unpaid)", (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  const inv = loadDoc(stream, "invoice");
  // Bring the invoice up to date with the funeral before it is frozen (or after unfreezing).
  // Already paid? Then this only changes the payment date.
  if (req.params.state === "paid" && inv && !inv.paid_at) syncDocsForStream(stream.id);
  db.prepare("UPDATE documents SET paid_at = ? WHERE stream_id = ? AND kind = 'invoice'").run(
    req.params.state === "paid" ? paidDateFrom(req.body) : null,
    stream.id
  );
  if (req.params.state === "unpaid") syncDocsForStream(stream.id);
  crm.enqueue(billedEmails(stream.id)); // paid / unpaid shows on their CRM record
  res.redirect(req.get("Referer") || `/admin/streams/${stream.slug}`);
});

router.post(`/streams/:slug/${KIND}/delete`, (req, res) => {
  const stream = loadStream(req, res);
  if (!stream) return;
  const emails = billedEmails(stream.id);
  db.prepare(
    "DELETE FROM statement_items WHERE document_id IN (SELECT id FROM documents WHERE stream_id = ? AND kind = ?)"
  ).run(stream.id, req.params.kind);
  db.prepare("DELETE FROM documents WHERE stream_id = ? AND kind = ?").run(stream.id, req.params.kind);
  crm.enqueue(emails);
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

// Funeral homes tab: add / edit the companies we bill on account.
function readHomeForm(body) {
  const t = (v, n = 300) => String(v || "").trim().slice(0, n);
  const f = {
    name: t(body.name, 120), contact_person: t(body.contactPerson), phone: t(body.phone, 60), email: t(body.email, 200),
    address: t(body.address, 600), vat_number: t(body.vatNumber, 40), reg_number: t(body.regNumber, 40), notes: t(body.notes, 1000),
    supplier_number: t(body.supplierNumber, 60), parent_id: parseInt(body.parentId, 10) || null,
  };
  let error = null;
  if (!f.name) error = "Please enter the funeral home's name.";
  else if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) error = "That email address doesn't look right.";
  return { f, error };
}
// One level only: a group (AVBOB) with branches under it.
function parentError(f, selfId) {
  if (!f.parent_id) return null;
  const parent = db.prepare("SELECT * FROM funeral_homes WHERE id = ?").get(f.parent_id);
  if (!parent || parent.id === selfId) return "Pick a different group.";
  if (parent.parent_id) return `${parent.name} is itself a branch — pick the main group instead.`;
  if (selfId && db.prepare("SELECT 1 FROM funeral_homes WHERE parent_id = ?").get(selfId)) {
    return "This funeral home has branches under it, so it can't be a branch itself.";
  }
  return null;
}

function renderHomes(res, { editing = null, form = null, error = null, notice = null } = {}) {
  const all = funeralHomes();
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  // Groups first, each followed by its branches.
  const ordered = [];
  for (const top of all.filter((h) => !h.parent_id || !all.some((p) => p.id === h.parent_id)).sort(byName)) {
    ordered.push(top);
    ordered.push(...all.filter((h) => h.parent_id === top.id).sort(byName));
  }
  const homes = ordered.map((h) => ({
    ...h,
    supplier: supplierFor(h),
    isBranch: Boolean(h.parent_id && all.some((p) => p.id === h.parent_id)),
    branchCount: all.filter((c) => c.parent_id === h.id).length,
    funerals: db.prepare("SELECT COUNT(*) AS n FROM streams WHERE account_client = ? COLLATE NOCASE").get(h.name).n,
    unpaid: db
      .prepare(
        `SELECT COALESCE(SUM(d.total_cents), 0) AS c FROM documents d JOIN streams s ON s.id = d.stream_id
         WHERE s.account_client = ? COLLATE NOCASE AND d.kind = 'invoice' AND d.paid_at IS NULL`
      )
      .get(h.name).c,
  }));
  const groups = all.filter((h) => !h.parent_id && (!editing || h.id !== editing.id));
  res.render("admin/funeral-homes", { homes, groups, editing, form: form || editing || {}, error, notice, fmtR });
}

router.get("/funeral-homes", (req, res) => {
  const editing = req.query.edit ? db.prepare("SELECT * FROM funeral_homes WHERE id = ?").get(parseInt(req.query.edit, 10)) || null : null;
  renderHomes(res, { editing, notice: req.query.notice || null });
});

router.post("/funeral-homes", (req, res) => {
  const { f, error: formError } = readHomeForm(req.body);
  const error = formError || parentError(f, null);
  const clash = !error && findHome(f.name);
  if (error || (clash && clash.active)) {
    return renderHomes(res, { form: f, error: error || `${clash.name} is already on the list.` });
  }
  if (clash) {
    // Removed earlier: bring it back with the new details.
    db.prepare(
      `UPDATE funeral_homes SET name = @name, contact_person = @contact_person, phone = @phone, email = @email,
         address = @address, vat_number = @vat_number, reg_number = @reg_number, notes = @notes,
         supplier_number = @supplier_number, parent_id = @parent_id, active = 1 WHERE id = @id`
    ).run({ ...f, id: clash.id });
  } else {
    const cols = Object.keys(f);
    db.prepare(`INSERT INTO funeral_homes (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`).run(f);
  }
  // Funerals already typed with this name pick up the details.
  applyFuneralHome(db.prepare("SELECT id FROM streams WHERE account_client = ? COLLATE NOCASE").all(f.name).map((r) => r.id));
  res.redirect("/admin/funeral-homes?notice=added");
});

router.post("/funeral-homes/:id(\\d+)/edit", (req, res) => {
  const home = db.prepare("SELECT * FROM funeral_homes WHERE id = ?").get(parseInt(req.params.id, 10));
  if (!home) return res.status(404).send("Funeral home not found");
  const { f, error: formError } = readHomeForm(req.body);
  const error = formError || parentError(f, home.id);
  const clash = !error && findHome(f.name);
  if (error || (clash && clash.id !== home.id)) {
    return renderHomes(res, { editing: home, form: { ...f, id: home.id }, error: error || `Another funeral home is already called ${f.name}.` });
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE funeral_homes SET name = @name, contact_person = @contact_person, phone = @phone, email = @email,
         address = @address, vat_number = @vat_number, reg_number = @reg_number, notes = @notes,
         supplier_number = @supplier_number, parent_id = @parent_id WHERE id = @id`
    ).run({ ...f, id: home.id });
    if (f.name !== home.name) {
      // Renamed: keep its funerals, lead source and unpaid statements linked.
      db.prepare("UPDATE streams SET account_client = ? WHERE account_client = ? COLLATE NOCASE").run(f.name, home.name);
      db.prepare("UPDATE streams SET lead_source = ? WHERE lead_source = ? COLLATE NOCASE").run(f.name, home.name);
      db.prepare("UPDATE statements SET client = ? WHERE client = ? COLLATE NOCASE AND paid_at IS NULL").run(f.name, home.name);
    }
  })();
  applyFuneralHome(db.prepare("SELECT id FROM streams WHERE account_client = ? COLLATE NOCASE").all(f.name).map((r) => r.id));
  res.redirect("/admin/funeral-homes?notice=updated");
});

// Hidden, not deleted: past funerals, invoices and statements keep the name.
router.post("/funeral-homes/:id(\\d+)/remove", (req, res) => {
  db.prepare("UPDATE funeral_homes SET active = 0 WHERE id = ?").run(parseInt(req.params.id, 10));
  res.redirect("/admin/funeral-homes?notice=removed");
});

// -------------------------------------------------------------- statements
// For account clients like AVBOB: every funeral keeps its own invoice, and a
// statement lists the client's unpaid invoices for a period so they can pay
// them together. Paying the statement marks every invoice on it as paid.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function nextStatementNumber() {
  const rows = db.prepare("SELECT number FROM statements").all();
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.number.replace(/\D/g, ""), 10) || 0), 0);
  return "ST" + String(max + 1).padStart(4, "0");
}

// What the statement builder needs for one client / branch / period.
function statementCandidates({ client, branch, from, to }) {
  // A group's statement (AVBOB) includes the funerals of all its branches.
  const range = `lower(trim(s.account_client)) IN (SELECT lower(trim(value)) FROM json_each(@names)) AND s.branch = @branch
     AND (@from = '' OR substr(s.service_date, 1, 10) >= @from)
     AND substr(s.service_date, 1, 10) <= @to`;
  const args = { names: JSON.stringify(groupNames(client)), branch, from: from || "", to };
  // Unpaid invoices not on any statement yet.
  const invoices = db
    .prepare(
      `SELECT d.id, d.number, d.total_cents, d.stream_id, s.slug, s.title, s.service_date, s.venue_name,
              s.account_client, s.late_name, s.bb_number
       FROM documents d JOIN streams s ON s.id = d.stream_id
       WHERE d.kind = 'invoice' AND d.paid_at IS NULL
         AND d.id NOT IN (SELECT document_id FROM statement_items)
         AND ${range}
       ORDER BY s.service_date`
    )
    .all(args);
  // Funerals for this client with no invoice yet.
  const missing = db
    .prepare(
      `SELECT s.id, s.slug, s.title, s.service_date, s.account_client FROM streams s
       WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.stream_id = s.id AND d.kind = 'invoice')
         AND ${range}
       ORDER BY s.service_date`
    )
    .all(args);
  // Invoices already on another statement (so staff know why they're not listed).
  const elsewhere = db
    .prepare(
      `SELECT d.number, st.id AS statement_id, st.number AS statement_number, s.title
       FROM documents d JOIN streams s ON s.id = d.stream_id
       JOIN statement_items si ON si.document_id = d.id JOIN statements st ON st.id = si.statement_id
       WHERE d.kind = 'invoice' AND d.paid_at IS NULL AND ${range}
       ORDER BY s.service_date`
    )
    .all(args);
  return { invoices, missing, elsewhere };
}

function readStatementQuery(q) {
  const client = String(q.client || "").trim().slice(0, 120);
  const branch = q.branch === "capetown" ? "capetown" : "pretoria";
  const to = YMD.test(q.to || "") ? q.to : todaySA();
  // Empty "from" = every unpaid invoice up to "to" that isn't on a statement yet,
  // so a late invoice for an older funeral is never skipped.
  const from = YMD.test(q.from || "") ? q.from : "";
  return { client, branch, from, to };
}

function statementItems(statementId) {
  return db
    .prepare(
      `SELECT d.id, d.number, d.total_cents, d.paid_at, d.stream_id, d.bill_to_email, si.paid_by_statement,
              s.slug, s.title, s.service_date, s.venue_name, s.account_client, s.late_name, s.bb_number
       FROM statement_items si JOIN documents d ON d.id = si.document_id JOIN streams s ON s.id = d.stream_id
       WHERE si.statement_id = ?
       ORDER BY s.service_date, d.number`
    )
    .all(statementId);
}

function statementTotals(items) {
  const total = items.reduce((t, i) => t + i.total_cents, 0);
  const due = items.filter((i) => !i.paid_at).reduce((t, i) => t + i.total_cents, 0);
  return { total, paid: total - due, due };
}

router.get("/statements", (req, res) => {
  const query = readStatementQuery(req.query);
  const statements = db
    .prepare("SELECT * FROM statements ORDER BY id DESC LIMIT 200")
    .all()
    .map((st) => ({ ...st, ...statementTotals(statementItems(st.id)), count: statementItems(st.id).length }));
  const home = query.client ? findHome(query.client) : null;
  const acct = home ? { ...home, supplier: supplierFor(home) } : null;
  res.render("admin/statements", {
    query,
    accounts: homeOptions(),
    statements,
    candidates: query.client ? statementCandidates(query) : null,
    acct,
    notice: req.query.notice || null,
    error: req.query.error || null,
    ...helpers,
  });
});

// Create the missing invoices for ticked funerals (billed to the account client).
router.post("/statements/create-invoices", (req, res) => {
  const query = readStatementQuery(req.body);
  const ids = [].concat(req.body.streamIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const emails = [];
  db.transaction(() => {
    for (const id of ids) {
      const stream = db.prepare("SELECT * FROM streams WHERE id = ?").get(id);
      if (!stream || loadDoc(stream, "invoice")) continue;
      const d = draftFor(stream, "invoice");
      const row = {
        stream_id: stream.id, kind: "invoice", number: nextNumber("invoice"), prepared_by: req.session.staffId,
        issue_date: d.issue_date, due_date: d.due_date,
        bill_to_name: d.bill_to_name || stream.account_client || query.client, bill_to_phone: d.bill_to_phone || "",
        bill_to_email: d.bill_to_email || "", bill_to_address: d.bill_to_address || "",
        package_label: d.package_label, package_details: d.package_details || "", package_cents: d.package_cents || 0,
        charge_transport: d.charge_transport ? 1 : 0, transport_km: d.transport_km || 0,
        transport_rate_cents: d.transport_rate_cents || 0, notes: d.notes || "",
        extra_items: JSON.stringify(d.items || []), gear_items: JSON.stringify(d.gear || []),
        total_cents: totalCents(d),
      };
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO documents (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`).run(row);
      emails.push(row.bill_to_email);
    }
  })();
  crm.enqueue(emails);
  const qs = new URLSearchParams({ client: query.client, branch: query.branch, from: query.from, to: query.to });
  res.redirect(`/admin/statements?${qs}&notice=invoices#build`);
});

router.post("/statements", (req, res) => {
  const query = readStatementQuery(req.body);
  const back = (error) =>
    res.redirect(`/admin/statements?${new URLSearchParams({ ...query, error })}#build`);
  if (!query.client) return back("Choose the account client first.");
  const wanted = new Set([].concat(req.body.docIds || []).map((v) => parseInt(v, 10)));
  // Only invoices that are still eligible (unpaid, not on another statement, in range).
  const docs = statementCandidates(query).invoices.filter((d) => wanted.has(d.id));
  if (!docs.length) return back("Tick at least one invoice to put on the statement.");

  const period_from = query.from || docs[0].service_date.slice(0, 10);
  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO statements (number, client, client_email, client_address, branch, period_from, period_to,
           issue_date, notes, prepared_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nextStatementNumber(), query.client,
        accountDetails(query.client).email,
        accountDetails(query.client).address,
        query.branch, period_from, query.to, todaySA(),
        String(req.body.notes || "").trim().slice(0, 2000), req.session.staffId
      );
    const add = db.prepare("INSERT INTO statement_items (statement_id, document_id) VALUES (?, ?)");
    for (const d of docs) {
      syncDocsForStream(d.stream_id); // totals up to date with the funeral's gear
      add.run(info.lastInsertRowid, d.id);
    }
    return info.lastInsertRowid;
  })();
  res.redirect(`/admin/statements/${id}`);
});

function loadStatement(req, res) {
  const st = db.prepare("SELECT * FROM statements WHERE id = ?").get(parseInt(req.params.id, 10) || 0);
  if (!st) res.status(404).send("Statement not found");
  return st;
}

// Printable statement (Print → Save as PDF).
router.get("/statements/:id(\\d+)", (req, res) => {
  const st = loadStatement(req, res);
  if (!st) return;
  for (const it of statementItems(st.id)) if (!it.paid_at) syncDocsForStream(it.stream_id);
  if (!st.paid_at && findHome(st.client)) {
    // Unpaid statements always show the funeral home's current details.
    const a = accountDetails(st.client);
    db.prepare("UPDATE statements SET client = ?, client_email = ?, client_address = ? WHERE id = ?").run(a.name, a.email, a.address, st.id);
    Object.assign(st, { client: a.name, client_email: a.email, client_address: a.address });
  }
  const items = statementItems(st.id);
  const preparerRow = db.prepare("SELECT name, email FROM staff WHERE id = ?").get(st.prepared_by || req.session.staffId);
  const preparer = preparerRow
    ? { name: preparerRow.name, email: String(preparerRow.email || "").replace(/\.removed\.\d+$/, "") }
    : null;
  const { bank, from, s } = branchDetails(st.branch, preparer);
  res.render("admin/statement-view", {
    st, items, totals: statementTotals(items), bank, from, s, preparer,
    supplier: supplierFor(findHome(st.client)),
    // Group statement (AVBOB): show which branch each funeral came from.
    showBranch: items.some((it) => (it.account_client || "").toLowerCase() !== st.client.toLowerCase()),
    dateOf: (sd) => (sd ? fmtYmd(String(sd).slice(0, 10)) : "—"),
    ...helpers,
  });
});

router.post("/statements/:id(\\d+)/:state(paid|unpaid)", (req, res) => {
  const st = loadStatement(req, res);
  if (!st) return;
  const items = statementItems(st.id);
  const today = paidDateFrom(req.body);
  db.transaction(() => {
    if (req.params.state === "paid") {
      for (const it of items) {
        if (it.paid_at && it.paid_by_statement) {
          // Statement already paid: just move its invoices to the new payment date.
          db.prepare("UPDATE documents SET paid_at = ? WHERE id = ?").run(today, it.id);
          continue;
        }
        if (it.paid_at) continue; // already paid on its own
        syncDocsForStream(it.stream_id); // freeze the invoice as it stands now
        db.prepare("UPDATE documents SET paid_at = ? WHERE id = ?").run(today, it.id);
        db.prepare("UPDATE statement_items SET paid_by_statement = 1 WHERE document_id = ?").run(it.id);
      }
      db.prepare("UPDATE statements SET paid_at = ? WHERE id = ?").run(today, st.id);
    } else {
      for (const it of items) {
        if (!it.paid_by_statement) continue; // leave invoices that were paid separately
        db.prepare("UPDATE documents SET paid_at = NULL WHERE id = ?").run(it.id);
        db.prepare("UPDATE statement_items SET paid_by_statement = 0 WHERE document_id = ?").run(it.id);
        syncDocsForStream(it.stream_id);
      }
      db.prepare("UPDATE statements SET paid_at = NULL WHERE id = ?").run(st.id);
    }
  })();
  // Paid / unpaid shows on each billed person's CRM record.
  crm.enqueue(items.flatMap((it) => billedEmails(it.stream_id)));
  res.redirect(req.get("Referer") || `/admin/statements/${st.id}`);
});

router.post("/statements/:id(\\d+)/delete", (req, res) => {
  const st = loadStatement(req, res);
  if (!st) return;
  if (st.paid_at) return res.redirect(`/admin/statements?error=${encodeURIComponent(`Mark ${st.number} as unpaid before deleting it.`)}`);
  db.transaction(() => {
    db.prepare("DELETE FROM statement_items WHERE statement_id = ?").run(st.id);
    db.prepare("DELETE FROM statements WHERE id = ?").run(st.id);
  })();
  res.redirect("/admin/statements?notice=deleted");
});

// --------------------------------------------------------------- settings

const SETTING_FIELDS = [
  "business_name", "business_address", "business_phone", "business_email", "business_website",
  "ct_business_name", "ct_business_address", "ct_business_phone", "ct_business_email", "ct_business_website",
  "bank_name", "bank_branch_name", "bank_account_holder", "bank_account_number", "bank_branch_code", "bank_account_type", "bank_swift",
  "ct_bank_name", "ct_bank_branch_name", "ct_bank_account_holder", "ct_bank_account_number", "ct_bank_branch_code",
  "ct_bank_account_type", "ct_bank_swift", "crew_guidelines_message",
  "package_label", "package_details", "package_price", "transport_rate",
  "quote_valid_days", "invoice_due_days", "payment_terms", "vat_note",
];

router.get("/settings", (req, res) => {
  res.render("admin/settings", { s: getSettings(), notice: req.query.notice || null, crm: crm.status() });
});

// Send every contact to the Orange Platform CRM again (e.g. after fixing the settings).
router.post("/crm/resync", (req, res) => {
  crm.enqueueAll();
  res.redirect("/admin/settings?notice=crm-resync#crm");
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
module.exports.billedEmails = billedEmails;
module.exports.accountClients = accountClients;
module.exports.applyFuneralHome = applyFuneralHome;
module.exports.funeralHomes = funeralHomes;
