# IMPOSTOR — party word game

Voice-call social deduction for 3–12 players. Most players see the secret word. One impostor sees hints only. Talk, then vote.

## Stack

- **Server**: Node + Express + Socket.io (`server/index.js`)
- **Client**: vanilla HTML/CSS/JS (`public/`)
- **Words**: 213 entries with difficulty + hints (`server/words.js`)
- No database, no accounts, no build step.

## Run

```powershell
cd multiplayer-word-game
npm install
npm run dev
# open http://localhost:3000 in 2+ tabs
```

`npm start` runs the same server without `--watch`. Health check: `GET /health`.

## How a round works

1. Host clicks **CREATE GAME**, shares the 5-letter room code.
2. Others click **JOIN GAME**, enter code + name. Lobby shows player list.
3. Host clicks **START ROUND** (needs 3+ players). Server picks:
   - a random word (filtered by difficulty if host set one)
   - a random impostor
4. Non-impostors get the word. Impostor gets 4 vague hints + "You are IMPOSTOR".
5. **Discussion** (60s client timer, host can skip to vote early).
6. **Vote**: everyone votes one suspect. When all votes are in, server tallies.
   - Tie = impostor escapes.
7. **Results** show word, impostor, who got voted out, running scores.
8. Host clicks **Back to lobby** for next round. Scores persist until room empties.

## Controls

- Host only: start round, set difficulty, back to lobby.
- Anyone: leave (reloads). If host leaves, oldest remaining player becomes host.
- Room closes when last player leaves (in-memory only).

## Project structure

```
multiplayer-word-game/
  server/
    index.js   # rooms, rounds, votes, scores, socket events
    words.js   # WORDS: { word, difficulty, hints }[]
  public/
    index.html # home / lobby / word / discuss / vote / results
    styles.css # Midnight tokens, responsive
    client.js  # socket wiring, screens, timer
```

## Socket events

- Client → server: `create-game {name,token}`, `join-game {code,name,token}`, `rejoin-game {code,token}` (auto-sent on every reconnect, refresh-safe), `start-game {code,difficulty}`, `submit-vote {code,votedId}`, `next-round {code}`
- Server → client: `game-created`, `game-joined`, `players-updated`, `round-started {isImpostor,word,hints}`, `vote-accepted {votedName}` (a vote only counts once this arrives), `votes-updated {count,total,voted[]}`, `round-results {word,impostorName,caught,votedOutId,scores}`, `back-to-lobby`, `rejoin-failed`, `error-msg`

## Notes

- Hints never contain the word itself by design (see `words.js` header).
- Votes are server-tallied; clients never learn who the impostor is until results.
- Discussion timer is client-side for now; server does not enforce it.

## License

MIT
