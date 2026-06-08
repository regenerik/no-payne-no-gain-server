import assert from "node:assert/strict";
import { io } from "socket.io-client";

const url = process.env.TEST_SERVER_URL || "http://127.0.0.1:3001";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connect = (playerId) => {
  const socket = io(url, {
    transports: ["websocket"],
    auth: { playerId },
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
};
const emitAck = (socket, event, payload) => new Promise((resolve) => {
  socket.emit(event, payload, resolve);
});

const hostId = `resume-host-${Date.now()}`;
const guestId = `resume-guest-${Date.now()}`;
const host = await connect(hostId);
let guest = await connect(guestId);
let roomClosedByHost = false;

try {
  const created = await emitAck(host, "room:create", {
    name: `Reconnect test ${Date.now()}`,
    maxPlayers: 4,
    playerName: "Host",
  });
  assert.equal(created.ok, true);

  const joined = await emitAck(guest, "room:join", {
    roomId: created.room.id,
    playerName: "Guest",
  });
  assert.equal(joined.ok, true);
  host.emit("player:team", { playerId: hostId, team: "red" });
  host.emit("player:team", { playerId: guestId, team: "blue" });
  await wait(120);

  const startedPromise = new Promise((resolve) => guest.once("room:started", resolve));
  host.emit("room:start", {
    timeLimit: 3,
    scoreLimit: 3,
    proMode: false,
    keeperEnabled: false,
  });
  const started = await startedPromise;
  const matchId = started.matchState.matchId;
  assert.equal(started.players.find((player) => player.id === guestId)?.team, "blue");

  const movedBeforeDisconnect = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Player did not move before disconnect")), 3000);
    guest.on("match:snapshot", (snapshot) => {
      const player = snapshot.players.find((candidate) => candidate.id === guestId);
      if (player?.ack >= 9) {
        clearTimeout(timer);
        resolve(player);
      }
    });
  });
  for (let seq = 1; seq <= 8; seq += 1) {
    guest.emit("player:input", {
      matchId,
      seq,
      angle: Math.PI / 2,
      vx: 7,
      vz: 0,
      jump: false,
    });
    await wait(40);
  }
  guest.emit("player:input", {
    matchId,
    seq: 9,
    angle: Math.PI / 2,
    vx: 0,
    vz: 0,
    jump: false,
  });
  const positionBeforeDisconnect = await movedBeforeDisconnect;
  guest.disconnect();
  await wait(2200);
  guest = await connect(guestId);
  const resumed = await emitAck(guest, "room:resume", { roomId: created.room.id });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.room.started, true);
  assert.equal(resumed.room.matchState.matchId, matchId);
  assert.equal(resumed.room.players.find((player) => player.id === guestId)?.team, "blue");
  assert.equal(resumed.room.players.length, 2);
  const positionAfterResume = resumed.room.matchState.players.find((player) => player.id === guestId);
  assert.equal(positionAfterResume.x, positionBeforeDisconnect.x);
  assert.equal(positionAfterResume.z, positionBeforeDisconnect.z);

  const inputPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Resumed input was not acknowledged")), 3000);
    guest.on("match:snapshot", (snapshot) => {
      const player = snapshot.players.find((candidate) => candidate.id === guestId);
      if (player?.ack >= 10) {
        clearTimeout(timer);
        resolve(player);
      }
    });
  });
  guest.emit("player:input", {
    matchId,
    seq: 10,
    angle: 0,
    vx: 0,
    vz: 8,
    jump: false,
  });
  const resumedPlayer = await inputPromise;
  assert.equal(resumedPlayer.vz, 8);

  const roomClosedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Guest was not notified when host left")), 3000);
    guest.once("room:closed", (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
  host.emit("room:leave");
  const closedPayload = await roomClosedPromise;
  roomClosedByHost = true;
  assert.equal(closedPayload.reason, "host-left");

  console.log("Reconnect smoke test passed: player identity, team and match survive a mobile-style pause.");
} finally {
  if (!roomClosedByHost) host.emit("room:leave");
  host.disconnect();
  guest.disconnect();
}
