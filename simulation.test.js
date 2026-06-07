import assert from "node:assert/strict";
import test from "node:test";
import {
  FIELD,
  createMatch,
  createSnapshot,
  kickBall,
  setPlayerInput,
  stepMatch,
} from "./simulation.js";

function makeRoom({ proMode = false, keeperEnabled = false, initialKickoff = false } = {}) {
  const room = {
    id: "test-room",
    matchNumber: 1,
    random: () => 0,
    started: true,
    matchEndsAt: Date.now() + 60_000,
    settings: { proMode, keeperEnabled, scoreLimit: 3, timeLimit: 1, unlimited: false },
    scores: { red: 0, blue: 0 },
    players: new Map([
      ["red", { id: "red", name: "Red", team: "red" }],
      ["blue", { id: "blue", name: "Blue", team: "blue" }],
    ]),
  };
  room.match = createMatch(room);
  if (!initialKickoff) room.match.kickoff = { locked: false, team: null, takerId: null };
  return room;
}

function addSpectator(room, id = "viewer") {
  room.players.set(id, { id, name: "Viewer", team: "spectators" });
  room.match = createMatch(room);
  room.match.kickoff = { locked: false, team: null, takerId: null };
  return room.match.players.get(id);
}

test("the server advances players from inputs and acknowledges the sequence", () => {
  const room = makeRoom();
  const before = room.match.players.get("red").z;
  setPlayerInput(room, "red", { seq: 7, angle: 0, vx: 0, vz: 10.5 });
  for (let i = 0; i < 60; i += 1) stepMatch(room, 1 / 60);
  const player = room.match.players.get("red");
  assert.ok(player.z > before + 9);
  assert.equal(createSnapshot(room).players.find(({ id }) => id === "red").ack, 7);
});

test("a kick is validated and simulated by the server", () => {
  const room = makeRoom({ proMode: true });
  const red = room.match.players.get("red");
  red.x = 0;
  red.z = -1;
  room.match.ball.x = 0;
  room.match.ball.z = 0;
  const result = kickBall(room, "red", {
    kickId: "kick-1",
    power: 27.75,
    liftPower: 2.2,
    dir: { x: 0, z: 1 },
  });
  assert.equal(result.ok, true);
  const before = room.match.ball.z;
  stepMatch(room, 1 / 60);
  assert.ok(room.match.ball.z > before);
  assert.equal(room.match.ball.lastKickId, "kick-1");
});

test("goals, score and kickoff are authoritative", () => {
  const room = makeRoom({ proMode: true });
  room.match.ball.x = 0;
  room.match.ball.z = 37.5;
  room.match.ball.vz = 20;
  const events = stepMatch(room, 1 / 60, 1_000);
  assert.equal(events[0].scoringTeam, "red");
  assert.equal(room.scores.red, 1);
  stepMatch(room, 1 / 60, 2_000);
  assert.equal(room.match.kickoff.locked, true);
  assert.equal(room.match.kickoff.team, "blue");
  assert.equal(room.match.kickoff.takerId, "blue");
  assert.equal(room.match.players.get("blue").z, 0);
});

test("kickoff unlocks when the designated player kicks", () => {
  const room = makeRoom({ proMode: true });
  room.match.kickoff = { locked: true, team: "red", takerId: "red" };
  const red = room.match.players.get("red");
  red.x = 0;
  red.z = 0;
  room.match.ball.x = 0;
  room.match.ball.z = 0;
  setPlayerInput(room, "red", { seq: 1, angle: Math.PI, vx: 10, vz: 0 });
  stepMatch(room, 1 / 60);
  assert.equal(red.x, 0);
  const result = kickBall(room, "red", { power: 16, dir: { x: 0, z: -1 } });
  assert.equal(result.ok, true);
  assert.equal(room.match.kickoff.locked, false);
});

test("a new match starts with one randomly selected team taking kickoff", () => {
  const room = makeRoom({ proMode: true, initialKickoff: true });
  assert.equal(room.match.kickoff.locked, true);
  assert.equal(room.match.kickoff.team, "red");
  assert.equal(room.match.kickoff.takerId, "red");
  assert.equal(room.match.players.get("red").x, 0);
  assert.equal(room.match.players.get("red").z, 0);
});

test("all players stay in their own half until kickoff", () => {
  const room = makeRoom({ proMode: true });
  room.match.kickoff = { locked: true, team: "red", takerId: "red" };
  const red = room.match.players.get("red");
  const blue = room.match.players.get("blue");
  red.x = 0;
  red.z = 0;
  blue.z = 0.35;
  setPlayerInput(room, "red", { seq: 1, angle: 0, vx: 0, vz: 10.5 });
  setPlayerInput(room, "blue", { seq: 1, angle: Math.PI, vx: 0, vz: -10.5 });
  for (let i = 0; i < 30; i += 1) stepMatch(room, 1 / 60);
  assert.equal(red.z, 0);
  assert.ok(blue.z >= 0.35);
});

test("the ball rebounds from field boundaries", () => {
  const room = makeRoom({ proMode: true });
  room.match.ball.x = 20.57;
  room.match.ball.vx = 12;
  stepMatch(room, 1 / 30);
  assert.ok(room.match.ball.vx < 0);
  assert.ok(room.match.ball.x <= 20.58);
});

