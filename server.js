const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname)));

// ================= Rollen =================
const ROLES = {
  kanzler:         { name: 'Kanzler' },
  strassenraeuber:  { name: 'Straßenräuber' },
  bluthund:        { name: 'Bluthund' },
  bodyguard:       { name: 'Bodyguard' },
  spion:           { name: 'Spion' }
};
const ROLE_KEYS = Object.keys(ROLES);
const COPIES_PER_ROLE = 3;

// ================= Aktionen =================
// coins = wie viele Münzen der Akteur bei Erfolg bekommt (Basis-/Steuer-Aktionen)
// cost  = Kosten, die SOFORT bei Ansage bezahlt werden (auch wenn geblockt wird)
// blockEligibility: 'anyone' = jeder außer Akteur darf blocken, 'target' = nur das Ziel
const ACTIONS = {
  einkommen:     { label: 'Einkommen',         coins: 1, cost: 0, targeted: false, challengeable: false, blockable: false },
  fremde_hilfe:  { label: 'Entwicklungshilfe', coins: 2, cost: 0, targeted: false, challengeable: false, blockable: true,  blockRoles: ['kanzler'], blockEligibility: 'anyone' },
  staatsstreich: { label: 'Coup',               coins: 0, cost: 7, targeted: true,  challengeable: false, blockable: false },
  steuer:        { label: 'Steuern',            coins: 3, cost: 0, targeted: false, challengeable: true,  role: 'kanzler',         blockable: false },
  raubzug:       { label: 'Raubzug',            coins: 0, cost: 0, targeted: true,  challengeable: true,  role: 'strassenraeuber', blockable: true, blockRoles: ['strassenraeuber','spion'], blockEligibility: 'target' },
  anschlag:      { label: 'Mordanschlag',       coins: 0, cost: 3, targeted: true,  challengeable: true,  role: 'bluthund',        blockable: true, blockRoles: ['bodyguard'], blockEligibility: 'target' },
  tausch:        { label: 'Austausch',          coins: 0, cost: 0, targeted: false, challengeable: true,  role: 'spion',           blockable: false, isExchange: true }
};

function buildDeck() {
  let deck = [];
  ROLE_KEYS.forEach(k => { for (let i = 0; i < COPIES_PER_ROLE; i++) deck.push(k); });
  return shuffle(deck);
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function roomCodeGen() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

const rooms = {};

function alivePlayers(room) { return room.players.filter(p => !p.eliminated); }
function influenceCount(p) { return p.cards.filter(c => c.alive).length; }
function playerName(room, id) { const p = room.players.find(pl => pl.id === id); return p ? p.name : '?'; }
function sendHand(room, player) { io.to(player.id).emit('yourHand', player.cards); }

function publicPending(room) {
  if (!room.pending) return null;
  const p = room.pending;
  return {
    phase: p.phase,
    action: p.action,
    actorId: p.actorId,
    targetId: p.targetId,
    responded: p.responded || [],
    block: p.block ? { playerId: p.block.playerId, role: p.block.role } : null,
    blockResponded: p.blockResponded || [],
    waitingOn: p.waitingOn || null
  };
}
function publicState(room) {
  return {
    code: room.code, maxPlayers: room.maxPlayers, started: room.started, hostId: room.hostId,
    turnIndex: room.turnIndex,
    players: room.players.map(p => ({
      id: p.id, name: p.name, position: p.position, coins: p.coins,
      influence: influenceCount(p), eliminated: p.eliminated,
      revealed: p.cards.filter(c => !c.alive).map(c => c.role)
    })),
    pending: publicPending(room)
  };
}
function broadcast(room) { io.to(room.code).emit('gameState', publicState(room)); }
function log(room, msg) { io.to(room.code).emit('log', msg); }

function nextTurn(room) {
  do { room.turnIndex = (room.turnIndex + 1) % room.players.length; } while (room.players[room.turnIndex].eliminated);
  room.pending = null;
  if (checkWin(room)) return;
  broadcast(room);
}
function checkWin(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    io.to(room.code).emit('gameOver', { winnerName: alive[0] ? alive[0].name : null });
    room.started = false;
    room.pending = null;
    broadcast(room);
    return true;
  }
  return false;
}
function checkEliminated(room, p) {
  if (influenceCount(p) === 0 && !p.eliminated) {
    p.eliminated = true;
    log(room, `${p.name} scheidet aus — kein Einfluss mehr übrig.`);
  }
}

function eligibleResponders(room) {
  return alivePlayers(room).filter(p => p.id !== room.pending.actorId).map(p => p.id);
}

