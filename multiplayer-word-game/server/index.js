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

function makeToken() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanName(n) {
  return (n || 'Player').toString().slice(0, 20) || 'Player';
}

function pickWord(difficulty) {
  const pool = difficulty && difficulty !== 'mixed'
    ? WORDS.filter((w) => w.difficulty === difficulty)
    : WORDS;
  const list = pool.length ? pool : WORDS;
  return list[Math.floor(Math.random() * list.length)];
}

// stable ids: client votes/identifies by token, never socket.id
function publicPlayers(game) {
  return game.players.map((p) => ({
    id: p.token,
    name: p.name,
    isHost: p.token === game.hostToken,
    score: game.scores[p.token] || 0,
    connected: p.connected,
  }));
}

function findBySocket(socketId) {
  for (const game of games.values()) {
    const player = game.players.find((p) => p.socketId === socketId);
    if (player) return { game, player };
  }
  return {};
}

function emitToPlayer(player, event, data) {
  if (player.socketId) io.to(player.socketId).emit(event, data);
}

function sendRoundState(game, player) {
  if (!game.round) return;
  const isImpostor = player.token === game.round.impostorToken;
  emitToPlayer(player, 'round-started', {
    code: game.code,
    isImpostor,
    word: isImpostor ? null : game.round.word,
    hints: isImpostor ? game.round.hints : [],
    difficulty: game.round.difficulty,
    players: publicPlayers(game),
    speakOrder: game.round.speakOrder || [],
    turnIndex: game.round.turnIndex || 0,
  });
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
  const impostor = game.players.find((p) => p.token === game.round.impostorToken);
  const caught = !tied && topId === game.round.impostorToken;
  if (caught) {
    game.players.forEach((p) => {
      if (p.token !== game.round.impostorToken) game.scores[p.token] = (game.scores[p.token] || 0) + 1;
    });
  } else if (impostor) {
    game.scores[impostor.token] = (game.scores[impostor.token] || 0) + 2;
  }
  game.status = 'RESULTS';
  const payload = {
    word: game.round.word,
    difficulty: game.round.difficulty,
    impostorName: impostor ? impostor.name : '???',
    impostorId: game.round.impostorToken,
    votedOutId: tied ? null : topId,
    tied,
    caught,
    tally,
    players: publicPlayers(game),
  };
  game.lastResults = payload;
  io.to(code).emit('round-results', payload);
}

