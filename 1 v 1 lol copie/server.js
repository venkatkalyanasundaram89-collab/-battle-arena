const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const root = __dirname;
const world = { width: 1200, height: 760 };
const rooms = new Map();
const playerTimeoutMs = 8000;
const emptyRoomTtlMs = 2 * 60 * 1000;
const staleRoomTtlMs = 20 * 60 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const publicFiles = new Set([
  "index.html",
  "arena.css",
  "arena.js",
  "favicon.svg"
]);

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && request.url === "/api/arena/join") {
      await handleJoin(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/arena/input") {
      await handleInput(request, response);
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/api/arena/state")) {
      handleState(request, response);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Server error" });
  }
});

server.listen(port, host, () => {
  console.log(`Arena server running on ${host}:${port}`);
});

setInterval(updateRooms, 1000 / 30);

async function handleJoin(request, response) {
  const body = await readJson(request);
  const code = sanitizeRoom(body.room);
  const room = getRoom(code);
  const now = Date.now();

  clearDisconnectedPlayers(room, now);
  const slot = room.players.p1.id ? "p2" : "p1";

  if (room.players.p1.id && room.players.p2.id) {
    sendJson(response, 409, { error: "Room is full. Try another room code." });
    return;
  }

  const playerId = makeId();
  room.players[slot] = makePlayer(slot, playerId);
  if (body.bot && slot === "p1") {
    room.players.p2 = makePlayer("p2", "__BOT__", true);
  }
  room.updatedAt = now;
  resetRound(room);

  sendJson(response, 200, { room: code, playerId, slot, world, bot: Boolean(body.bot) });
}

async function handleInput(request, response) {
  const body = await readJson(request);
  const room = rooms.get(sanitizeRoom(body.room));
  if (!room) {
    sendJson(response, 404, { error: "Room not found." });
    return;
  }

  const player = Object.values(room.players).find((item) => item.id === body.playerId);
  if (!player) {
    sendJson(response, 403, { error: "Player not in room." });
    return;
  }

  player.lastSeen = Date.now();
  room.updatedAt = player.lastSeen;
  player.input = {
    dx: clamp(Number(body.input?.dx || 0), -1, 1),
    dy: clamp(Number(body.input?.dy || 0), -1, 1),
    angle: clamp(Number(body.input?.angle || 0), -Math.PI * 2, Math.PI * 2),
    shooting: Boolean(body.input?.shooting),
    build: Boolean(body.input?.build)
  };

  sendJson(response, 200, { ok: true });
}

function handleState(request, response) {
  const params = new URL(request.url, `http://localhost:${port}`).searchParams;
  const room = rooms.get(sanitizeRoom(params.get("room")));
  if (!room) {
    sendJson(response, 404, { error: "Room not found." });
    return;
  }

  sendJson(response, 200, publicState(room));
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      status: "waiting",
      message: "Waiting for player 2...",
      players: {
        p1: makePlayer("p1", ""),
        p2: makePlayer("p2", "")
      },
      wins: { p1: 0, p2: 0 },
      bullets: [],
      walls: [],
      resetAt: 0,
      updatedAt: Date.now()
    });
  }
  return rooms.get(code);
}

function makePlayer(slot, id, isBot = false) {
  const isP1 = slot === "p1";
  return {
    id,
    isBot,
    slot,
    x: isP1 ? 170 : 1030,
    y: 380,
    radius: 18,
    color: isP1 ? "#3b82f6" : "#ff06d6",
    health: 100,
    angle: isP1 ? 0 : Math.PI,
    shotCooldown: 0,
    buildCooldown: 0,
    lastSeen: Date.now(),
    input: { dx: 0, dy: 0, angle: isP1 ? 0 : Math.PI, shooting: false, build: false }
  };
}

function resetRound(room) {
  const p1Id = room.players.p1.id;
  const p2Id = room.players.p2.id;
  room.players.p1 = makePlayer("p1", p1Id, room.players.p1.isBot);
  room.players.p2 = makePlayer("p2", p2Id, room.players.p2.isBot);
  room.bullets = [];
  room.walls = [];
  room.status = p1Id && p2Id ? "playing" : "waiting";
  room.message = room.status === "playing" ? "Duel live" : "Waiting for player 2...";
}

function updateRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    clearDisconnectedPlayers(room, now);

    const hasPlayers = room.players.p1.id || room.players.p2.id;
    const ttl = hasPlayers ? staleRoomTtlMs : emptyRoomTtlMs;
    if (now - room.updatedAt > ttl) {
      rooms.delete(code);
      continue;
    }

    if (room.status === "ended" && now >= room.resetAt) {
      resetRound(room);
    }

    updateRoom(room, 1 / 30, now);
  }
}

function updateRoom(room, delta, now) {
  const p1Connected = isPlayerConnected(room.players.p1, now);
  const p2Connected = isPlayerConnected(room.players.p2, now);

  if (!p1Connected || !p2Connected) {
    room.status = "waiting";
    room.message = getWaitingMessage(room);
    return;
  }

  if (room.status !== "playing") return;

  updateBotInput(room);

  for (const player of Object.values(room.players)) {
    player.shotCooldown = Math.max(0, player.shotCooldown - delta);
    player.buildCooldown = Math.max(0, player.buildCooldown - delta);
    player.angle = player.input.angle;

    const length = Math.hypot(player.input.dx, player.input.dy) || 1;
    player.x += player.input.dx / length * 285 * delta;
    player.y += player.input.dy / length * 285 * delta;
    player.x = clamp(player.x, player.radius, world.width - player.radius);
    player.y = clamp(player.y, 92, world.height - player.radius);
    resolveWallCollision(room, player);

    if (player.input.build && player.buildCooldown <= 0) {
      addWall(room, player);
      player.buildCooldown = 0.75;
    }

    if (player.input.shooting && player.shotCooldown <= 0) {
      addBullet(room, player);
      player.shotCooldown = 0.22;
    }
  }

  updateBullets(room, delta);
  updateWalls(room, delta);

  if (room.players.p1.health <= 0 || room.players.p2.health <= 0) {
    const winner = room.players.p1.health > room.players.p2.health ? "p1" : "p2";
    room.wins[winner] += 1;
    room.status = "ended";
    room.message = `${winner.toUpperCase()} won the round`;
    room.resetAt = now + 2600;
  }
}

function clearDisconnectedPlayers(room, now) {
  let changed = false;

  for (const slot of ["p1", "p2"]) {
    const player = room.players[slot];
    if (!player.id || player.isBot || isPlayerConnected(player, now)) continue;
    room.players[slot] = makePlayer(slot, "");
    changed = true;
  }

  if (changed) {
    if (room.players.p1.isBot && !room.players.p2.id) room.players.p1 = makePlayer("p1", "");
    if (room.players.p2.isBot && !room.players.p1.id) room.players.p2 = makePlayer("p2", "");
    room.bullets = [];
    room.walls = [];
    room.status = "waiting";
    room.message = getWaitingMessage(room);
    room.resetAt = 0;
    room.updatedAt = now;
  }
}

function isPlayerConnected(player, now) {
  return Boolean(player.id) && (player.isBot || now - player.lastSeen < playerTimeoutMs);
}

function getWaitingMessage(room) {
  if (!room.players.p1.id && !room.players.p2.id) return "Waiting for players...";
  if (!room.players.p1.id) return "Waiting for player 1...";
  if (!room.players.p2.id) return "Waiting for player 2...";
  return "Waiting for both players...";
}

