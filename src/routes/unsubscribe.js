const express = require("express");
const db = require("../lib/db");
const crm = require("../lib/crmSync");

const router = express.Router();

router.get("/:token", (req, res) => {
  const contact = db.prepare("SELECT * FROM contacts WHERE unsub_token = ?").get(req.params.token);
  if (!contact) return res.status(404).render("unsubscribed", { found: false });

  db.prepare("UPDATE contacts SET opt_out = 1 WHERE id = ?").run(contact.id);
  crm.enqueue(contact.email); // the platform marks them unsubscribed too
  res.render("unsubscribed", { found: true });
});

module.exports = router;
