export const FIELD = Object.freeze({ width: 42, length: 76 });
export const SIMULATION_HZ = 60;
export const SNAPSHOT_HZ = 30;

const BALL_RADIUS = 0.42;
const PLAYER_RADIUS = 0.82;
const MAX_PLAYER_SPEED = 14.2;
const GOAL_HALF_WIDTH = 4.2;
const GOAL_HEIGHT = 3.08;
const KEEPER_ARC_DEPTH = 4.5;
const KEEPER_ARC_WIDTH = 6.25;
const KEEPER_MAX_ARC_ANGLE = Math.PI * 0.47;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const length2 = (x, z) => Math.hypot(x, z);

function normalize2(x, z, fallbackX = 0, fallbackZ = 1) {
  const length = length2(x, z);
  if (length < 0.0001) return { x: fallbackX, z: fallbackZ };
  return { x: x / length, z: z / length };
}

export function getTeamStartPosition(team, index, total) {
  if (team !== "red" && team !== "blue") return { x: 0, y: 0, z: -2.4 };
  const side = team === "red" ? -1 : 1;
  const row = Math.floor(index / 4);
  const col = index % 4;
  const spread = Math.min(total, 4);
  return {
    x: clamp((col - (spread - 1) / 2) * 4.6, -FIELD.width / 2 + 4, FIELD.width / 2 - 4),
    y: 0,
    z: clamp(side * (14 + row * 5.2), -FIELD.length / 2 + 8, FIELD.length / 2 - 8),
  };
}

function makePlayer(roomPlayer, index, total) {
  const spectator = roomPlayer.team === "spectators";
  const spectatorSide = index % 2 === 0 ? -1 : 1;
  const spectatorRow = 3 + (index % 6);
  const spectatorAngle = -spectatorSide * Math.PI / 4;
  const position = spectator
    ? {
        x: spectatorSide * (FIELD.width / 2 + 5.4 + spectatorRow * 0.74),
        y: 1.15 + spectatorRow * 0.34,
        z: clamp(-24 + index * 6, -32, 32),
      }
    : getTeamStartPosition(roomPlayer.team, index, total);
  return {
    id: roomPlayer.id,
    team: roomPlayer.team,
    x: position.x,
    y: position.y,
    z: position.z,
    angle: spectator ? spectatorAngle : roomPlayer.team === "blue" ? Math.PI : 0,
    moving: false,
    input: {
      seq: 0,
      angle: spectator ? spectatorAngle : roomPlayer.team === "blue" ? Math.PI : 0,
      vx: 0,
      vz: 0,
    },
    lastProcessedInput: 0,
    spectator,
    verticalVelocity: 0,
    grounded: true,
    jumpQueued: false,
  };
}

function rebuildPlayers(match, roomPlayers, preservePositions = false) {
  const previous = match.players;
  const next = new Map();
  for (const team of ["red", "blue", "spectators"]) {
    const teamPlayers = [...roomPlayers.values()].filter((player) => player.team === team);
    teamPlayers.forEach((roomPlayer, index) => {
      const existing = previous.get(roomPlayer.id);
      if (existing && preservePositions && existing.team === team) {
        existing.team = team;
        next.set(roomPlayer.id, existing);
      } else {
        next.set(roomPlayer.id, makePlayer(roomPlayer, index, teamPlayers.length));
      }
    });
  }
  match.players = next;
}

export function createMatch(room) {
  const match = {
    id: `${room.id || "room"}-${Date.now()}-${room.matchNumber || 1}`,
    tick: 0,
    snapshotSeq: 0,
    players: new Map(),
    ball: {
      x: 0,
      y: BALL_RADIUS,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      charge: 0,
      ownerId: null,
      lastKickId: null,
      magnetCooldown: 0,
    },
    kickoff: { locked: false, team: null, takerId: null },
    keepers: [],
    goalCooldown: 0,
    resetAt: 0,
  };
  rebuildPlayers(match, room.players);
  const availableTeams = ["red", "blue"].filter((team) =>
    [...match.players.values()].some((player) => player.team === team)
  );
  if (availableTeams.length) {
    const random = typeof room.random === "function" ? room.random : Math.random;
    const kickoffTeam = availableTeams[Math.floor(random() * availableTeams.length)];
    const taker = [...match.players.values()].find((player) => player.team === kickoffTeam);
    if (taker) {
      taker.x = 0;
      taker.z = 0;
      match.kickoff = { locked: true, team: kickoffTeam, takerId: taker.id };
    }
  }
  resetKeepers(match, room.settings.keeperEnabled);
  return match;
}

