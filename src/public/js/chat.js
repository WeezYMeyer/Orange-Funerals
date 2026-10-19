(function () {
  const slug = window.__STREAM_SLUG__;
  const viewerName = window.__VIEWER_NAME__ || "Guest";
  const socket = io();

  const layoutEl = document.getElementById("stream-layout");
  const messagesEl = document.getElementById("chat-messages");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderMessage(msg) {
    const row = document.createElement("div");
    row.className = "chat-message";
    if (msg.id) row.dataset.id = msg.id;
    row.innerHTML = `<span class="name">${escapeHtml(msg.name)}:</span> ${escapeHtml(msg.body)}`;
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  socket.on("connect", () => {
    socket.emit("chat:join", { slug });
  });

  socket.on("chat:history", (history) => {
    messagesEl.innerHTML = "";
    history.forEach(renderMessage);
  });

  socket.on("chat:message", renderMessage);

  // Staff removed a message: take it off everyone's screen.
  socket.on("chat:deleted", ({ id }) => {
    const row = messagesEl.querySelector(`[data-id="${Number(id)}"]`);
    if (row) row.remove();
  });

  // Staff switched chat on or off for this page.
  socket.on("chat:state", ({ enabled }) => {
    if (layoutEl) layoutEl.classList.toggle("no-chat", !enabled);
  });

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = inputEl.value.trim();
    if (!body) return;
    socket.emit("chat:message", { slug, name: viewerName, body });
    inputEl.value = "";
  });
})();