function startLoseInfluence(room, playerId, callback) {
  const p = room.players.find(pl => pl.id === playerId);
  if (!p || influenceCount(p) === 0) { callback(); return; }
  if (influenceCount(p) === 1) {
    const c = p.cards.find(c => c.alive);
    c.alive = false;
    log(room, `${p.name} deckt die letzte Karte auf: ${ROLES[c.role].name}.`);
    checkEliminated(room, p);
    broadcast(room);
    if (checkWin(room)) return;
    callback();
    return;
  }
  room.pending = room.pending || {};
  room.pending.phase = 'loseInfluence';
  room.pending.waitingOn = playerId;
  room.pending._loseCallback = callback;
  broadcast(room);
  io.to(playerId).emit('chooseLoseCard', p.cards.filter(c => c.alive).map(c => c.role));
}

function resolveChallenge(room, claimPlayerId, claimRole, challengerId, callback) {
  const claimPlayer = room.players.find(p => p.id === claimPlayerId);
  const hasCard = claimPlayer.cards.find(c => c.alive && c.role === claimRole);
  if (hasCard) {
    claimPlayer.cards = claimPlayer.cards.filter(c => c !== hasCard);
    room.deck.push(claimRole);
    room.deck = shuffle(room.deck);
    claimPlayer.cards.push({ role: room.deck.pop(), alive: true });
    sendHand(room, claimPlayer);
    log(room, `${claimPlayer.name} zeigt tatsächlich ${ROLES[claimRole].name} und zieht eine neue Karte.`);
    startLoseInfluence(room, challengerId, () => callback(false));
  } else {
    log(room, `${claimPlayer.name} kann ${ROLES[claimRole].name} nicht vorweisen — Bluff aufgedeckt!`);
    startLoseInfluence(room, claimPlayerId, () => callback(true));
  }
}

function resolveAction(room) {
  if (!room.pending) return;
  const actor = room.players.find(p => p.id === room.pending.actorId);
  const target = room.pending.targetId ? room.players.find(p => p.id === room.pending.targetId) : null;

  switch (room.pending.action) {
    case 'einkommen':
      actor.coins += 1; log(room, `${actor.name} erhält 1 Münze (Einkommen). Kontostand: ${actor.coins}.`);
      room.pending = null; nextTurn(room); return;
    case 'fremde_hilfe':
      actor.coins += 2; log(room, `${actor.name} erhält 2 Münzen (Entwicklungshilfe). Kontostand: ${actor.coins}.`);
      room.pending = null; nextTurn(room); return;
    case 'steuer':
      actor.coins += 3; log(room, `${actor.name} erhält 3 Münzen (Steuern). Kontostand: ${actor.coins}.`);
      room.pending = null; nextTurn(room); return;
    case 'raubzug': {
      const amt = Math.min(2, target.coins);
      target.coins -= amt; actor.coins += amt;
      log(room, `${actor.name} raubt ${amt} Münze(n) von ${target.name}. ${actor.name}: ${actor.coins} | ${target.name}: ${target.coins}.`);
      room.pending = null; nextTurn(room); return;
    }
    case 'staatsstreich':
      log(room, `${actor.name} führt einen Coup gegen ${target.name} aus (7 Münzen bezahlt).`);
      startLoseInfluence(room, target.id, () => { room.pending = null; nextTurn(room); });
      return;
    case 'anschlag':
      log(room, `${actor.name}s Mordanschlag gegen ${target.name} trifft (3 Münzen bezahlt).`);
      startLoseInfluence(room, target.id, () => { room.pending = null; nextTurn(room); });
      return;
    case 'tausch':
      startExchange(room, actor.id);
      return;
  }
}

