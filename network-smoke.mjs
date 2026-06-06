import assert from "node:assert/strict";
import { io } from "socket.io-client";

const url = process.env.TEST_SERVER_URL || "http://127.0.0.1:3001";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event, timeout = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
  socket.once(event, (payload) => {
    clearTimeout(timer);
    resolve(payload);
  });
});
const emitAck = (socket, event, payload) => new Promise((resolve) => {
  socket.emit(event, payload, resolve);
});

const host = io(url, { transports: ["websocket"] });
const guest = io(url, { transports: ["websocket"] });

try {
  await Promise.all([once(host, "connect"), once(guest, "connect")]);
  const created = await emitAck(host, "room:create", {
    name: `Authority test ${Date.now()}`,
    maxPlayers: 4,
    playerName: "Host",
  });
  assert.equal(created.ok, true);
  const joined = await emitAck(guest, "room:join", {
    roomId: created.room.id,
    playerName: "Guest",
  });
  assert.equal(joined.ok, true);

  host.emit("player:team", { playerId: host.id, team: "red" });
  host.emit("player:team", { playerId: guest.id, team: "blue" });
  await wait(100);
  const startedPromise = Promise.all([once(host, "room:started"), once(guest, "room:started")]);
  host.emit("room:start", { timeLimit: 1, scoreLimit: 3, proMode: false, keeperEnabled: false });
  await startedPromise;

  let hostSnapshot;
  let guestSnapshot;
  const hostSnapshotPromise = new Promise((resolve) => {
    host.on("match:snapshot", (snapshot) => {
      hostSnapshot = snapshot;
      if (snapshot.players.some((player) => player.id === guest.id && player.ack >= 35)) resolve();
    });
  });
  const guestSnapshotPromise = new Promise((resolve) => {
    guest.on("match:snapshot", (snapshot) => {
      guestSnapshot = snapshot;
      if (snapshot.players.some((player) => player.id === guest.id && player.ack >= 35)) resolve();
    });
  });

  for (let seq = 1; seq <= 34; seq += 1) {
    guest.emit("player:input", { seq, angle: Math.PI, vx: 0, vz: -10.5 });
    await wait(35);
  }
  guest.emit("player:input", { seq: 35, angle: Math.PI, vx: 0, vz: 0 });
  await Promise.all([hostSnapshotPromise, guestSnapshotPromise]);
  assert.deepEqual(hostSnapshot.players, guestSnapshot.players);
  assert.deepEqual(hostSnapshot.ball, guestSnapshot.ball);

  const kickId = `network-kick-${Date.now()}`;
  const kickedPromise = Promise.all([once(host, "ball:kicked"), once(guest, "ball:kicked")]);
  guest.emit("ball:kick", {
    kickId,
    power: 16.66,
    liftPower: 0.8,
    chargeRatio: 0,
    dir: { x: 0, z: -1 },
  });
  const [hostKick, guestKick] = await kickedPromise;
  assert.equal(hostKick.kickId, kickId);
  assert.equal(guestKick.kickId, kickId);
  const kickedSnapshot = await new Promise((resolve) => {
    guest.on("match:snapshot", (snapshot) => {
      if (snapshot.ball.lastKickId === kickId) resolve(snapshot);
    });
  });
  assert.ok(kickedSnapshot.ball.vz < -1);

  console.log("Network smoke test passed: two clients share state and guest kicks are authoritative.");
} finally {
  host.disconnect();
  guest.disconnect();
}
