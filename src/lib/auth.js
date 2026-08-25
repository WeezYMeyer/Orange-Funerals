function requireStaff(req, res, next) {
  if (req.session && req.session.staffId) return next();
  return res.redirect("/admin/login");
}

module.exports = { requireStaff };