function startExchange(room, playerId) {
  const p = room.players.find(pl => pl.id === playerId);
  const draw = [room.deck.pop(), room.deck.pop()].filter(Boolean);
  room.pending.phase = 'exchange';
  room.pending.waitingOn = playerId;
  room.pending._exchangePool = draw;
  broadcast(room);
  const aliveRoles = p.cards.filter(c => c.alive).map(c => c.role);
  io.to(playerId).emit('chooseExchange', { current: aliveRoles, drawn: draw, keepCount: aliveRoles.length });
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ name, maxPlayers }) => {
    const code = roomCodeGen();
    const room = {
      code, hostId: socket.id, maxPlayers: Math.max(2, Math.min(6, parseInt(maxPlayers, 10) || 4)),
      started: false, players: [], turnIndex: 0, deck: [], pending: null
    };
    room.players.push({ id: socket.id, name: (name || 'Spieler').slice(0, 20), position: null, coins: 0, cards: [], eliminated: false });
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('joined', { code, youAreHost: true });
    io.to(code).emit('roomUpdate', publicState(room));
  });

  socket.on('joinRoom', ({ name, code }) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) { socket.emit('errorMsg', 'Raum nicht gefunden.'); return; }
    if (room.started) { socket.emit('errorMsg', 'Das Spiel läuft bereits.'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('errorMsg', 'Der Raum ist voll.'); return; }
    room.players.push({ id: socket.id, name: (name || 'Spieler').slice(0, 20), position: null, coins: 0, cards: [], eliminated: false });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('joined', { code: room.code, youAreHost: false });
    io.to(room.code).emit('roomUpdate', publicState(room));
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.id || room.started) return;
    if (room.players.length < 2) { socket.emit('errorMsg', 'Mindestens 2 Spieler nötig.'); return; }

    room.started = true;
    room.deck = buildDeck();
    room.pending = null;

    const order = shuffle(room.players.map((_, i) => i));
    order.forEach((playerIdx, pos) => { room.players[playerIdx].position = pos + 1; });
    room.players.sort((a, b) => a.position - b.position);

    room.players.forEach(p => {
      p.coins = 2;
      p.eliminated = false;
      p.cards = [{ role: room.deck.pop(), alive: true }, { role: room.deck.pop(), alive: true }];
    });

    room.turnIndex = 0;
    io.to(room.code).emit('gameStarted', publicState(room));
    room.players.forEach(p => sendHand(room, p));
    log(room, 'Das Spiel wurde gestartet. Klassen und Reihenfolge wurden ausgelost. Jeder beginnt mit 2 Münzen.');
  });

  socket.on('declareAction', ({ actionKey, targetId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.started || room.pending) return;
    const actor = room.players[room.turnIndex];
    if (!actor || actor.id !== socket.id) return;
    const def = ACTIONS[actionKey];
    if (!def) return;
    if (actor.coins >= 10 && actionKey !== 'staatsstreich') { socket.emit('errorMsg', 'Bei 10+ Münzen musst du einen Coup ausführen.'); return; }
    if (def.cost > 0 && actor.coins < def.cost) return;

    let target = null;
    if (def.targeted) {
      target = room.players.find(p => p.id === targetId && !p.eliminated && p.id !== actor.id);
      if (!target) return;
    }
    if (def.cost > 0) actor.coins -= def.cost;

    room.pending = { action: actionKey, actorId: actor.id, targetId: target ? target.id : null, phase: null, responded: [], block: null, blockResponded: [] };

    if (!def.challengeable && !def.blockable) {
      log(room, `${actor.name} nutzt ${def.label}${target ? ` gegen ${target.name}` : ''}.`);
      resolveAction(room);
      return;
    }
    room.pending.phase = 'response';
    log(room, `${actor.name} beansprucht ${def.label}${target ? ` gegen ${target.name}` : ''}.`);
    broadcast(room);
  });

  socket.on('respondPass', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pending || room.pending.phase !== 'response') return;
    const pid = socket.id;
    if (pid === room.pending.actorId || !eligibleResponders(room).includes(pid)) return;
    if (!room.pending.responded.includes(pid)) room.pending.responded.push(pid);
    if (eligibleResponders(room).every(id => room.pending.responded.includes(id))) resolveAction(room);
    else broadcast(room);
  });

  socket.on('respondChallenge', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pending || room.pending.phase !== 'response') return;
    const def = ACTIONS[room.pending.action];
    if (!def.challengeable) return;
    const challengerId = socket.id;
    if (challengerId === room.pending.actorId || !eligibleResponders(room).includes(challengerId)) return;
    const actor = room.players.find(p => p.id === room.pending.actorId);
    log(room, `${playerName(room, challengerId)} zweifelt ${actor.name}s ${def.label} an!`);
    resolveChallenge(room, room.pending.actorId, def.role, challengerId, (success) => {
      if (success) { room.pending = null; nextTurn(room); }
      else { resolveAction(room); }
    });
  });

  socket.on('respondBlock', ({ role }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pending || room.pending.phase !== 'response') return;
    const def = ACTIONS[room.pending.action];
    if (!def.blockable || !def.blockRoles.includes(role)) return;
    const blockerId = socket.id;
    if (blockerId === room.pending.actorId) return;
    if (def.blockEligibility === 'target' && blockerId !== room.pending.targetId) return;
    if (def.blockEligibility === 'anyone' && !eligibleResponders(room).includes(blockerId)) return;
    room.pending.block = { playerId: blockerId, role };
    room.pending.phase = 'blockResponse';
    room.pending.blockResponded = [];
    log(room, `${playerName(room, blockerId)} blockt mit ${ROLES[role].name}.`);
    broadcast(room);
  });

  socket.on('blockRespondPass', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pending || room.pending.phase !== 'blockResponse') return;
    const pid = socket.id;
    const blockerId = room.pending.block.playerId;
    if (pid === blockerId) return;
    const eligible = alivePlayers(room).filter(p => p.id !== blockerId).map(p => p.id);
    if (!eligible.includes(pid)) return;
    if (!room.pending.blockResponded.includes(pid)) room.pending.blockResponded.push(pid);
    if (eligible.every(id => room.pending.blockResponded.includes(id))) {
      log(room, `Block steht — Aktion wird nicht ausgeführt.`);
      room.pending = null; nextTurn(room);
    } else broadcast(room);
  });

  socket.on('blockRespondChallenge', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pending || room.pending.phase !== 'blockResponse') return;
    const challengerId = socket.id;
    const block = room.pending.block;
    if (challengerId === block.playerId) return;
    log(room, `${playerName(room, challengerId)} zweifelt den Block von ${playerName(room, block.playerId)} an!`);
    resolveChallenge(room, block.playerId, block.role, challengerId, (success) => {
      if (success) { resolveAction(room); }
      else { log(room, `Block von ${playerName(room, block.playerId)} bestätigt.`); room.pending = null; nextTurn(room); }
    });
  });

  socket.on('confirmLoseCard', ({ index }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pending || room.pending.phase !== 'loseInfluence') return;
    if (room.pending.waitingOn !== socket.id) return;
    const p = room.players.find(pl => pl.id === socket.id);
    const aliveIdx = p.cards.map((c, i) => ({ c, i })).filter(x => x.c.alive);
    const chosen = aliveIdx[index];
    if (!chosen) return;
    chosen.c.alive = false;
    log(room, `${p.name} deckt ${ROLES[chosen.c.role].name} auf und verliert Einfluss.`);
    checkEliminated(room, p);
    const cb = room.pending._loseCallback;
    room.pending._loseCallback = null;
    room.pending.waitingOn = null;
    broadcast(room);
    if (checkWin(room)) return;
    cb();
  });

  socket.on('confirmExchange', ({ keepIndices }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pending || room.pending.phase !== 'exchange') return;
    if (room.pending.waitingOn !== socket.id) return;
    const p = room.players.find(pl => pl.id === socket.id);
    const aliveCards = p.cards.filter(c => c.alive);
    const deadCards = p.cards.filter(c => !c.alive);
    const pool = aliveCards.map(c => c.role).concat(room.pending._exchangePool);
    const keepCount = aliveCards.length;
    if (!Array.isArray(keepIndices) || keepIndices.length !== keepCount) return;
    const uniqueIdx = [...new Set(keepIndices)];
    if (uniqueIdx.length !== keepCount) return;
    const keep = uniqueIdx.map(i => pool[i]).filter(Boolean);
    if (keep.length !== keepCount) return;
    const returnToDeck = pool.filter((_, i) => !uniqueIdx.includes(i));
    room.deck = shuffle(room.deck.concat(returnToDeck));
    p.cards = keep.map(r => ({ role: r, alive: true })).concat(deadCards);
    sendHand(room, p);
    log(room, `${p.name} tauscht Karten aus.`);
    room.pending = null;
    broadcast(room);
    nextTurn(room);
  });

  socket.on('restartGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.started = false; room.pending = null; room.turnIndex = 0;
    room.players.forEach(p => { p.coins = 0; p.cards = []; p.eliminated = false; p.position = null; });
    io.to(room.code).emit('backToLobby', publicState(room));
  });

  // --- WebRTC-Signalisierung für Video/Audio (Mesh) ---
  socket.on('webrtc-signal', ({ to, data }) => {
    io.to(to).emit('webrtc-signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    if (!room.started) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { delete rooms[code]; return; }
      if (room.hostId === socket.id) room.hostId = room.players[0].id;
      io.to(room.code).emit('roomUpdate', publicState(room));
      return;
    }

    const p = room.players.find(pl => pl.id === socket.id);
    if (p && !p.eliminated) {
      p.cards.forEach(c => c.alive = false);
      p.eliminated = true;
      log(room, `${p.name} hat die Verbindung verloren und scheidet aus.`);
    }
    if (room.hostId === socket.id) {
      const alive = alivePlayers(room);
      if (alive.length > 0) room.hostId = alive[0].id;
    }
    const wasTurn = room.players[room.turnIndex] && room.players[room.turnIndex].id === socket.id;
    if (room.pending && (room.pending.actorId === socket.id || room.pending.waitingOn === socket.id || (room.pending.block && room.pending.block.playerId === socket.id))) {
      room.pending = null;
    }
    if (checkWin(room)) return;
    if (wasTurn && !room.pending) { nextTurn(room); return; }
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server läuft auf Port ' + PORT));