io.on('connection', (socket) => {
  socket.on('create-game', ({ name, token }) => {
    const code = makeCode();
    const playerToken = (token || makeToken()).toString().slice(0, 16);
    const game = {
      code,
      hostToken: playerToken,
      status: 'LOBBY',
      players: [{ token: playerToken, socketId: socket.id, name: cleanName(name), connected: true }],
      scores: { [playerToken]: 0 },
      round: null,
      lastResults: null,
      cleanupTimer: null,
    };
    games.set(code, game);
    socket.join(code);
    socket.emit('game-created', { code, token: playerToken, players: publicPlayers(game) });
  });

  socket.on('join-game', ({ code, name, token }) => {
    code = (code || '').toUpperCase().trim();
    const game = games.get(code);
    if (!game) return socket.emit('error-msg', 'Room not found. Check the code.');
    const playerToken = (token || makeToken()).toString().slice(0, 16);
    const existing = game.players.find((p) => p.token === playerToken);
    if (existing) {
      // reclaim same seat (refresh before joining fully)
      existing.socketId = socket.id;
      existing.connected = true;
      existing.name = cleanName(name || existing.name);
      if (game.cleanupTimer) { clearTimeout(game.cleanupTimer); game.cleanupTimer = null; }
      socket.join(code);
      socket.emit('game-joined', { code, token: playerToken, players: publicPlayers(game) });
      io.to(code).emit('players-updated', { players: publicPlayers(game) });
      if (game.status !== 'LOBBY' && game.round) sendRoundState(game, existing);
      else if (game.status === 'RESULTS' && game.lastResults) {
        emitToPlayer(existing, 'round-results', game.lastResults);
      }
      return;
    }
    if (game.status !== 'LOBBY') return socket.emit('error-msg', 'Round in progress. Wait for lobby.');
    if (game.players.length >= 12) return socket.emit('error-msg', 'Room is full.');
    game.players.push({ token: playerToken, socketId: socket.id, name: cleanName(name), connected: true });
    game.scores[playerToken] = 0;
    if (game.cleanupTimer) { clearTimeout(game.cleanupTimer); game.cleanupTimer = null; }
    socket.join(code);
    io.to(code).emit('players-updated', { players: publicPlayers(game) });
    socket.emit('game-joined', { code, token: playerToken, players: publicPlayers(game) });
  });

  // explicit rejoin after refresh: restores seat + current phase
  socket.on('rejoin-game', ({ code, token }) => {
    code = (code || '').toUpperCase().trim();
    const game = games.get(code);
    if (!game || !token) return socket.emit('rejoin-failed', {});
    const player = game.players.find((p) => p.token === token);
    if (!player) return socket.emit('rejoin-failed', {});
    player.socketId = socket.id;
    player.connected = true;
    if (game.cleanupTimer) { clearTimeout(game.cleanupTimer); game.cleanupTimer = null; }
    socket.join(code);
    socket.emit('game-joined', { code, token, players: publicPlayers(game), rejoined: true });
    io.to(code).emit('players-updated', { players: publicPlayers(game) });
    if (game.status === 'RESULTS' && game.lastResults) {
      emitToPlayer(player, 'round-results', game.lastResults);
    } else if (game.round) {
      sendRoundState(game, player);
      const votes = game.round.votes;
      emitToPlayer(player, 'votes-updated', {
        count: Object.keys(votes).length,
        total: game.players.filter((p) => p.connected).length || game.players.length,
        voted: Object.keys(votes),
      });
      if (votes[token]) {
        const target = game.players.find((p) => p.token === votes[token]);
        emitToPlayer(player, 'vote-accepted', { votedName: target ? target.name : '?' });
      }
    }
  });

  socket.on('start-game', ({ code, difficulty }) => {
    const { game, player } = findBySocket(socket.id);
    if (!game || !player || code !== game.code) return;
    if (player.token !== game.hostToken) return;
    if (game.status !== 'LOBBY') return socket.emit('error-msg', 'Round already in progress.');
    const active = game.players.filter((p) => p.connected);
    if (active.length < 3) return socket.emit('error-msg', 'Need at least 3 connected players.');
    const allowed = ['easy', 'medium', 'hard', 'mixed'];
    const diff = allowed.includes(difficulty) ? difficulty : 'mixed';
    const wordEntry = pickWord(diff);
    const impostor = active[Math.floor(Math.random() * active.length)];
    // shuffled speaking order, random first speaker
    const order = active.map((p) => p.token);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    game.status = 'WORD_REVEAL';
    game.lastResults = null;
    game.round = {
      word: wordEntry.word,
      hints: wordEntry.hints,
      difficulty: wordEntry.difficulty,
      impostorToken: impostor.token,
      votes: {},
      speakOrder: order,
      turnIndex: 0,
    };
    game.players.forEach((p) => { if (p.connected) sendRoundState(game, p); });
  });

  socket.on('submit-vote', ({ code, votedId }) => {
    const { game, player } = findBySocket(socket.id);
    if (!game || !player) return socket.emit('error-msg', 'Not in a room. Refresh to rejoin.');
    if (code !== game.code) return socket.emit('error-msg', 'Wrong room. Refresh to rejoin.');
    if (!game.round) return socket.emit('error-msg', 'No round in progress.');
    if (!game.players.some((p) => p.token === votedId)) return socket.emit('error-msg', 'Invalid vote.');
    if (votedId === player.token) return socket.emit('error-msg', 'You cannot vote for yourself.');
    game.round.votes[player.token] = votedId;
    const target = game.players.find((p) => p.token === votedId);
    socket.emit('vote-accepted', { votedName: target ? target.name : '?' });
    const connectedCount = game.players.filter((p) => p.connected).length;
    io.to(code).emit('votes-updated', {
      count: Object.keys(game.round.votes).length,
      total: connectedCount,
      voted: Object.keys(game.round.votes),
    });
    if (Object.keys(game.round.votes).length >= connectedCount) finishRound(code);
  });

  // anyone in the room can move the speaking turn along (cooperative voice party)
  socket.on('advance-turn', ({ code }) => {
    const { game, player } = findBySocket(socket.id);
    if (!game || !player || code !== game.code) return;
    if (!game.round || !game.round.speakOrder || !game.round.speakOrder.length) return;
    game.round.turnIndex = (game.round.turnIndex + 1) % game.round.speakOrder.length;
    io.to(code).emit('turn-updated', {
      order: game.round.speakOrder,
      index: game.round.turnIndex,
    });
  });

  socket.on('next-round', ({ code }) => {
    const { game, player } = findBySocket(socket.id);
    if (!game || !player || code !== game.code) return;
    if (player.token !== game.hostToken) return;
    game.status = 'LOBBY';
    game.round = null;
    game.lastResults = null;
    io.to(code).emit('back-to-lobby', { players: publicPlayers(game) });
  });

  socket.on('disconnect', () => {
    const { game, player } = findBySocket(socket.id);
    if (!game || !player) return;
    player.connected = false;
    player.socketId = null;
    const connected = game.players.filter((p) => p.connected);
    // host left: pass to first connected player
    if (player.token === game.hostToken && connected.length) {
      game.hostToken = connected[0].token;
    }
    io.to(game.code).emit('players-updated', { players: publicPlayers(game) });
    if (game.round) {
      const votes = game.round.votes;
      io.to(game.code).emit('votes-updated', {
        count: Object.keys(votes).length,
        total: connected.length || 1,
        voted: Object.keys(votes),
      });
      if (connected.length && Object.keys(votes).length >= connected.length) finishRound(game.code);
    }
    // delete empty rooms after 5 min (allows everyone to refresh at once)
    if (!connected.length) {
      if (game.cleanupTimer) clearTimeout(game.cleanupTimer);
      game.cleanupTimer = setTimeout(() => {
        const g = games.get(game.code);
        if (g && !g.players.some((p) => p.connected)) games.delete(game.code);
      }, 5 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`IMPOSTOR running on http://localhost:${PORT} (${WORDS.length} words loaded)`);
});
