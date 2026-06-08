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

  guest.disconnect();
  await wait(2200);
  guest = await connect(guestId);
  const resumed = await emitAck(guest, "room:resume", { roomId: created.room.id });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.room.started, true);
  assert.equal(resumed.room.matchState.matchId, matchId);
  assert.equal(resumed.room.players.find((player) => player.id === guestId)?.team, "blue");
  assert.equal(resumed.room.players.length, 2);

  const inputPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Resumed input was not acknowledged")), 3000);
    guest.on("match:snapshot", (snapshot) => {
      const player = snapshot.players.find((candidate) => candidate.id === guestId);
      if (player?.ack >= 1) {
        clearTimeout(timer);
        resolve(player);
      }
    });
  });
  guest.emit("player:input", {
    matchId,
    seq: 1,
    angle: 0,
    vx: 0,
    vz: 8,
    jump: false,
  });
  const resumedPlayer = await inputPromise;
  assert.equal(resumedPlayer.vz, 8);

  console.log("Reconnect smoke test passed: player identity, team and match survive a mobile-style pause.");
} finally {
  host.emit("room:leave");
  host.disconnect();
  guest.disconnect();
}
