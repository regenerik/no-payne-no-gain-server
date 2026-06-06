import assert from "node:assert/strict";
import test from "node:test";
import {
  createMatch,
  createSnapshot,
  kickBall,
  setPlayerInput,
  stepMatch,
} from "./simulation.js";

function makeRoom({ proMode = false, keeperEnabled = false } = {}) {
  const room = {
    started: true,
    matchEndsAt: Date.now() + 60_000,
    settings: { proMode, keeperEnabled, scoreLimit: 3, timeLimit: 1 },
    scores: { red: 0, blue: 0 },
    players: new Map([
      ["red", { id: "red", name: "Red", team: "red" }],
      ["blue", { id: "blue", name: "Blue", team: "blue" }],
    ]),
  };
  room.match = createMatch(room);
  return room;
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