export function syncMatchPlayers(room, preservePositions = true) {
  if (!room.match) return;
  rebuildPlayers(room.match, room.players, preservePositions);
  if (room.match.kickoff.locked && !room.match.players.has(room.match.kickoff.takerId)) {
    room.match.kickoff = { locked: false, team: null, takerId: null };
  }
}

function resetKeepers(match, enabled) {
  match.keepers = enabled
    ? [
        { side: -1, x: 0, y: 0, z: -FIELD.length / 2 + 4.5, mode: "ready", targetX: 0, timer: 0, clearanceCooldown: 0 },
        { side: 1, x: 0, y: 0, z: FIELD.length / 2 - 4.5, mode: "ready", targetX: 0, timer: 0, clearanceCooldown: 0 },
      ]
    : [];
}

export function updateMatchSettings(room) {
  if (!room.match) return;
  if (Boolean(room.settings.keeperEnabled) !== Boolean(room.match.keepers.length)) {
    resetKeepers(room.match, room.settings.keeperEnabled);
  }
}

export function setPlayerInput(room, playerId, input = {}) {
  const player = room.match?.players.get(playerId);
  if (!player) return;
  const seq = Math.max(0, Number(input.seq) || 0);
  if (seq <= player.input.seq) return;
  let vx = Number(input.vx) || 0;
  let vz = Number(input.vz) || 0;
  const speed = length2(vx, vz);
  if (speed > MAX_PLAYER_SPEED) {
    vx = (vx / speed) * MAX_PLAYER_SPEED;
    vz = (vz / speed) * MAX_PLAYER_SPEED;
  }
  player.input = {
    seq,
    angle: Number.isFinite(Number(input.angle)) ? Number(input.angle) : player.angle,
    vx,
    vz,
  };
  if (player.spectator && input.jump === true) player.jumpQueued = true;
}

function spectatorFloorHeight(x, z) {
  const sideDistance = Math.abs(x) - (FIELD.width / 2 + 5.4);
  const endDistance = Math.abs(z) - (FIELD.length / 2 + 5.4);
  const onSideStand = Math.abs(x) >= FIELD.width / 2 + 5.0
    && Math.abs(x) <= FIELD.width / 2 + 15
    && Math.abs(z) <= FIELD.length / 2 + 10;
  const onEndStand = Math.abs(z) >= FIELD.length / 2 + 5.0
    && Math.abs(z) <= FIELD.length / 2 + 15
    && Math.abs(x) <= FIELD.width / 2 + 10;
  const rowDistance = onSideStand && (!onEndStand || sideDistance >= endDistance)
    ? sideDistance
    : endDistance;
  const row = clamp(Math.round(rowDistance / 0.74), 0, 12);
  return 1.15 + row * 0.34;
}

function constrainSpectator(player) {
  const outerX = FIELD.width / 2 + 14.35;
  const outerZ = FIELD.length / 2 + 14.35;
  const innerX = FIELD.width / 2 + 5.0;
  const innerZ = FIELD.length / 2 + 5.0;
  player.x = clamp(player.x, -outerX, outerX);
  player.z = clamp(player.z, -outerZ, outerZ);
  if (Math.abs(player.x) < innerX && Math.abs(player.z) < innerZ) {
    const toSide = innerX - Math.abs(player.x);
    const toEnd = innerZ - Math.abs(player.z);
    if (toSide < toEnd) player.x = (player.x >= 0 ? 1 : -1) * innerX;
    else player.z = (player.z >= 0 ? 1 : -1) * innerZ;
  }
}

