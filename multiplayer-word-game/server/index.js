const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { WORDS } = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => res.json({ ok: true, words: WORDS.length }));

const games = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return games.has(code) ? makeCode() : code;
}

function pickWord(difficulty) {
  const pool = difficulty && difficulty !== 'mixed'
    ? WORDS.filter((w) => w.difficulty === difficulty)
    : WORDS;
  const list = pool.length ? pool : WORDS;
  return list[Math.floor(Math.random() * list.length)];
}

function publicPlayers(game) {
  return game.players.map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    score: game.scores[p.id] || 0,
  }));
}

function finishRound(code) {
  const game = games.get(code);
  if (!game || !game.round) return;
  const tally = {};
  Object.values(game.round.votes).forEach((id) => { tally[id] = (tally[id] || 0) + 1; });
  let topId = null;
  let topVotes = 0;
  let tied = false;
  Object.entries(tally).forEach(([id, n]) => {
    if (n > topVotes) { topVotes = n; topId = id; tied = false; }
    else if (n === topVotes) { tied = true; }
  });
  const impostor = game.players.find((p) => p.id === game.round.impostorId);
  const caught = !tied && topId === game.round.impostorId;
  // scoring: crew +1 each if caught, impostor +2 if escaped
  if (caught) {
    game.players.forEach((p) => {
      if (p.id !== game.round.impostorId) game.scores[p.id] = (game.scores[p.id] || 0) + 1;
    });
  } else if (impostor) {
    game.scores[impostor.id] = (game.scores[impostor.id] || 0) + 2;
  }
  game.status = 'RESULTS';
  io.to(code).emit('round-results', {
    word: game.round.word,
    difficulty: game.round.difficulty,
    impostorName: impostor ? impostor.name : '???',
    impostorId: game.round.impostorId,
    votedOutId: tied ? null : topId,
    tied,
    caught,
    tally,
    players: publicPlayers(game),
  });
}

io.on('connection', (socket) => {
  socket.on('create-game', ({ name }) => {
    const code = makeCode();
    const game = {
      code,
      hostId: socket.id,
      status: 'LOBBY',
      players: [{ id: socket.id, name: (name || 'Host').slice(0, 20), isHost: true }],
      scores: { [socket.id]: 0 },
      round: null,
    };
    games.set(code, game);
    socket.join(code);
    socket.emit('game-created', { code, players: publicPlayers(game) });
  });

  socket.on('join-game', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const game = games.get(code);
    if (!game) return socket.emit('error-msg', 'Room not found. Check the code.');
    if (game.status !== 'LOBBY') return socket.emit('error-msg', 'Round in progress. Wait for lobby.');
    if (game.players.length >= 12) return socket.emit('error-msg', 'Room is full.');
    game.players.push({ id: socket.id, name: (name || 'Player').slice(0, 20), isHost: false });
    game.scores[socket.id] = 0;
    socket.join(code);
    io.to(code).emit('players-updated', { players: publicPlayers(game) });
    socket.emit('game-joined', { code, players: publicPlayers(game) });
  });

  socket.on('start-game', ({ code, difficulty }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;
    if (game.status !== 'LOBBY') return socket.emit('error-msg', 'Round already in progress.');
    if (game.players.length < 3) return socket.emit('error-msg', 'Need at least 3 players to start.');
    const allowed = ['easy', 'medium', 'hard', 'mixed'];
    const diff = allowed.includes(difficulty) ? difficulty : 'mixed';
    const wordEntry = pickWord(diff);
    const impostorIdx = Math.floor(Math.random() * game.players.length);
    game.status = 'WORD_REVEAL';
    game.round = {
      word: wordEntry.word,
      hints: wordEntry.hints,
      difficulty: wordEntry.difficulty,
      impostorId: game.players[impostorIdx].id,
      votes: {},
    };
    game.players.forEach((p, idx) => {
      const isImpostor = idx === impostorIdx;
      io.to(p.id).emit('round-started', {
        code,
        isImpostor,
        word: isImpostor ? null : wordEntry.word,
        hints: isImpostor ? wordEntry.hints : [],
        difficulty: wordEntry.difficulty,
        players: publicPlayers(game),
      });
    });
  });

  socket.on('submit-vote', ({ code, votedId }) => {
    const game = games.get(code);
    if (!game || !game.round) return;
    if (!game.players.some((p) => p.id === votedId)) return;
    if (votedId === socket.id) return socket.emit('error-msg', 'You cannot vote for yourself.');
    game.round.votes[socket.id] = votedId;
    const totalVotes = Object.keys(game.round.votes).length;
    io.to(code).emit('votes-updated', { count: totalVotes, total: game.players.length });
    if (totalVotes >= game.players.length) finishRound(code);
  });

  socket.on('next-round', ({ code }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;
    game.status = 'LOBBY';
    game.round = null;
    io.to(code).emit('back-to-lobby', { players: publicPlayers(game) });
  });

  socket.on('disconnect', () => {
    for (const [code, game] of games) {
      const idx = game.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        game.players.splice(idx, 1);
        delete game.scores[socket.id];
        if (game.round) delete game.round.votes[socket.id];
        if (game.players.length === 0) {
          games.delete(code);
        } else {
          if (socket.id === game.hostId) {
            game.hostId = game.players[0].id;
            game.players[0].isHost = true;
          }
          io.to(code).emit('players-updated', { players: publicPlayers(game) });
          // if everyone remaining has voted, finish early
          if (game.round && Object.keys(game.round.votes).length >= game.players.length) {
            finishRound(code);
          } else if (game.round) {
            io.to(code).emit('votes-updated', {
              count: Object.keys(game.round.votes).length,
              total: game.players.length,
            });
          }
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`IMPOSTOR running on http://localhost:${PORT} (${WORDS.length} words loaded)`);
});