test("no-pro possession belongs to the nearest server-side player", () => {
  const room = makeRoom({ proMode: false });
  const red = room.match.players.get("red");
  red.x = 0;
  red.z = 0;
  room.match.ball.x = 0;
  room.match.ball.z = 1;
  stepMatch(room, 1 / 60);
  assert.equal(room.match.ball.ownerId, "red");
});

test("enabled keepers are included in authoritative snapshots", () => {
  const room = makeRoom({ proMode: true, keeperEnabled: true });
  const snapshot = createSnapshot(room);
  assert.equal(snapshot.keepers.length, 2);
  assert.deepEqual(snapshot.keepers.map(({ side }) => side), [-1, 1]);
});

test("snapshots identify the match so stale packets can be discarded", () => {
  const room = makeRoom();
  const first = createSnapshot(room);
  room.matchNumber += 1;
  room.match = createMatch(room);
  const second = createSnapshot(room);
  assert.notEqual(first.matchId, second.matchId);
});

test("spectators walk and jump on the stands without entering the field", () => {
  const room = makeRoom({ proMode: false });
  const spectator = addSpectator(room);
  const initialY = spectator.y;
  assert.equal(spectator.angle, Math.PI / 4);
  setPlayerInput(room, "viewer", {
    seq: 1,
    angle: Math.PI / 2,
    vx: 14,
    vz: 0,
    jump: true,
  });
  for (let i = 0; i < 10; i += 1) stepMatch(room, 1 / 60);
  assert.ok(spectator.y > initialY);
  for (let i = 0; i < 180; i += 1) stepMatch(room, 1 / 60);
  assert.ok(
    Math.abs(spectator.x) >= FIELD.width / 2 + 5
      || Math.abs(spectator.z) >= FIELD.length / 2 + 5
  );
  assert.equal(kickBall(room, "viewer", { power: 52, dir: { x: 0, z: 1 } }).ok, false);
  room.match.ball.x = spectator.x;
  room.match.ball.z = spectator.z;
  stepMatch(room, 1 / 60);
  assert.notEqual(room.match.ball.ownerId, "viewer");
});

test("spectators keep their stand position when a goal resets the field", () => {
  const room = makeRoom({ proMode: true });
  const spectator = addSpectator(room);
  spectator.x = -(FIELD.width / 2 + 10.2);
  spectator.y = 3.53;
  spectator.z = 11.4;
  spectator.angle = 1.37;
  spectator.input = { seq: 9, angle: 1.37, vx: 0, vz: 0 };
  spectator.lastProcessedInput = 9;
  room.match.ball.x = 0;
  room.match.ball.z = FIELD.length / 2 - 0.2;
  room.match.ball.vz = 20;
  stepMatch(room, 1 / 60, 1_000);
  stepMatch(room, 1 / 60, 2_000);
  const after = room.match.players.get("viewer");
  assert.equal(after.x, spectator.x);
  assert.equal(after.y, spectator.y);
  assert.equal(after.z, spectator.z);
  assert.equal(after.angle, spectator.angle);
  assert.equal(after.lastProcessedInput, 9);
});

test("shots clear the crossbar from 80 percent and peak half a goal above at maximum", () => {
  const room = makeRoom({ proMode: true });
  const red = room.match.players.get("red");
  red.x = 0;
  red.z = 0;
  room.match.ball.x = 1;
  room.match.ball.z = 0;
  const eightyResult = kickBall(room, "red", {
    power: 42.85,
    chargeRatio: 0.8,
    liftPower: 7.8,
    dir: { x: 1, z: 0 },
  });
  assert.equal(eightyResult.ok, true);
  let eightyPeak = room.match.ball.y;
  for (let i = 0; i < 120; i += 1) {
    stepMatch(room, 1 / 120);
    eightyPeak = Math.max(eightyPeak, room.match.ball.y);
  }
  assert.ok(eightyPeak > 3.08);

  const maximumRoom = makeRoom({ proMode: true });
  const maximumRed = maximumRoom.match.players.get("red");
  maximumRed.x = 0;
  maximumRed.z = 0;
  maximumRoom.match.ball.x = 1;
  maximumRoom.match.ball.z = 0;
  const maximumResult = kickBall(maximumRoom, "red", {
    power: 46.62,
    chargeRatio: 1,
    liftPower: 9.2,
    dir: { x: 1, z: 0 },
  });
  assert.equal(maximumResult.ok, true);
  let maximumPeak = maximumRoom.match.ball.y;
  for (let i = 0; i < 150; i += 1) {
    stepMatch(maximumRoom, 1 / 120);
    maximumPeak = Math.max(maximumPeak, maximumRoom.match.ball.y);
  }
  assert.ok(maximumPeak >= 4.55 && maximumPeak <= 4.9);
});

test("unlimited matches expose no ending timestamp", () => {
  const room = makeRoom();
  room.settings.unlimited = true;
  room.matchEndsAt = null;

  const snapshot = createSnapshot(room);

  assert.equal(snapshot.matchEndsAt, null);
});