function updateBotInput(room) {
  const bot = Object.values(room.players).find((player) => player.isBot);
  if (!bot) return;

  const target = bot.slot === "p1" ? room.players.p2 : room.players.p1;
  if (!target.id) return;

  const dx = target.x - bot.x;
  const dy = target.y - bot.y;
  const distance = Math.hypot(dx, dy) || 1;
  let moveX = 0;
  let moveY = 0;

  if (distance > 330) {
    moveX += dx / distance;
    moveY += dy / distance;
  } else if (distance < 220) {
    moveX -= dx / distance;
    moveY -= dy / distance;
  }

  moveX += Math.sin(Date.now() / 430) * 0.55;
  moveY += Math.cos(Date.now() / 510) * 0.35;

  bot.input = {
    dx: clamp(moveX, -1, 1),
    dy: clamp(moveY, -1, 1),
    angle: Math.atan2(target.y - bot.y, target.x - bot.x),
    shooting: hasLineOfSight(room, bot, target),
    build: bot.buildCooldown <= 0 && hasLineOfSight(room, target, bot) && Math.random() > 0.985
  };
}

function hasLineOfSight(room, from, to) {
  const steps = 18;
  for (let index = 1; index < steps; index += 1) {
    const amount = index / steps;
    const x = from.x + (to.x - from.x) * amount;
    const y = from.y + (to.y - from.y) * amount;
    if (room.walls.some((wall) => pointInRotatedRect(x, y, wall))) return false;
  }
  return true;
}

function addBullet(room, player) {
  room.bullets.push({
    x: player.x + Math.cos(player.angle) * 24,
    y: player.y + Math.sin(player.angle) * 24,
    vx: Math.cos(player.angle) * 720,
    vy: Math.sin(player.angle) * 720,
    owner: player.slot,
    life: 1.2,
    radius: 4
  });
}

function addWall(room, player) {
  room.walls.push({
    x: player.x + Math.cos(player.angle) * 56,
    y: player.y + Math.sin(player.angle) * 56,
    w: 96,
    h: 18,
    angle: player.angle + Math.PI / 2,
    health: 70,
    life: 8
  });
}

function updateBullets(room, delta) {
  for (const bullet of room.bullets) {
    bullet.x += bullet.vx * delta;
    bullet.y += bullet.vy * delta;
    bullet.life -= delta;

    for (const wall of room.walls) {
      if (pointInRotatedRect(bullet.x, bullet.y, wall)) {
        bullet.life = 0;
        wall.health -= 22;
      }
    }

    const target = bullet.owner === "p1" ? room.players.p2 : room.players.p1;
    if (target.id && Math.hypot(bullet.x - target.x, bullet.y - target.y) < target.radius + bullet.radius) {
      target.health -= 12;
      bullet.life = 0;
    }
  }

  room.bullets = room.bullets.filter((bullet) => {
    return bullet.life > 0
      && bullet.x > -20
      && bullet.y > -20
      && bullet.x < world.width + 20
      && bullet.y < world.height + 20;
  });
}

function updateWalls(room, delta) {
  for (const wall of room.walls) {
    wall.life -= delta;
  }
  room.walls = room.walls.filter((wall) => wall.life > 0 && wall.health > 0);
}

function resolveWallCollision(room, player) {
  for (const wall of room.walls) {
    if (!pointInRotatedRect(player.x, player.y, { ...wall, w: wall.w + player.radius, h: wall.h + player.radius })) continue;
    player.x -= Math.cos(player.angle) * 8;
    player.y -= Math.sin(player.angle) * 8;
  }
}

function pointInRotatedRect(x, y, rect) {
  const cos = Math.cos(-rect.angle);
  const sin = Math.sin(-rect.angle);
  const dx = x - rect.x;
  const dy = y - rect.y;
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return Math.abs(rx) <= rect.w / 2 && Math.abs(ry) <= rect.h / 2;
}

function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    message: room.message,
    world,
    players: room.players,
    wins: room.wins,
    bullets: room.bullets,
    walls: room.walls
  };
}

function serveStatic(request, response) {
  const urlPath = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname);
  const requested = urlPath === "/" || urlPath === "/arena.html"
    ? "index.html"
    : path.basename(urlPath);

  if (!publicFiles.has(requested)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const filePath = path.join(root, requested);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": requested === "index.html" ? "no-store" : "public, max-age=3600"
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(content);
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sanitizeRoom(value) {
  return String(value || "DUEL").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "DUEL";
}

function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}
