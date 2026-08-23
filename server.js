const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Speicher für alle aktiven Räume
const rooms = {};

const CARD_DECK = [
    "Kanzlerin", "Kanzlerin", "Kanzlerin",
    "Straßenräuber", "Straßenräuber", "Straßenräuber",
    "Bluthund", "Bluthund", "Bluthund",
    "Bodyguard", "Bodyguard", "Bodyguard",
    "Spion", "Spion", "Spion"
];

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function shuffle(array) {
    let deck = [...array];
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {

    // 1. Raum erstellen mit definierter Max-Spieleranzahl
    socket.on('create-room', ({ username, maxPlayers }) => {
        const roomCode = generateRoomCode();
        const max = parseInt(maxPlayers) || 4;

        rooms[roomCode] = {
            code: roomCode,
            maxPlayers: max,
            players: {}
        };

        joinRoom(socket, roomCode, username);
    });

    // 2. Raum beitreten
    socket.on('join-room', ({ roomCode, username }) => {
        const code = (roomCode || '').toUpperCase().trim();
        if (!rooms[code]) {
            return socket.emit('error-msg', 'Raum-Code nicht gefunden!');
        }

        const currentCount = Object.keys(rooms[code].players).length;
        if (currentCount >= rooms[code].maxPlayers) {
            return socket.emit('error-msg', 'Dieser Raum ist bereits voll!');
        }

        joinRoom(socket, code, username);
    });

    function joinRoom(socket, roomCode, username) {
        socket.join(roomCode);
        socket.roomCode = roomCode;

        rooms[roomCode].players[socket.id] = {
            id: socket.id,
            name: username || 'Spieler_' + socket.id.substr(0, 4),
            cards: []
        };

        const roomData = rooms[roomCode];

        // Bestätigung & Raum-Info an den Beitretenden
        socket.emit('room-joined', {
            roomCode: roomCode,
            maxPlayers: roomData.maxPlayers,
            players: Object.values(roomData.players)
        });

        // Alle im selben Raum aktualisieren
        io.to(roomCode).emit('update-room-state', {
            maxPlayers: roomData.maxPlayers,
            players: Object.values(roomData.players)
        });
    }

    // 3. WebRTC Video-/Audio-Signaling
    socket.on('webrtc-offer', (data) => {
        socket.to(data.target).emit('webrtc-offer', { sdp: data.sdp, caller: socket.id });
    });

    socket.on('webrtc-answer', (data) => {
        socket.to(data.target).emit('webrtc-answer', { sdp: data.sdp, responder: socket.id });
    });

    socket.on('webrtc-ice-candidate', (data) => {
        socket.to(data.target).emit('webrtc-ice-candidate', { candidate: data.candidate, sender: socket.id });
    });

    // 4. Karten verteilen
    socket.on('start-game', () => {
        const roomCode = socket.roomCode;
        if (!roomCode || !rooms[roomCode]) return;

        const deck = shuffle(CARD_DECK);
        const roomPlayers = rooms[roomCode].players;

        Object.keys(roomPlayers).forEach((id) => {
            roomPlayers[id].cards = [deck.pop(), deck.pop()];
            io.to(id).emit('your-cards', roomPlayers[id].cards);
        });
    });

    // Trennung verarbeiten
    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            
            if (Object.keys(rooms[roomCode].players).length === 0) {
                delete rooms[roomCode];
            } else {
                io.to(roomCode).emit('update-room-state', {
                    maxPlayers: rooms[roomCode].maxPlayers,
                    players: Object.values(rooms[roomCode].players)
                });
                io.to(roomCode).emit('user-disconnected', socket.id);
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
