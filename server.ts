import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import { Tile, GameState, Player, Color, OpenSet, RoundScore } from "./src/types";
import { v4 as uuidv4 } from "uuid";
import { isValidOkeySet, calculateSetPoints, calculateHandPenalty, getJokerReplacement, isValidKonkan } from "./src/utils";
import os from "os";
import Database from "better-sqlite3";

const db = new Database("okey.db");

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    uid TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL
  )
`);

const PORT = 3000;

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

function createDeck(): Tile[] {
  const colors: Color[] = ["red", "black", "blue", "yellow"];
  const deck: Tile[] = [];

  // Two of each tile (1-13 in 4 colors)
  for (let i = 0; i < 2; i++) {
    colors.forEach((color) => {
      for (let num = 1; num <= 13; num++) {
        deck.push({ id: uuidv4(), color, value: num, isFakeJoker: false });
      }
    });
    // Two jokers
    deck.push({ id: uuidv4(), color: "red", value: 0, isFakeJoker: true });
  }

  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

interface RoomState extends GameState {
  roomCode: string;
}

const rooms = new Map<string, RoomState>();

function generateRoomCode(): string {
  let code = "";
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

function getInitialGameState(roomCode: string): RoomState {
  return {
    roomCode,
    status: 'lobby',
    players: [],
    deck: [],
    discardPile: [],
    openSets: [],
    winner: null,
    currentTurnPlayerId: null,
    turnPhase: 'draw',
    roundScores: [],
    highestOpeningScore: { 1: 0, 2: 0 },
    firstOpenerId: null,
    turnCount: 0,
    kharbatVote: null,
  };
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("getUsername", (uid: string) => {
      const row = db.prepare("SELECT username FROM users WHERE uid = ?").get(uid) as { username: string } | undefined;
      socket.emit("usernameResult", { uid, username: row?.username || null });
    });

    socket.on("setUsername", ({ uid, username }: { uid: string, username: string }) => {
      try {
        db.prepare("INSERT INTO users (uid, username) VALUES (?, ?)").run(uid, username);
        socket.emit("setUsernameResult", { success: true, username });
      } catch (error: any) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          socket.emit("setUsernameResult", { success: false, error: "Username already taken" });
        } else {
          socket.emit("setUsernameResult", { success: false, error: "Database error" });
        }
      }
    });

    socket.on("createRoom", ({ uid, name, team }: { uid: string, name: string, team: 1 | 2 }) => {
      const roomCode = generateRoomCode();
      const room = getInitialGameState(roomCode);
      
      const newPlayer: Player = {
        id: socket.id,
        uid,
        name,
        team,
        handGrid: Array(30).fill(null),
        isHost: true,
        ready: true,
        hasOpened: false,
        openingPoints: 0,
        meldPoints: 0,
        disconnected: false,
      };

      room.players.push(newPlayer);
      rooms.set(roomCode, room);
      socket.join(roomCode);
      socket.emit("roomCreated", roomCode);
      io.to(roomCode).emit("gameState", room);
      console.log(`Room ${roomCode} created by ${name}`);
    });

    socket.on("joinRoom", ({ roomCode, uid, name, team }: { roomCode: string, uid: string, name: string, team: 1 | 2 }) => {
      const room = rooms.get(roomCode);
      if (!room) {
        socket.emit("error", "Room not found!");
        return;
      }

      // Check for rejoining by UID
      const existingPlayer = room.players.find(p => p.uid === uid);
      if (existingPlayer) {
        const oldId = existingPlayer.id;
        existingPlayer.id = socket.id;
        existingPlayer.disconnected = false;
        
        if (room.currentTurnPlayerId === oldId) {
          room.currentTurnPlayerId = socket.id;
        }
        
        room.openSets.forEach(set => {
          if (set.ownerId === oldId) {
            set.ownerId = socket.id;
          }
        });

        socket.join(roomCode);
        io.to(roomCode).emit("gameState", room);
        socket.emit("roomJoined", roomCode);
        return;
      }

      const team1Count = room.players.filter(p => p.team === 1).length;
      const team2Count = room.players.filter(p => p.team === 2).length;

      if (team === 1 && team1Count >= 2) {
        socket.emit("error", "Team 1 is full");
        return;
      }
      if (team === 2 && team2Count >= 2) {
        socket.emit("error", "Team 2 is full");
        return;
      }

      if (room.players.length >= 4) {
        socket.emit("error", "Room is full");
        return;
      }

      const newPlayer: Player = {
        id: socket.id,
        uid,
        name,
        team,
        handGrid: Array(30).fill(null),
        isHost: room.players.length === 0,
        ready: true,
        hasOpened: false,
        openingPoints: 0,
        meldPoints: 0,
        disconnected: false,
      };

      room.players.push(newPlayer);
      socket.join(roomCode);
      io.to(roomCode).emit("gameState", room);
      console.log(`${name} joined room ${roomCode}`);
    });

    socket.on("startGame", ({ roomCode, initialScores }: { roomCode: string, initialScores?: { team1: number, team2: number } }) => {
      const room = rooms.get(roomCode);
      if (!room) return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player || !player.isHost) {
        socket.emit("error", "Only the host can start the game!");
        return;
      }

      if (room.players.length < 1) {
        socket.emit("error", "Need at least 1 player to start!");
        return;
      }

      // Turn order setup: Start with host and alternate teams
      room.players = reorderPlayersAlternating(room.players, socket.id);

      // Initialize game
      const fullDeck = createDeck();
      room.players.forEach((p, index) => {
        const count = index === 0 ? 15 : 14;
        const tiles = fullDeck.splice(0, count);
        p.handGrid = Array(30).fill(null);
        tiles.forEach((t, i) => { p.handGrid[i] = t; });
        p.hasOpened = false;
        p.openingPoints = 0;
        p.meldPoints = 0;
        p.pendingDiscardId = null;
        p.hasPickedJokerThisTurn = false;
        p.isKonkan = false;
      });

      room.deck = fullDeck;
      room.discardPile = [];
      room.openSets = [];
      room.status = 'playing';
      room.winner = null;
      room.highestOpeningScore = { 1: 0, 2: 0 };
      room.firstOpenerId = null;
      room.turnCount = 0;
      room.kharbatVote = null;
      room.currentTurnPlayerId = room.players[0].id;
      
      if (initialScores) {
        room.roundScores = [{ team1: initialScores.team1, team2: initialScores.team2 }];
      } else {
        room.roundScores = [];
      }
      
      const firstPlayerHandCount = room.players[0].handGrid.filter(t => t !== null).length;
      room.turnPhase = firstPlayerHandCount === 15 ? 'action' : 'draw';

      io.to(roomCode).emit("gameState", room);
    });

    socket.on("drawTile", (roomCode: string) => {
      const room = rooms.get(roomCode);
      if (!room || room.status !== 'playing' || room.currentTurnPlayerId !== socket.id || room.turnPhase !== 'draw') return;

      if (room.deck.length === 0) {
        if (room.discardPile.length > 1) {
          const lastDiscard = room.discardPile.pop()!;
          const newDeck = [...room.discardPile].sort(() => Math.random() - 0.5);
          room.deck = newDeck;
          room.discardPile = [lastDiscard];
        } else {
          socket.emit("error", "No more tiles!");
          return;
        }
      }

      const player = room.players.find(p => p.id === socket.id)!;
      const tile = room.deck.pop()!;
      const emptyIndex = player.handGrid.indexOf(null);
      if (emptyIndex !== -1) player.handGrid[emptyIndex] = tile;
      
      room.turnPhase = 'action';
      io.to(roomCode).emit("gameState", room);
    });

    socket.on("discardTile", ({ roomCode, tileId }: { roomCode: string, tileId: string }) => {
      const room = rooms.get(roomCode);
      if (!room || room.status !== 'playing' || room.currentTurnPlayerId !== socket.id || room.turnPhase !== 'action') return;

      const player = room.players.find(p => p.id === socket.id)!;
      if (!player.isKonkan && !player.hasOpened && (player.pendingDiscardId || (player.hasPickedJokerThisTurn && !player.hasOpened))) {
        socket.emit("error", "You must open your game before discarding!");
        return;
      }

      const tileIndex = player.handGrid.findIndex(t => t?.id === tileId);
      if (tileIndex === -1) return;

      const discardedTile = player.handGrid[tileIndex]!;
      player.handGrid[tileIndex] = null;
      room.discardPile.push(discardedTile);
      
      if (player.handGrid.filter(t => t !== null).length === 0) {
        handleWin(room, player);
        return;
      }

      const currentIndex = room.players.findIndex(p => p.id === socket.id);
      const nextIndex = (currentIndex + 1) % room.players.length;
      room.currentTurnPlayerId = room.players[nextIndex].id;
      room.turnPhase = 'draw';
      player.hasPickedJokerThisTurn = false;
      player.pendingDiscardId = null;
      room.turnCount++;
      room.kharbatVote = null;

      io.to(roomCode).emit("gameState", room);
    });

    socket.on("takeDiscard", (roomCode: string) => {
      const room = rooms.get(roomCode);
      if (!room || room.status !== 'playing' || room.currentTurnPlayerId !== socket.id || room.turnPhase !== 'draw' || room.discardPile.length === 0) return;

      const player = room.players.find(p => p.id === socket.id)!;
      const tile = room.discardPile.pop()!;
      const emptyIndex = player.handGrid.indexOf(null);
      if (emptyIndex !== -1) player.handGrid[emptyIndex] = tile;
      
      if (!player.isKonkan && !player.hasOpened) player.pendingDiscardId = tile.id;
      room.turnPhase = 'action';
      io.to(roomCode).emit("gameState", room);
    });

    socket.on("undoTakeDiscard", (roomCode: string) => {
      const room = rooms.get(roomCode);
      if (!room || room.status !== 'playing' || room.currentTurnPlayerId !== socket.id || room.turnPhase !== 'action') return;

      const player = room.players.find(p => p.id === socket.id)!;
      if (!player.pendingDiscardId) return;

      const tileIndex = player.handGrid.findIndex(t => t?.id === player.pendingDiscardId);
      if (tileIndex !== -1) {
        const tile = player.handGrid[tileIndex]!;
        player.handGrid[tileIndex] = null;
        room.discardPile.push(tile);
        player.pendingDiscardId = null;
        room.turnPhase = 'draw';
        io.to(roomCode).emit("gameState", room);
      }
    });

    socket.on("moveTileInGrid", ({ roomCode, fromIndex, toIndex }: { roomCode: string, fromIndex: number, toIndex: number }) => {
      const room = rooms.get(roomCode);
      if (!room) return;
      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;

      const tile = player.handGrid[fromIndex];
      const targetTile = player.handGrid[toIndex];
      player.handGrid[toIndex] = tile;
      player.handGrid[fromIndex] = targetTile;
      io.to(roomCode).emit("gameState", room);
    });

    socket.on("openMultipleSets", ({ roomCode, sets }: { roomCode: string, sets: Tile[][] }) => {
      const room = rooms.get(roomCode);
      if (!room || room.currentTurnPlayerId !== socket.id || room.turnPhase !== 'action') return;
      const player = room.players.find(p => p.id === socket.id)!;

      let totalPoints = 0;
      const allTileIdsToOpen = sets.flat().map(t => t.id);
      const currentHand = player.handGrid.filter(t => t !== null) as Tile[];
      
      for (const set of sets) {
        if (!isValidOkeySet(set)) { socket.emit("error", "Invalid set!"); return; }
        totalPoints += calculateSetPoints(set);
      }

      const myTeam = player.team as 1 | 2;
      const teammate = room.players.find(p => p.team === myTeam && p.id !== player.id);
      const teammateHasOpened = teammate?.hasOpened || false;
      const highestOpponentOpening = room.highestOpeningScore[myTeam === 1 ? 2 : 1];

      if (!player.hasOpened) {
        if (teammateHasOpened) {
          if (totalPoints < 61) { socket.emit("error", "Need 61 points!"); return; }
        } else {
          if (totalPoints < 81) { socket.emit("error", "Need 81 points!"); return; }
          if (highestOpponentOpening > 0 && totalPoints <= highestOpponentOpening) {
            socket.emit("error", `Must beat ${highestOpponentOpening}!`); return;
          }
        }
      }

      if (player.pendingDiscardId && !allTileIdsToOpen.includes(player.pendingDiscardId)) {
        socket.emit("error", "Must use picked discard!"); return;
      }

      player.handGrid = player.handGrid.map(t => (t && allTileIdsToOpen.includes(t.id)) ? null : t);
      player.hasOpened = true;
      player.pendingDiscardId = null; // Clear pending discard once opened
      player.meldPoints += totalPoints;
      if (totalPoints > room.highestOpeningScore[myTeam]) room.highestOpeningScore[myTeam] = totalPoints;

      sets.forEach(tiles => {
        room.openSets.push({ id: `set-${uuidv4()}`, tiles, ownerId: player.id });
      });

      io.to(roomCode).emit("gameState", room);
    });

    socket.on("addToSet", ({ roomCode, setId, tileId }: { roomCode: string, setId: string, tileId: string }) => {
      const room = rooms.get(roomCode);
      if (!room || room.currentTurnPlayerId !== socket.id) return;
      const player = room.players.find(p => p.id === socket.id)!;
      const set = room.openSets.find(s => s.id === setId)!;

      const tileIndex = player.handGrid.findIndex(t => t?.id === tileId);
      const tile = player.handGrid[tileIndex]!;
      const newTiles = [...set.tiles, tile];
      
      if (!isValidOkeySet(newTiles)) { socket.emit("error", "Invalid move!"); return; }

      const oldPoints = calculateSetPoints(set.tiles);
      player.handGrid[tileIndex] = null;
      set.tiles.push(tile);
      player.meldPoints += (calculateSetPoints(set.tiles) - oldPoints);
      io.to(roomCode).emit("gameState", room);
    });

    socket.on("replaceJoker", ({ roomCode, setId, tileId, jokerId }: { roomCode: string, setId: string, tileId: string, jokerId: string }) => {
      const room = rooms.get(roomCode);
      if (!room || room.currentTurnPlayerId !== socket.id) return;
      const player = room.players.find(p => p.id === socket.id)!;
      const set = room.openSets.find(s => s.id === setId)!;

      if (!player.hasOpened && !player.isKonkan) {
        socket.emit("error", "You must open your hand before replacing a joker!");
        return;
      }

      const tileIndex = player.handGrid.findIndex(t => t?.id === tileId);
      const tile = player.handGrid[tileIndex]!;
      const jokerIndex = set.tiles.findIndex(t => t.id === jokerId);
      const joker = set.tiles[jokerIndex];

      const replacements = getJokerReplacement(set.tiles, joker.id);
      if (!replacements.some(r => r.value === tile.value && r.color === tile.color)) {
        socket.emit("error", "Invalid replacement!"); return;
      }

      player.handGrid[tileIndex] = joker;
      set.tiles[jokerIndex] = tile;
      player.hasPickedJokerThisTurn = true;
      io.to(roomCode).emit("gameState", room);
    });

    socket.on("enterKonkan", (roomCode: string) => {
      const room = rooms.get(roomCode);
      if (!room || room.status !== 'playing') return;
      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.hasOpened) return;

      player.isKonkan = true;
      io.to(roomCode).emit("gameMessage", `${player.name} entered KONKAN mode!`);
      io.to(roomCode).emit("gameState", room);
    });

    socket.on("resetGame", (roomCode: string) => {
      const room = rooms.get(roomCode);
      if (!room) return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player || (!player.isHost && room.status !== 'finished')) {
        socket.emit("error", "Only the host can reset the game!");
        return;
      }

      // If finished, we start a new round immediately
      if (room.status === 'finished') {
        // Reorder players so host (winner) is first and teams alternate
        const host = room.players.find(p => p.isHost);
        if (host) {
          room.players = reorderPlayersAlternating(room.players, host.id);
        }

        // Initialize game (similar to startGame)
        const fullDeck = createDeck();
        room.players.forEach((p, index) => {
          const count = index === 0 ? 15 : 14;
          const tiles = fullDeck.splice(0, count);
          p.handGrid = Array(30).fill(null);
          tiles.forEach((t, i) => { p.handGrid[i] = t; });
          p.hasOpened = false;
          p.openingPoints = 0;
          p.meldPoints = 0;
          p.pendingDiscardId = null;
          p.hasPickedJokerThisTurn = false;
          p.isKonkan = false;
        });

        room.deck = fullDeck;
        room.discardPile = [];
        room.openSets = [];
        room.status = 'playing';
        room.winner = null;
        room.highestOpeningScore = { 1: 0, 2: 0 };
        room.firstOpenerId = null;
        room.turnCount = 0;
        room.kharbatVote = null;
        room.currentTurnPlayerId = room.players[0].id;
        room.turnPhase = 'action'; // Host starts with 15 tiles

        io.to(roomCode).emit("gameState", room);
      } else {
        // Just go back to lobby
        room.status = 'lobby';
        io.to(roomCode).emit("gameState", room);
      }
    });

    socket.on("requestKharbat", (roomCode: string) => {
      const room = rooms.get(roomCode);
      if (!room || room.turnCount >= room.players.length) return;
      const player = room.players.find(p => p.id === socket.id)!;

      room.kharbatVote = { requesterId: socket.id, votes: { [socket.id]: true } };
      io.to(roomCode).emit("gameMessage", `${player.name} requested KHARBAT!`);
      io.to(roomCode).emit("gameState", room);
    });

    socket.on("voteKharbat", ({ roomCode, agree }: { roomCode: string, agree: boolean }) => {
      const room = rooms.get(roomCode);
      if (!room || !room.kharbatVote) return;

      room.kharbatVote.votes[socket.id] = agree;
      if (!agree) {
        io.to(roomCode).emit("gameMessage", "Kharbat rejected.");
        room.kharbatVote = null;
      } else if (Object.keys(room.kharbatVote.votes).length >= room.players.filter(p => !p.disconnected).length) {
        // Reset logic
        const fullDeck = createDeck();
        room.players.forEach((p, index) => {
          const count = index === 0 ? 15 : 14;
          p.handGrid = Array(30).fill(null);
          fullDeck.splice(0, count).forEach((t, i) => { p.handGrid[i] = t; });
          p.hasOpened = false;
          p.openingPoints = 0;
          p.meldPoints = 0;
        });
        room.deck = fullDeck;
        room.discardPile = [];
        room.openSets = [];
        room.turnCount = 0;
        room.kharbatVote = null;
        room.currentTurnPlayerId = room.players[0].id;
        room.turnPhase = room.players[0].handGrid.filter(t => t !== null).length === 15 ? 'action' : 'draw';
      }
      io.to(roomCode).emit("gameState", room);
    });

    socket.on("exitRoom", (roomCode: string) => {
      const room = rooms.get(roomCode);
      if (!room) return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;

      if (room.status === 'playing') {
        player.disconnected = true;
        io.to(roomCode).emit("gameMessage", `${player.name} has left the game (disconnected).`);
      } else {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          rooms.delete(roomCode);
        } else if (!room.players.some(p => p.isHost)) {
          room.players[0].isHost = true;
        }
      }
      
      socket.leave(roomCode);
      io.to(roomCode).emit("gameState", room);
      socket.emit("exitedRoom");
    });

    socket.on("disconnect", () => {
      rooms.forEach((room, roomCode) => {
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
          if (room.status === 'playing') {
            player.disconnected = true;
          } else {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) rooms.delete(roomCode);
          }
          io.to(roomCode).emit("gameState", room);
        }
      });
    });
  });

  function handleWin(room: RoomState, player: Player) {
    room.status = 'finished';
    room.winner = player.name;
    
    // Set winner as host for next round
    room.players.forEach(p => p.isHost = (p.id === player.id));

    const winningTeam = player.team as 1 | 2;
    let roundPoints = 0;
    room.players.forEach(p => {
      if (p.team !== winningTeam) {
        roundPoints += p.hasOpened ? calculateHandPenalty(p.handGrid) : 100;
      }
    });
    room.roundScores.push({ team1: winningTeam === 1 ? roundPoints : 0, team2: winningTeam === 2 ? roundPoints : 0 });
    io.to(room.roomCode).emit("gameState", room);
  }

  function reorderPlayersAlternating(players: Player[], starterId: string): Player[] {
    const starter = players.find(p => p.id === starterId);
    if (!starter) return players;

    const team1 = [...players.filter(p => p.team === 1)];
    const team2 = [...players.filter(p => p.team === 2)];

    // Remove starter from their team list
    if (starter.team === 1) {
      const idx = team1.findIndex(p => p.id === starterId);
      if (idx !== -1) team1.splice(idx, 1);
    } else {
      const idx = team2.findIndex(p => p.id === starterId);
      if (idx !== -1) team2.splice(idx, 1);
    }

    const ordered = [starter];
    let currentTeam = starter.team;

    while (team1.length > 0 || team2.length > 0) {
      const nextTeam = currentTeam === 1 ? 2 : 1;
      const list = nextTeam === 1 ? team1 : team2;
      
      if (list.length > 0) {
        ordered.push(list.shift()!);
        currentTeam = nextTeam;
      } else {
        const otherList = nextTeam === 1 ? team2 : team1;
        if (otherList.length > 0) {
          ordered.push(otherList.shift()!);
          currentTeam = nextTeam;
        } else {
          break;
        }
      }
    }
    return ordered;
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    const localIp = getLocalIp();
    console.log(`\n🚀 Okey Game is running!`);
    console.log(`🏠 Local:   http://localhost:${PORT}`);
    console.log(`🌐 Network: http://${localIp}:${PORT}\n`);
    console.log(`Invite your friends on the same Wi-Fi using the Network URL!`);
  });
}

startServer();
