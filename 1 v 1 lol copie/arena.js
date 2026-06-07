const canvas = document.querySelector("#arena");
const ctx = canvas.getContext("2d");
const overlay = document.querySelector("#overlay");
const startButton = document.querySelector("#startButton");
const botButton = document.querySelector("#botButton");
const roomInput = document.querySelector("#roomInput");
const roomLabel = document.querySelector("#roomLabel");
const playerHealth = document.querySelector("#playerHealth");
const botHealth = document.querySelector("#botHealth");
const rounds = document.querySelector("#rounds");
const isFilePreview = window.location.protocol === "file:";
const requestTimeoutMs = 12000;

const keys = new Set();
const mouse = { x: 600, y: 380, down: false };
const input = { dx: 0, dy: 0, angle: 0, shooting: false, build: false };

let session = null;
let remoteState = null;
let lastFrame = 0;
let sendTimer = 0;
let pollTimer = 0;
let world = { width: 1200, height: 760 };

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

async function joinRoom() {
  if (!serverIsAvailable()) return;
  const room = roomInput.value.trim() || "DUEL";
  await joinArena(room, false);
}

async function joinBot() {
  if (!serverIsAvailable()) return;
  const room = `BOT${Math.floor(1000 + Math.random() * 9000)}`;
  roomInput.value = room;
  await joinArena(room, true);
}

async function joinArena(room, bot) {
  setJoinControlsDisabled(true);
  showOverlay("Joining room", "Connecting to the arena server...");

  try {
    const { response, data } = await fetchJson("/api/arena/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, bot })
    });

    if (!response.ok) {
      showOverlay("Could not join", data.error || "Try another room code or refresh the page.");
      setJoinControlsDisabled(false);
      return;
    }

    session = data;
    world = data.world;
    roomLabel.textContent = `${data.room} / ${data.slot.toUpperCase()}`;
    overlay.classList.add("is-hidden");
    await pollState();
  } catch {
    showOverlay("Server is not responding", "Check that everyone is using the public website URL, not localhost. If the site was just opened, wait a few seconds and try again.");
    setJoinControlsDisabled(false);
  }
}

function update(delta) {
  updateInput();
  if (!session) return;

  sendTimer -= delta;
  pollTimer -= delta;

  if (sendTimer <= 0) {
    sendInput();
    input.build = false;
    sendTimer = 1 / 20;
  }

  if (pollTimer <= 0) {
    pollState();
    pollTimer = 1 / 20;
  }
}

function updateInput() {
  let dx = 0;
  let dy = 0;

  if (keys.has("w") || keys.has("arrowup")) dy -= 1;
  if (keys.has("s") || keys.has("arrowdown")) dy += 1;
  if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
  if (keys.has("d") || keys.has("arrowright")) dx += 1;

  const me = getMe();
  const aim = screenToWorld(mouse.x, mouse.y);

  input.dx = dx;
  input.dy = dy;
  input.shooting = mouse.down;
  input.angle = me ? Math.atan2(aim.y - me.y, aim.x - me.x) : 0;
}

async function sendInput() {
  if (!session) return;
  try {
    await fetchJson("/api/arena/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: session.room,
        playerId: session.playerId,
        input
      })
    });
  } catch {
    showOverlay("Disconnected", "Could not reach the arena server. Restart the server and refresh.");
  }
}

async function pollState() {
  if (!session) return;
  try {
    const { response, data } = await fetchJson(`/api/arena/state?room=${encodeURIComponent(session.room)}`);
    if (!response.ok) throw new Error(data.error || "State error");
    remoteState = data;
    world = data.world;

    if (!isCurrentSessionActive()) {
      session = null;
      remoteState = null;
      roomLabel.textContent = "Not joined";
      setJoinControlsDisabled(false);
      showOverlay("Rejoin room", "Your spot expired after being inactive. Click Join Room again to reconnect.");
      return;
    }

    updateHud();
    if (data.status !== "playing") {
      showStatus(data.message);
    } else {
      overlay.classList.add("is-hidden");
    }
  } catch {
    showOverlay("Disconnected", "Could not reach the arena server. Restart the server and refresh.");
  }
}

function draw() {
  drawArena();
  if (!remoteState) return;

  remoteState.walls.forEach(drawWall);
  remoteState.bullets.forEach(drawBullet);
  drawFighter(remoteState.players.p1, session?.slot === "p1");
  drawFighter(remoteState.players.p2, session?.slot === "p2");
  drawCrosshair();
}

