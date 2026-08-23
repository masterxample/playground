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

// Karten-Pool (Beispiel: Rollen für Maskerade / Coup)
const CARD_DECK = [
    "Kanzlerin", "Kanzlerin", "Kanzlerin",
    "Straßenräuber", "Straßenräuber", "Straßenräuber",
    "Bluthund", "Bluthund", "Bluthund",
    "Bodyguard", "Bodyguard", "Bodyguard",
    "Spion", "Spion", "Spion"
];

let players = {}; // Speicher für verbundene Spieler

function shuffle(array) {
    let deck = [...array];
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {
    console.log('Neuer Client verbunden:', socket.id);

    // 1. Spieler tritt bei (Nur Name vergeben)
    socket.on('join-game', (username) => {
        players[socket.id] = {
            id: socket.id,
            name: username || 'Spieler_' + socket.id.substr(0, 4),
            cards: []
        };

        // Liste aller Spieler an alle senden
        io.emit('update-players', Object.values(players));
    });

    // 2. WebRTC Signaling (Video / Audio Verbindungsaufbau)
    socket.on('webrtc-offer', (data) => {
        socket.to(data.target).emit('webrtc-offer', {
            sdp: data.sdp,
            caller: socket.id
        });
    });

    socket.on('webrtc-answer', (data) => {
        socket.to(data.target).emit('webrtc-answer', {
            sdp: data.sdp,
            responder: socket.id
        });
    });

    socket.on('webrtc-ice-candidate', (data) => {
        socket.to(data.target).emit('webrtc-ice-candidate', {
            candidate: data.candidate,
            sender: socket.id
        });
    });

    // 3. Karten geben (Jeder sieht NUR seine eigenen Karten)
    socket.on('start-game', () => {
        const deck = shuffle(CARD_DECK);
        
        Object.keys(players).forEach((id) => {
            // Jedem Spieler 2 Karten geben
            players[id].cards = [deck.pop(), deck.pop()];
            
            // Exklusiv NUR an diesen einen Spieler senden!
            io.to(id).emit('your-cards', players[id].cards);
        });

        io.emit('game-status', 'Das Spiel hat begonnen! Die Karten wurden ausgeteilt.');
    });

    // Trennung verarbeiten
    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update-players', Object.values(players));
        io.emit('user-disconnected', socket.id);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
