require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { Server: SocketIOServer } = require("socket.io");

const db = require("./lib/db");
const adminRoutes = require("./routes/admin");
const watchRoutes = require("./routes/watch");
const unsubscribeRoutes = require("./routes/unsubscribe");

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

const PORT = process.env.PORT || 3000;

// --- View engine & static assets ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// --- Body parsing ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Sessions ---
// Uses the default in-memory store, which is fine for a single-process
// deployment (one small VPS / one Render service). If you ever run more
// than one server instance behind a load balancer, swap this for a shared
// store (e.g. Redis) so login/email-gate sessions stay consistent.
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 days
  })
);

// --- Routes ---
app.get("/", (req, res) => res.redirect("/admin"));
app.use("/admin", adminRoutes);
app.use("/watch", watchRoutes);
app.use("/unsubscribe", unsubscribeRoutes);
app.use("/api", require("./routes/feed")); // calendar feed for Orange Platform

app.use((req, res) => res.status(404).send("Not found"));

// --- Live chat (Socket.io) ---
// One room per stream slug. Messages are persisted so a viewer who joins
// late still sees the conversation so far.
io.on("connection", (socket) => {
  socket.on("chat:join", ({ slug }) => {
    if (!slug) return;
    socket.join(`stream:${slug}`);

    const stream = db.prepare("SELECT id FROM streams WHERE slug = ?").get(slug);
    if (!stream) return;

    const history = db
      .prepare(
        "SELECT name, body, created_at FROM chat_messages WHERE stream_id = ? ORDER BY id DESC LIMIT 50"
      )
      .all(stream.id)
      .reverse();

    socket.emit("chat:history", history);
  });

  socket.on("chat:message", ({ slug, name, body }) => {
    const cleanName = String(name || "Guest").trim().slice(0, 60) || "Guest";
    const cleanBody = String(body || "").trim().slice(0, 500);
    if (!slug || !cleanBody) return;

    const stream = db.prepare("SELECT id FROM streams WHERE slug = ?").get(slug);
    if (!stream) return;

    db.prepare("INSERT INTO chat_messages (stream_id, name, body) VALUES (?, ?, ?)").run(
      stream.id,
      cleanName,
      cleanBody
    );

    io.to(`stream:${slug}`).emit("chat:message", {
      name: cleanName,
      body: cleanBody,
      created_at: new Date().toISOString(),
    });
  });
});

server.listen(PORT, () => {
  console.log(`Funeral streams platform running at http://localhost:${PORT}`);
});
