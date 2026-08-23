const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Alle statischen Dateien direkt aus dem Hauptverzeichnis servieren
app.use(express.static(__dirname));

// Direktes Ausliefern der index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    socket.on('join-game', (username) => {
        socket.username = username;
        io.emit('chat-message', `${username} ist dem Spiel beigetreten.`);
    });

    socket.on('game-action', (action) => {
        io.emit('action-broadcast', { user: socket.username || 'Anonym', action: action });
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