function constrainKickoffPlayer(match, player) {
  if (!match.kickoff.locked) return;
  if (player.id === match.kickoff.takerId) {
    player.x = 0;
    player.z = 0;
    return;
  }
  if (player.team === "red") player.z = Math.min(player.z, -0.35);
  if (player.team === "blue") player.z = Math.max(player.z, 0.35);
}

function updatePlayers(match, dt) {
  for (const player of match.players.values()) {
    player.angle = player.input.angle;
    if (player.spectator) {
      player.x += player.input.vx * dt;
      player.z += player.input.vz * dt;
      constrainSpectator(player);
      const floor = spectatorFloorHeight(player.x, player.z);
      if (player.jumpQueued && player.grounded) {
        player.verticalVelocity = 6.2;
        player.grounded = false;
      }
      player.jumpQueued = false;
      if (!player.grounded) {
        player.verticalVelocity -= 14 * dt;
        player.y += player.verticalVelocity * dt;
        if (player.y <= floor) {
          player.y = floor;
          player.verticalVelocity = 0;
          player.grounded = true;
        }
      } else {
        player.y = floor;
      }
      player.moving = length2(player.input.vx, player.input.vz) > 0.2;
      player.lastProcessedInput = player.input.seq;
      continue;
    }
    const isTaker = match.kickoff.locked && player.id === match.kickoff.takerId;
    if (!isTaker) {
      player.x += player.input.vx * dt;
      player.z += player.input.vz * dt;
    }
    player.x = clamp(player.x, -FIELD.width / 2 + 2, FIELD.width / 2 - 2);
    player.z = clamp(player.z, -FIELD.length / 2 + 1.1, FIELD.length / 2 - 1.1);
    player.moving = !isTaker && length2(player.input.vx, player.input.vz) > 0.2;
    player.lastProcessedInput = player.input.seq;
    constrainKickoffPlayer(match, player);
  }

  const players = [...match.players.values()].filter((player) => !player.spectator);
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i];
      const b = players[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distance = length2(dx, dz);
      if (distance <= 0.001 || distance >= 1.35) continue;
      const nx = dx / distance;
      const nz = dz / distance;
      const totalOverlap = 1.35 - distance;
      const aIsTaker = match.kickoff.locked && a.id === match.kickoff.takerId;
      const bIsTaker = match.kickoff.locked && b.id === match.kickoff.takerId;
      if (aIsTaker && !bIsTaker) {
        b.x += nx * totalOverlap;
        b.z += nz * totalOverlap;
      } else if (bIsTaker && !aIsTaker) {
        a.x -= nx * totalOverlap;
        a.z -= nz * totalOverlap;
      } else {
        const overlap = totalOverlap * 0.5;
        a.x -= nx * overlap;
        a.z -= nz * overlap;
        b.x += nx * overlap;
        b.z += nz * overlap;
      }
      constrainKickoffPlayer(match, a);
      constrainKickoffPlayer(match, b);
    }
  }
}

