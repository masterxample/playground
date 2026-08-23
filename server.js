const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

// ============ Klassen-Definition (serverseitig) ============
// Namen hier einfach umbenennen — der Rest des Codes bleibt gleich,
// solange die Keys (kanzlerin, kaperin, ...) konsistent bleiben.
const CLASS_KEYS = ['kanzler', 'strassenraeuber', 'bluthund', 'bodyguard', 'spion'];
const COPIES_PER_CLASS = 3; // wie im Original-Spiel: 3 Kopien je Klasse im Deck

// Aktionen: classKey = welche Klasse diese Aktion "abdeckt" (für Bluff-Erkennung).
// classKey: null = jeder darf das ohne zu bluffen (Basis-Aktion).
// Hinweis: Bodyguard hat keine eigene Aktion (blockt nur Anschlag) — Block-Logik folgt später.
const ACTION_DEFS = {
  einkommen:     { label: 'Einkommen',      classKey: null,              needsTarget: false, isSwap: false },
  fremde_hilfe:  { label: 'Fremde Hilfe',   classKey: null,              needsTarget: false, isSwap: false },
  staatsstreich: { label: 'Staatsstreich',  classKey: null,              needsTarget: true,  isSwap: false },
  steuer:        { label: 'Steuer',         classKey: 'kanzler',         needsTarget: false, isSwap: false },
  raubzug:       { label: 'Raubzug',        classKey: 'strassenraeuber', needsTarget: true,  isSwap: false },
  anschlag:      { label: 'Anschlag',       classKey: 'bluthund',        needsTarget: true,  isSwap: false },
  tausch:        { label: 'Tausch',         classKey: 'spion',           needsTarget: false, isSwap: true  }
};

function buildDeck() {
  let deck = [];
  CLASS_KEYS.forEach(k => { for (let i = 0; i < COPIES_PER_CLASS; i++) deck.push(k); });
  return shuffle(deck);
}
function shuffle(arr) {
  arr = arr.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function roomCodeGen() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

const rooms = {}; // code -> room

function publicRoomState(room) {
  return {
    code: room.code,
    maxPlayers: room.maxPlayers,
    started: room.started,
    hostId: room.hostId,
    turnIndex: room.turnIndex,
    players: room.players.map(p => ({ id: p.id, name: p.name, position: p.position }))
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit('roomUpdate', publicRoomState(room));
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ name, maxPlayers }) => {
    const code = roomCodeGen();
    const room = {
      code,
      hostId: socket.id,
      maxPlayers: Math.max(2, Math.min(6, parseInt(maxPlayers, 10) || 4)),
      started: false,
      players: [],
      turnIndex: 0,
      deck: []
    };
    room.players.push({ id: socket.id, name: (name || 'Spieler').slice(0, 20), position: null, classes: [] });
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('joined', { code, youAreHost: true });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ name, code }) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) { socket.emit('errorMsg', 'Raum nicht gefunden.'); return; }
    if (room.started) { socket.emit('errorMsg', 'Das Spiel läuft bereits.'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('errorMsg', 'Der Raum ist voll.'); return; }
    room.players.push({ id: socket.id, name: (name || 'Spieler').slice(0, 20), position: null, classes: [] });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('joined', { code: room.code, youAreHost: false });
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.id || room.started) return;
    if (room.players.length < 2) { socket.emit('errorMsg', 'Mindestens 2 Spieler nötig.'); return; }

    room.started = true;
    room.deck = buildDeck();

    // Reihenfolge auslosen
    const order = shuffle(room.players.map((_, i) => i));
    order.forEach((playerIdx, pos) => { room.players[playerIdx].position = pos + 1; });
    room.players.sort((a, b) => a.position - b.position);

    // Klassen zuteilen (2 je Spieler)
    room.players.forEach(p => { p.classes = [room.deck.pop(), room.deck.pop()]; });

    room.turnIndex = 0;
    io.to(room.code).emit('gameStarted', publicRoomState(room));
    room.players.forEach(p => io.to(p.id).emit('yourClasses', p.classes));
    io.to(room.code).emit('log', 'Das Spiel wurde gestartet. Klassen und Reihenfolge wurden ausgelost.');
  });

  socket.on('declareAction', ({ actionKey, targetId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.started) return;
    const actor = room.players[room.turnIndex];
    if (!actor || actor.id !== socket.id) return; // nicht dein Zug

    const def = ACTION_DEFS[actionKey];
    if (!def) return;
    if (def.needsTarget && !targetId) return;

    const target = targetId ? room.players.find(p => p.id === targetId) : null;

    if (def.isSwap) {
      room.deck.push(...actor.classes);
      room.deck = shuffle(room.deck);
      actor.classes = [room.deck.pop(), room.deck.pop()];
      io.to(actor.id).emit('yourClasses', actor.classes);
      io.to(room.code).emit('log', `${actor.name} tauscht seine Klassen.`);
    } else {
      const isBluff = def.classKey ? !actor.classes.includes(def.classKey) : false;
      const targetTxt = target ? ` gegen ${target.name}` : '';
      const bluffTxt = def.classKey ? (isBluff ? ' — geblufft!' : ' — echte Klasse') : '';
      io.to(room.code).emit('log', `${actor.name} führt „${def.label}"${targetTxt} aus.${bluffTxt}`);
    }

    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    broadcastRoom(room);
  });

  // --- WebRTC-Signalisierung für Video/Audio (Mesh) ---
  socket.on('webrtc-signal', ({ to, data }) => {
    io.to(to).emit('webrtc-signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(room.code).emit('peerLeft', socket.id);
    if (room.players.length === 0) { delete rooms[code]; return; }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    if (room.started && room.turnIndex >= room.players.length) room.turnIndex = 0;
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server läuft auf Port ' + PORT));
