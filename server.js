import express from "express";
import http from "node:http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const ROOM_TTL_MS = 1000 * 60 * 60 * 3;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

const rooms = new Map();

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    score: player.score || 0,
    state: player.state || null,
  };
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    locked: room.locked,
    started: room.started,
    ping: room.ping,
    settings: room.settings,
    scores: room.scores,
    players: [...room.players.values()].map(publicPlayer),
  };
}

function roomList() {
  return [...rooms.values()]
    .filter((room) => Date.now() - room.updatedAt < ROOM_TTL_MS)
    .map((room) => ({
      id: room.id,
      name: room.name,
      ping: room.ping,
      maxPlayers: room.maxPlayers,
      players: [...room.players.values()].map(publicPlayer),
    }));
}

function emitRooms() {
  io.emit("rooms:update", roomList());
}

function emitRoom(room) {
  io.to(room.id).emit("room:state", publicRoom(room));
  emitRooms();
}

function slugRoomName(name) {
  return String(name || "payne-room")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 28) || "payne-room";
}

function createRoom({ name, maxPlayers, host }) {
  const base = slugRoomName(name);
  let id = base;
  let suffix = 2;
  while (rooms.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }

  const room = {
    id,
    name: String(name || "payne's room").trim().slice(0, 22) || "payne's room",
    maxPlayers: Math.max(2, Math.min(Number(maxPlayers) || 12, 16)),
    hostId: host.id,
    locked: false,
    started: false,
    ping: 20 + Math.floor(Math.random() * 48),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: {
      timeLimit: 3,
      scoreLimit: 3,
      proMode: true,
    },
    scores: {
      red: 0,
      blue: 0,
    },
    players: new Map(),
  };
  room.players.set(host.id, host);
  rooms.set(id, room);
  return room;
}

function getSocketRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return null;
  return rooms.get(roomId) || null;
}

function leaveCurrentRoom(socket) {
  const room = getSocketRoom(socket);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.id);
  socket.data.roomId = null;

  if (room.players.size === 0) {
    rooms.delete(room.id);
    emitRooms();
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = [...room.players.keys()][0];
  }
  room.updatedAt = Date.now();
  emitRoom(room);
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "No Payne No Gain Socket Server",
    rooms: roomList().length,
  });
});

io.on("connection", (socket) => {
  socket.emit("rooms:update", roomList());

  socket.on("rooms:list", (ack) => {
    ack?.({ ok: true, rooms: roomList() });
  });

  socket.on("room:create", (payload = {}, ack) => {
    leaveCurrentRoom(socket);
    const host = {
      id: socket.id,
      name: String(payload.playerName || "davo").trim().slice(0, 18) || "davo",
      team: "spectators",
      score: 0,
      state: null,
    };
    const room = createRoom({
      name: payload.name,
      maxPlayers: payload.maxPlayers,
      host,
    });
    socket.data.roomId = room.id;
    socket.join(room.id);
    ack?.({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:join", (payload = {}, ack) => {
    const room = rooms.get(payload.roomId);
    if (!room) {
      ack?.({ ok: false, error: "Room not found" });
      return;
    }
    if (room.locked || room.players.size >= room.maxPlayers) {
      ack?.({ ok: false, error: "Room unavailable" });
      return;
    }
    leaveCurrentRoom(socket);
    room.players.set(socket.id, {
      id: socket.id,
      name: String(payload.playerName || "player").trim().slice(0, 18) || "player",
      team: "spectators",
      score: 0,
      state: null,
    });
    room.updatedAt = Date.now();
    socket.data.roomId = room.id;
    socket.join(room.id);
    ack?.({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:leave", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("player:team", ({ playerId, team } = {}) => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    if (!["red", "blue", "spectators"].includes(team)) return;
    const player = room.players.get(playerId);
    if (!player) return;
    player.team = team;
    player.state = null;
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on("room:autoTeams", () => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    [...room.players.values()].forEach((player, index) => {
      player.team = index % 2 === 0 ? "red" : "blue";
      player.state = null;
    });
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on("room:resetTeams", () => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    [...room.players.values()].forEach((player) => {
      player.team = "spectators";
      player.state = null;
    });
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on("room:settings", (settings = {}) => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    room.settings = {
      timeLimit: Math.max(1, Math.min(Number(settings.timeLimit) || room.settings.timeLimit, 15)),
      scoreLimit: Math.max(1, Math.min(Number(settings.scoreLimit) || room.settings.scoreLimit, 20)),
      proMode: Boolean(settings.proMode),
    };
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on("room:lock", (locked) => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    room.locked = Boolean(locked);
    emitRoom(room);
  });

  socket.on("room:start", () => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    room.started = true;
    room.scores = { red: 0, blue: 0 };
    room.updatedAt = Date.now();
    io.to(room.id).emit("room:started", publicRoom(room));
    emitRoom(room);
  });

  socket.on("player:state", (state = {}) => {
    const room = getSocketRoom(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;
    player.state = {
      x: Number(state.x) || 0,
      y: Number(state.y) || 0,
      z: Number(state.z) || 0,
      angle: Number(state.angle) || 0,
      moving: Boolean(state.moving),
      t: Date.now(),
    };
    socket.to(room.id).emit("player:state", {
      playerId: socket.id,
      state: player.state,
    });
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) {
      rooms.delete(id);
      changed = true;
    }
  }
  if (changed) emitRooms();
}, 1000 * 60 * 10);

server.listen(PORT, () => {
  console.log(`No Payne No Gain Socket Server listening on ${PORT}`);
});