function nearestBallOwner(match) {
  if (match.kickoff.locked || match.ball.y >= 0.78 || match.ball.magnetCooldown > 0) return null;
  if (length2(match.ball.vx, match.ball.vz) >= 18) return null;
  let nearest = null;
  let nearestDistance = 2.35;
  for (const player of match.players.values()) {
    if (player.spectator) continue;
    const distance = length2(match.ball.x - player.x, match.ball.z - player.z);
    if (distance < nearestDistance) {
      nearest = player;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function updateControlledBall(match, owner, dt) {
  const moving = length2(owner.input.vx, owner.input.vz) > 0.2;
  const direction = moving
    ? normalize2(owner.input.vx, owner.input.vz)
    : { x: Math.sin(owner.angle), z: Math.cos(owner.angle) };
  const pulse = Math.sin(match.tick * 0.3) * 0.16;
  const targetX = owner.x + direction.x * (2.05 + pulse);
  const targetZ = owner.z + direction.z * (2.05 + pulse);
  const blend = 1 - Math.pow(0.00025, dt);
  const oldX = match.ball.x;
  const oldZ = match.ball.z;
  match.ball.x += (targetX - match.ball.x) * blend;
  match.ball.z += (targetZ - match.ball.z) * blend;
  match.ball.x = clamp(match.ball.x, -FIELD.width / 2 + BALL_RADIUS, FIELD.width / 2 - BALL_RADIUS);
  match.ball.z = clamp(match.ball.z, -FIELD.length / 2 + BALL_RADIUS, FIELD.length / 2 - BALL_RADIUS);
  match.ball.y = BALL_RADIUS;
  match.ball.vx = ((match.ball.x - oldX) / Math.max(dt, 0.001)) * 0.28;
  match.ball.vz = ((match.ball.z - oldZ) / Math.max(dt, 0.001)) * 0.28;
  match.ball.vy = 0;
  match.ball.charge = 0;
}

function collideBallWithPlayers(match, proMode) {
  if (match.ball.ownerId || match.kickoff.locked) return;
  for (const player of match.players.values()) {
    if (player.spectator) continue;
    if (match.ball.y > 1.1) continue;
    const dx = match.ball.x - player.x;
    const dz = match.ball.z - player.z;
    const distance = length2(dx, dz);
    const minDistance = proMode ? PLAYER_RADIUS + BALL_RADIUS : 1.22;
    if (distance <= 0.001 || distance >= minDistance) continue;
    const nx = dx / distance;
    const nz = dz / distance;
    const overlap = minDistance - distance;
    match.ball.x += nx * (overlap + 0.025);
    match.ball.z += nz * (overlap + 0.025);
    match.ball.vx += nx * (overlap * 7.5 + (proMode ? 0.12 : 2.5));
    match.ball.vz += nz * (overlap * 7.5 + (proMode ? 0.12 : 2.5));
  }
}

function getKeeperArcTarget(keeper, ball) {
  const goalZ = keeper.side * FIELD.length / 2;
  const inwardDistance = Math.max(0.05, keeper.side * (goalZ - ball.z));
  const angle = clamp(
    Math.atan2(ball.x, inwardDistance),
    -KEEPER_MAX_ARC_ANGLE,
    KEEPER_MAX_ARC_ANGLE
  );
  return {
    x: Math.sin(angle) * KEEPER_ARC_WIDTH,
    z: goalZ - keeper.side * Math.cos(angle) * KEEPER_ARC_DEPTH,
  };
}

function updateKeepers(match, dt) {
  for (const keeper of match.keepers) {
    keeper.clearanceCooldown = Math.max(0, (keeper.clearanceCooldown || 0) - dt);
    if (keeper.mode === "dive") {
      keeper.timer -= dt;
      const blend = 1 - Math.pow(0.006, dt);
      keeper.x += (keeper.targetX - keeper.x) * blend;
      keeper.z += (keeper.side * (FIELD.length / 2 - 4.15) - keeper.z) * blend;
      keeper.y = Math.max(0, Math.sin((1.05 - keeper.timer) * Math.PI) * 0.5);
      if (keeper.timer <= 0) {
        keeper.mode = "recover";
        keeper.timer = 0.85;
      }
    } else if (keeper.mode === "clear") {
      keeper.timer -= dt;
      keeper.y = Math.max(0, Math.sin((0.42 - keeper.timer) * Math.PI) * 0.12);
      if (keeper.timer <= 0) keeper.mode = "recover";
    } else {
      if (keeper.mode === "recover") {
        keeper.timer -= dt;
        if (keeper.timer <= 0) keeper.mode = "ready";
      }
      const target = getKeeperArcTarget(keeper, match.ball);
      const trackBlend = 1 - Math.pow(0.02, dt);
      keeper.x += (target.x - keeper.x) * trackBlend;
      keeper.z += (target.z - keeper.z) * trackBlend;
      keeper.y += (0 - keeper.y) * 0.18;
    }
  }
}

function keeperClearsDangerousBall(match, owner = null) {
  if (match.ball.y > 0.9 || length2(match.ball.vx, match.ball.vz) > 13) return false;
  for (const keeper of match.keepers) {
    const defendingTeam = keeper.side < 0 ? "red" : "blue";
    const attacker = owner && !owner.spectator && owner.team !== defendingTeam
      ? owner
      : [...match.players.values()].find((player) =>
          !player.spectator
          && player.team !== defendingTeam
          && length2(player.x - keeper.x, player.z - keeper.z) <= 2.15
        );
    if (!attacker || keeper.clearanceCooldown > 0 || keeper.mode === "dive") continue;
    const playerDistance = length2(attacker.x - keeper.x, attacker.z - keeper.z);
    const ballDistance = length2(match.ball.x - keeper.x, match.ball.z - keeper.z);
    if (playerDistance > 2.15 || ballDistance > 2.45) continue;

    const lateral = clamp((match.ball.x - keeper.x) * 0.48, -0.72, 0.72);
    const direction = normalize2(lateral, -keeper.side, 0, -keeper.side);
    match.ball.ownerId = null;
    match.ball.magnetCooldown = 1.05;
    match.ball.x = keeper.x + direction.x * 1.5;
    match.ball.z = keeper.z + direction.z * 1.5;
    match.ball.y = BALL_RADIUS;
    match.ball.vx = direction.x * 21;
    match.ball.vz = direction.z * 21;
    match.ball.vy = 1.3;
    match.ball.charge = 0.18;
    keeper.mode = "clear";
    keeper.timer = 0.42;
    keeper.clearanceCooldown = 1.15;
    return true;
  }
  return false;
}

function collideBallWithKeepers(match) {
  for (const keeper of match.keepers) {
    const radius = keeper.mode === "dive" ? 1.65 : 1.05;
    const dx = match.ball.x - keeper.x;
    const dz = match.ball.z - keeper.z;
    const distance = length2(dx, dz);
    if (match.ball.y >= 3.2 || distance >= radius + BALL_RADIUS) continue;
    const normal = normalize2(dx, dz, 0, -keeper.side);
    const speed = Math.max(length2(match.ball.vx, match.ball.vz), 9);
    match.ball.x = keeper.x + normal.x * (radius + 0.62);
    match.ball.z = keeper.z + normal.z * (radius + 0.62);
    match.ball.vx = normal.x * speed * 0.82;
    match.ball.vz = normal.z * speed * 0.82 - keeper.side * (Math.abs(normal.z * speed * 0.82) + 2.5);
    match.ball.vy = Math.max(match.ball.vy * 0.25, 1.2);
    match.ball.ownerId = null;
    return true;
  }
  return false;
}

function resetForKickoff(room, scoringTeam) {
  const match = room.match;
  const kickoffTeam = scoringTeam === "red" ? "blue" : "red";
  const taker = [...match.players.values()].find((player) => player.team === kickoffTeam) || null;
  const spectatorStates = new Map(
    [...match.players.values()]
      .filter((player) => player.spectator)
      .map((player) => [player.id, {
        x: player.x,
        y: player.y,
        z: player.z,
        angle: player.angle,
        input: { ...player.input },
        verticalVelocity: player.verticalVelocity,
        grounded: player.grounded,
        jumpQueued: player.jumpQueued,
        moving: player.moving,
        lastProcessedInput: player.lastProcessedInput,
      }])
  );
  rebuildPlayers(match, room.players);
  for (const [playerId, state] of spectatorStates) {
    const spectator = match.players.get(playerId);
    if (!spectator?.spectator) continue;
    Object.assign(spectator, state);
  }
  match.ball = {
    x: 0,
    y: BALL_RADIUS,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    charge: 0,
    ownerId: null,
    lastKickId: match.ball.lastKickId,
    magnetCooldown: 0,
  };
  match.kickoff = taker
    ? { locked: true, team: kickoffTeam, takerId: taker.id }
    : { locked: false, team: null, takerId: null };
  if (taker) {
    const resetTaker = match.players.get(taker.id);
    resetTaker.x = 0;
    resetTaker.z = 0;
  }
  resetKeepers(match, room.settings.keeperEnabled);
}

function scoreGoal(room, scoringTeam, now) {
  const match = room.match;
  if (match.goalCooldown > 0) return null;
  room.scores[scoringTeam] += 1;
  match.goalCooldown = 0.95;
  match.resetAt = now + 850;
  match.pendingScoringTeam = scoringTeam;
  match.ball.vx = 0;
  match.ball.vy = 0;
  match.ball.vz = 0;
  match.ball.ownerId = null;
  return { type: "goal", scoringTeam, scores: { ...room.scores } };
}

function updateBall(room, dt, now) {
  const match = room.match;
  const ball = match.ball;
  ball.magnetCooldown = Math.max(0, ball.magnetCooldown - dt);

  if (match.resetAt) {
    if (now >= match.resetAt) {
      const scoringTeam = match.pendingScoringTeam;
      match.resetAt = 0;
      match.pendingScoringTeam = null;
      resetForKickoff(room, scoringTeam);
    }
    return null;
  }

  if (match.kickoff.locked) {
    ball.x = 0;
    ball.y = BALL_RADIUS;
    ball.z = 0;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
    ball.charge = 0;
    ball.ownerId = null;
    return null;
  }

  if (!room.settings.proMode) {
    const owner = ball.ownerId ? match.players.get(ball.ownerId) : nearestBallOwner(match);
    if (owner) {
      ball.ownerId = owner.id;
      if (keeperClearsDangerousBall(match, owner)) return null;
      updateControlledBall(match, owner, dt);
      if (ball.z >= FIELD.length / 2 - BALL_RADIUS && Math.abs(ball.x) < GOAL_HALF_WIDTH) {
        return scoreGoal(room, "red", now);
      }
      if (ball.z <= -FIELD.length / 2 + BALL_RADIUS && Math.abs(ball.x) < GOAL_HALF_WIDTH) {
        return scoreGoal(room, "blue", now);
      }
      return null;
    }
    ball.ownerId = null;
  }

  if (keeperClearsDangerousBall(match)) return null;
  collideBallWithPlayers(match, room.settings.proMode);
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;
  ball.vy -= 9.8 * dt;
  ball.y += ball.vy * dt;
  if (ball.y <= BALL_RADIUS) {
    ball.y = BALL_RADIUS;
    ball.vy = 0;
  }
  const friction = Math.pow(0.36, dt);
  ball.vx *= friction;
  ball.vz *= friction;
  ball.charge *= Math.pow(0.34, dt);
  if (length2(ball.vx, ball.vz) < 0.02) {
    ball.vx = 0;
    ball.vz = 0;
    ball.charge = 0;
  }

  collideBallWithPlayers(match, room.settings.proMode);
  collideBallWithKeepers(match);

  const maxZ = FIELD.length / 2 - BALL_RADIUS;
  const minZ = -FIELD.length / 2 + BALL_RADIUS;
  if (Math.abs(ball.x) < GOAL_HALF_WIDTH && ball.y < GOAL_HEIGHT) {
    if (ball.z >= maxZ && ball.vz > 0.8) return scoreGoal(room, "red", now);
    if (ball.z <= minZ && ball.vz < -0.8) return scoreGoal(room, "blue", now);
  }

  const minX = -FIELD.width / 2 + BALL_RADIUS;
  const maxX = FIELD.width / 2 - BALL_RADIUS;
  if (ball.x < minX) {
    ball.x = minX;
    ball.vx = Math.abs(ball.vx) * 0.86;
  } else if (ball.x > maxX) {
    ball.x = maxX;
    ball.vx = -Math.abs(ball.vx) * 0.86;
  }
  if (ball.z < minZ) {
    ball.z = minZ;
    ball.vz = Math.abs(ball.vz) * 0.86;
  } else if (ball.z > maxZ) {
    ball.z = maxZ;
    ball.vz = -Math.abs(ball.vz) * 0.86;
  }
  return null;
}

export function kickBall(room, playerId, kick = {}) {
  const match = room.match;
  const player = match?.players.get(playerId);
  if (!player || player.spectator || match.resetAt) return { ok: false };
  const distance = length2(match.ball.x - player.x, match.ball.z - player.z);
  if (distance > 3.65) return { ok: false };
  if (match.kickoff.locked && (playerId !== match.kickoff.takerId || player.team !== match.kickoff.team)) {
    return { ok: false };
  }
  let direction = normalize2(Number(kick.dir?.x) || 0, Number(kick.dir?.z) || 0);
  if (!Number.isFinite(direction.x) || !Number.isFinite(direction.z)) {
    direction = normalize2(match.ball.x - player.x, match.ball.z - player.z);
  }
  const charge = clamp(Number(kick.chargeRatio) || 0, 0, 1);
  const power = clamp(Number(kick.power) || 0, 0, 52);
  match.kickoff = { locked: false, team: null, takerId: null };
  match.ball.ownerId = null;
  match.ball.magnetCooldown = 0.58 + charge * 0.22;
  match.ball.vx = clamp(match.ball.vx + direction.x * power, -42, 42);
  match.ball.vz = clamp(match.ball.vz + direction.z * power, -42, 42);
  const speed = length2(match.ball.vx, match.ball.vz);
  if (speed > 42) {
    match.ball.vx = (match.ball.vx / speed) * 42;
    match.ball.vz = (match.ball.vz / speed) * 42;
  }
  match.ball.vy = Math.max(match.ball.vy, Number(kick.liftPower) || 0);
  match.ball.charge = Math.max(match.ball.charge, charge);
  match.ball.x += direction.x * 0.22;
  match.ball.z += direction.z * 0.22;
  match.ball.lastKickId = String(kick.kickId || `${playerId}-${Date.now()}`);

  const side = direction.z >= 0 ? 1 : -1;
  const keeper = match.keepers.find((candidate) => candidate.side === side);
  if (keeper && Math.abs(direction.z) > 0.16) {
    const goalZ = side * (FIELD.length / 2 - BALL_RADIUS);
    const travel = (goalZ - match.ball.z) / direction.z;
    const predictedX = match.ball.x + direction.x * travel;
    if (predictedX >= -6.3 && predictedX <= 6.3) {
      const correct = Math.random() < 0.5 * (1 - charge);
      const chosenX = correct
        ? predictedX
        : predictedX + (Math.random() > 0.5 ? 1 : -1) * (2.8 + Math.random() * 2.7);
      keeper.mode = "dive";
      keeper.targetX = clamp(chosenX, -5.4, 5.4);
      keeper.timer = 1.05;
    }
  }
  return { ok: true, kickId: match.ball.lastKickId };
}

export function stepMatch(room, dt, now = Date.now()) {
  if (!room.started || !room.match) return [];
  room.match.tick += 1;
  room.match.goalCooldown = Math.max(0, room.match.goalCooldown - dt);
  updatePlayers(room.match, dt);
  updateKeepers(room.match, dt);
  const event = updateBall(room, dt, now);
  return event ? [event] : [];
}

export function createSnapshot(room, now = Date.now()) {
  const match = room.match;
  return {
    matchId: match.id,
    seq: ++match.snapshotSeq,
    tick: match.tick,
    serverTime: now,
    matchEndsAt: room.matchEndsAt,
    scores: { ...room.scores },
    kickoffLocked: match.kickoff.locked,
    kickoffTeam: match.kickoff.team,
    kickoffTakerId: match.kickoff.takerId,
    players: [...match.players.values()].map((player) => ({
      id: player.id,
      team: player.team,
      x: player.x,
      y: player.y,
      z: player.z,
      angle: player.angle,
      moving: player.moving,
      vx: player.input.vx,
      vz: player.input.vz,
      ack: player.lastProcessedInput,
    })),
    ball: {
      x: match.ball.x,
      y: match.ball.y,
      z: match.ball.z,
      vx: match.ball.vx,
      vy: match.ball.vy,
      vz: match.ball.vz,
      charge: match.ball.charge,
      ownerId: match.ball.ownerId,
      lastKickId: match.ball.lastKickId,
    },
    keepers: match.keepers.map((keeper) => ({ ...keeper })),
  };
}
