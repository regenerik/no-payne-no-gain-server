import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import {
  SIMULATION_HZ,
  SNAPSHOT_HZ,
  createMatch,
  createSnapshot,
  kickBall,
  setPlayerInput,
  stepMatch,
  syncMatchPlayers,
  updateMatchSettings,
} from "./simulation.js";

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
    matchEndsAt: room.matchEndsAt || null,
    ping: room.ping,
    settings: room.settings,
    scores: room.scores,
    matchState: room.match ? createSnapshot(room) : null,
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
      started: room.started,
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
    matchEndsAt: null,
    ping: 20 + Math.floor(Math.random() * 48),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: {
      timeLimit: 3,
      unlimited: false,
      scoreLimit: 3,
      proMode: false,
      keeperEnabled: false,
    },
    scores: {
      red: 0,
      blue: 0,
    },
    ballSeq: 0,
    kickSeq: 0,
    playerSeqs: new Map(),
    lastKickId: null,
    matchNumber: 0,
    match: null,
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
  if (room.match) syncMatchPlayers(room);
  socket.leave(room.id);
  socket.data.roomId = null;

  if (room.players.size === 0) {
    rooms.delete(room.id);
    emitRooms();
    return;
  }

  if (room.hostId === socket.id) {
    closeRoom(room, "host-disconnected");
    return;
  }
  room.updatedAt = Date.now();
  emitRoom(room);
}

function closeRoom(room, reason = "host-left") {
  io.to(room.id).emit("room:closed", { reason });
  for (const playerId of room.players.keys()) {
    const playerSocket = io.sockets.sockets.get(playerId);
    if (playerSocket) {
      playerSocket.leave(room.id);
      playerSocket.data.roomId = null;
    }
  }
  rooms.delete(room.id);
  emitRooms();
}

function endMatch(room) {
  if (!room.started) return;
  room.started = false;
  room.matchEndsAt = null;
  room.match = null;
  room.updatedAt = Date.now();
  io.to(room.id).emit("room:ended", publicRoom(room));
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
    if (room.match) syncMatchPlayers(room);
    room.updatedAt = Date.now();
    socket.data.roomId = room.id;
    socket.join(room.id);
    ack?.({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:leave", () => {
    const room = getSocketRoom(socket);
    if (room && socket.id === room.hostId) {
      closeRoom(room);
      return;
    }
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
    if (room.match) syncMatchPlayers(room, false);
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
    if (room.match) syncMatchPlayers(room, false);
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
    if (room.match) syncMatchPlayers(room, false);
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on("room:settings", (settings = {}) => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    room.settings = {
      timeLimit: Math.max(1, Math.min(Number(settings.timeLimit) || room.settings.timeLimit, 15)),
      unlimited: Boolean(settings.unlimited),
      scoreLimit: Math.max(1, Math.min(Number(settings.scoreLimit) || room.settings.scoreLimit, 20)),
      proMode: Boolean(settings.proMode),
      keeperEnabled: Boolean(settings.keeperEnabled),
    };
    updateMatchSettings(room);
    room.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on("room:lock", (locked) => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    room.locked = Boolean(locked);
    emitRoom(room);
  });

  socket.on("room:start", (settings = {}) => {
    const room = getSocketRoom(socket);
    if (!room || socket.id !== room.hostId) return;
    if (settings && typeof settings === "object") {
      room.settings = {
        timeLimit: Math.max(1, Math.min(Number(settings.timeLimit) || room.settings.timeLimit, 15)),
        unlimited: settings.unlimited === undefined ? room.settings.unlimited : Boolean(settings.unlimited),
        scoreLimit: Math.max(1, Math.min(Number(settings.scoreLimit) || room.settings.scoreLimit, 20)),
        proMode: settings.proMode === undefined ? room.settings.proMode : Boolean(settings.proMode),
        keeperEnabled: settings.keeperEnabled === undefined ? room.settings.keeperEnabled : Boolean(settings.keeperEnabled),
      };
    }
    room.started = true;
    room.matchEndsAt = room.settings.unlimited
      ? null
      : Date.now() + Math.max(1, Number(room.settings.timeLimit) || 1) * 60 * 1000;
    room.scores = { red: 0, blue: 0 };
    for (const player of room.players.values()) {
      player.state = null;
    }
    room.matchNumber += 1;
    room.match = createMatch(room);
    room.updatedAt = Date.now();
    io.to(room.id).emit("room:started", publicRoom(room));
    emitRoom(room);
  });

  socket.on("ball:kick", (kick = {}) => {
    const room = getSocketRoom(socket);
    if (!room || !room.started || !room.match) return;
    if (kick.matchId !== room.match.id) return;
    const kickId = String(kick.kickId || `${socket.id}-${++room.kickSeq}`);
    const result = kickBall(room, socket.id, { ...kick, kickId });
    if (!result.ok) {
      socket.emit("ball:kick-rejected", { kickId });
      return;
    }
    room.lastKickId = result.kickId;
    io.to(room.id).emit("ball:kicked", {
      playerId: socket.id,
      kickId: result.kickId,
      power: Number(kick.power) || 0,
      chargeRatio: Number(kick.chargeRatio) || 0,
      liftPower: Number(kick.liftPower) || 0,
      soundKind: kick.soundKind || "shot",
      dir: {
        x: Number(kick.dir?.x) || 0,
        z: Number(kick.dir?.z) || 0,
      },
      serverTime: Date.now(),
    });
  });

  socket.on("player:input", (input = {}) => {
    const room = getSocketRoom(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player || !room.started || !room.match) return;
    if (input.matchId !== room.match.id) return;
    setPlayerInput(room, socket.id, input);
  });

  socket.on("spectator:confetti", ({ matchId } = {}) => {
    const room = getSocketRoom(socket);
    const player = room?.players.get(socket.id);
    if (!room?.started || !room.match || matchId !== room.match.id) return;
    if (!player || player.team !== "spectators") return;
    io.to(room.id).emit("spectator:confetti", {
      playerId: socket.id,
      matchId: room.match.id,
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

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.started && room.matchEndsAt && now >= room.matchEndsAt) {
      endMatch(room);
    }
  }
}, 1000);

let previousSimulationAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const elapsed = Math.min((now - previousSimulationAt) / 1000, 0.05);
  previousSimulationAt = now;
  for (const room of rooms.values()) {
    if (!room.started || !room.match) continue;
    const events = stepMatch(room, elapsed, now);
    for (const event of events) {
      if (event.type !== "goal") continue;
      room.updatedAt = now;
      io.to(room.id).emit("match:score", {
        scores: event.scores,
        scoringTeam: event.scoringTeam,
      });
      if (room.scores[event.scoringTeam] >= room.settings.scoreLimit) {
        setTimeout(() => {
          if (room.started) endMatch(room);
        }, 2100);
      }
    }
  }
}, 1000 / SIMULATION_HZ);

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started || !room.match) continue;
    io.to(room.id).volatile.emit("match:snapshot", createSnapshot(room, now));
  }
}, 1000 / SNAPSHOT_HZ);

server.listen(PORT, () => {
  console.log(`No Payne No Gain Socket Server listening on ${PORT}`);
});
