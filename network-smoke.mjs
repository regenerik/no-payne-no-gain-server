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
const socketById = (id, host, guest) => id === host.id ? host : guest;

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
  const [firstHostRoom, firstGuestRoom] = await startedPromise;
  assert.equal(firstHostRoom.matchState.matchId, firstGuestRoom.matchState.matchId);
  const firstMatchId = firstHostRoom.matchState.matchId;
  const firstTakerSocket = socketById(firstHostRoom.matchState.kickoffTakerId, host, guest);
  firstTakerSocket.emit("ball:kick", {
    kickId: `opening-${Date.now()}`,
    power: 0,
    liftPower: 0,
    chargeRatio: 0,
    dir: { x: 1, z: 0 },
  });
  await wait(100);

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

  const restartedPromise = Promise.all([once(host, "room:started"), once(guest, "room:started")]);
  host.emit("room:start", { timeLimit: 1, scoreLimit: 3, proMode: false, keeperEnabled: false });
  const [secondHostRoom, secondGuestRoom] = await restartedPromise;
  const secondMatchId = secondHostRoom.matchState.matchId;
  assert.equal(secondMatchId, secondGuestRoom.matchState.matchId);
  assert.notEqual(secondMatchId, firstMatchId);
  assert.equal(secondHostRoom.matchState.kickoffLocked, true);
  assert.ok(secondHostRoom.matchState.kickoffTakerId);

  const secondTakerSocket = socketById(secondHostRoom.matchState.kickoffTakerId, host, guest);
  secondTakerSocket.emit("ball:kick", {
    kickId: `restart-opening-${Date.now()}`,
    power: 0,
    liftPower: 0,
    chargeRatio: 0,
    dir: { x: -1, z: 0 },
  });
  await wait(100);
  const movingSocket = secondHostRoom.matchState.kickoffTakerId === guest.id ? host : guest;
  const movingId = movingSocket.id;
  const beforeRestartMove = secondHostRoom.matchState.players.find((player) => player.id === movingId);
  for (let seq = 1; seq <= 8; seq += 1) {
    movingSocket.emit("player:input", { seq, angle: 0, vx: 6, vz: 0 });
    await wait(35);
  }
  const restartedSnapshot = await new Promise((resolve) => {
    guest.on("match:snapshot", (snapshot) => {
      const moved = snapshot.players.find((player) => player.id === movingId);
      if (snapshot.matchId === secondMatchId && moved?.ack >= 8) resolve(snapshot);
    });
  });
  const afterRestartMove = restartedSnapshot.players.find((player) => player.id === movingId);
  assert.ok(afterRestartMove.x > beforeRestartMove.x + 0.5);

  console.log("Network smoke test passed: consecutive starts use isolated match state and players move.");
} finally {
  host.disconnect();
  guest.disconnect();
}