function drawArena() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#10213d");
  gradient.addColorStop(0.55, "#0f172a");
  gradient.addColorStop(1, "#26123b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  for (let x = 0; x < world.width; x += 48) {
    const a = worldToScreen(x, 0);
    const b = worldToScreen(x, world.height);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (let y = 0; y < world.height; y += 48) {
    const a = worldToScreen(0, y);
    const b = worldToScreen(world.width, y);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawFighter(fighter, isMe) {
  if (!fighter?.id) return;
  const point = worldToScreen(fighter.x, fighter.y);
  const scale = getScale();

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(fighter.angle);
  ctx.fillStyle = fighter.color;
  ctx.shadowColor = fighter.color;
  ctx.shadowBlur = isMe ? 22 : 14;
  ctx.beginPath();
  ctx.arc(0, 0, fighter.radius * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#e2e8f0";
  ctx.fillRect(6 * scale, -5 * scale, 26 * scale, 10 * scale);
  ctx.fillStyle = isMe ? "#ffffff" : "#fecaca";
  ctx.beginPath();
  ctx.arc(0, 0, 7 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWall(wall) {
  const point = worldToScreen(wall.x, wall.y);
  const scale = getScale();
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(wall.angle);
  ctx.fillStyle = `rgba(34, 211, 238, ${0.25 + wall.health / 100})`;
  ctx.strokeStyle = "#a5f3fc";
  ctx.lineWidth = 2;
  ctx.fillRect(-wall.w * scale / 2, -wall.h * scale / 2, wall.w * scale, wall.h * scale);
  ctx.strokeRect(-wall.w * scale / 2, -wall.h * scale / 2, wall.w * scale, wall.h * scale);
  ctx.restore();
}

function drawBullet(bullet) {
  const point = worldToScreen(bullet.x, bullet.y);
  ctx.fillStyle = bullet.owner === "p1" ? "#facc15" : "#fb7185";
  ctx.beginPath();
  ctx.arc(point.x, point.y, bullet.radius * getScale(), 0, Math.PI * 2);
  ctx.fill();
}

function drawCrosshair() {
  if (!session) return;
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mouse.x - 9, mouse.y);
  ctx.lineTo(mouse.x + 9, mouse.y);
  ctx.moveTo(mouse.x, mouse.y - 9);
  ctx.lineTo(mouse.x, mouse.y + 9);
  ctx.stroke();
}

function updateHud() {
  const p1 = remoteState?.players?.p1;
  const p2 = remoteState?.players?.p2;
  const me = session?.slot === "p2" ? p2 : p1;
  const rival = session?.slot === "p2" ? p1 : p2;
  playerHealth.textContent = Math.max(0, Math.ceil(me?.health || 0));
  botHealth.textContent = Math.max(0, Math.ceil(rival?.health || 0));
  rounds.textContent = session ? `${remoteState.wins[session.slot]}-${remoteState.wins[session.slot === "p1" ? "p2" : "p1"]}` : "0";
}

function getMe() {
  if (!remoteState || !session) return null;
  return remoteState.players[session.slot];
}

function isCurrentSessionActive() {
  const me = getMe();
  return Boolean(me?.id && me.id === session?.playerId);
}

function worldToScreen(x, y) {
  return {
    x: x * canvas.clientWidth / world.width,
    y: y * canvas.clientHeight / world.height
  };
}

function screenToWorld(x, y) {
  return {
    x: x * world.width / canvas.clientWidth,
    y: y * world.height / canvas.clientHeight
  };
}

function getScale() {
  return Math.min(canvas.clientWidth / world.width, canvas.clientHeight / world.height);
}

function pointerPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function showOverlay(title, text) {
  overlay.querySelector("h2").textContent = title;
  overlay.querySelector("p").textContent = text;
  overlay.classList.remove("is-hidden");
}

function showStatus(text) {
  overlay.querySelector("h2").textContent = text;
  overlay.querySelector("p").textContent = "Keep this page open. The round starts when both players are connected.";
  startButton.textContent = "Join Room";
  overlay.classList.remove("is-hidden");
}

function serverIsAvailable() {
  if (!isFilePreview) return true;
  showOverlay("Open the website URL", "Start the local website server, then open http://localhost:3000 in Google Chrome. The game cannot connect to rooms from a direct file preview.");
  return false;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function setJoinControlsDisabled(disabled) {
  startButton.disabled = disabled;
  botButton.disabled = disabled;
  roomInput.disabled = disabled;
}

function loop(time) {
  const delta = Math.min(0.033, (time - lastFrame) / 1000 || 0);
  lastFrame = time;
  update(delta);
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) event.preventDefault();
  if (key === "q") input.build = true;
  keys.add(key);
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
});

canvas.addEventListener("mousemove", (event) => {
  Object.assign(mouse, pointerPoint(event));
});

canvas.addEventListener("mousedown", (event) => {
  mouse.down = true;
  Object.assign(mouse, pointerPoint(event));
});

window.addEventListener("mouseup", () => {
  mouse.down = false;
});

canvas.addEventListener("touchstart", (event) => {
  event.preventDefault();
  const touch = event.touches[0];
  if (!touch) return;
  mouse.down = true;
  Object.assign(mouse, pointerPoint(touch));
}, { passive: false });

canvas.addEventListener("touchmove", (event) => {
  event.preventDefault();
  const touch = event.touches[0];
  if (!touch) return;
  Object.assign(mouse, pointerPoint(touch));
}, { passive: false });

window.addEventListener("touchend", () => {
  mouse.down = false;
});

startButton.addEventListener("click", joinRoom);
botButton.addEventListener("click", joinBot);
roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
});
window.addEventListener("resize", resizeCanvas);

if (isFilePreview) {
  roomLabel.textContent = "Open http://localhost:3000";
  startButton.disabled = true;
  botButton.disabled = true;
  showOverlay("Open the website URL", "Start the local website server, then open http://localhost:3000 in Google Chrome. The game cannot connect to rooms from a direct file preview.");
}

resizeCanvas();
requestAnimationFrame(loop);
