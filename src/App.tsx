import React, { useState, useEffect, useMemo } from 'react';
import io from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Play, 
  RotateCcw, 
  Trophy, 
  Hand, 
  Layers, 
  ArrowUpRight,
  User,
  Info,
  Menu,
  X,
  Plus,
  LogIn,
  LogOut
} from 'lucide-react';
import { GameState, Player, Tile, Color, OpenSet } from './types';
import { isValidOkeySet, calculateSetPoints, calculateHandPenalty } from './utils';
import { auth, googleProvider } from './lib/firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "https://kurdokey.onrender.com/";

export default function App() {
  const [socket, setSocket] = useState<any>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [playerName, setPlayerName] = useState('');
  const [team, setTeam] = useState<1 | 2>(1);
  const [isJoined, setIsJoined] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [selectedForSet, setSelectedForSet] = useState<string[]>([]);
  const [stagedSets, setStagedSets] = useState<Tile[][]>([]);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [inputRoomCode, setInputRoomCode] = useState("");
  const [view, setView] = useState<'login' | 'profile' | 'lobby' | 'game'>('login');
  const [messages, setMessages] = useState<string[]>([]);
  const [prevHandIds, setPrevHandIds] = useState<string[]>([]);
  const [lastDrawnTileId, setLastDrawnTileId] = useState<string | null>(null);
  const [isScoreboardOpen, setIsScoreboardOpen] = useState(false);
  const [touchStartPos, setTouchStartPos] = useState<{ x: number, y: number } | null>(null);
  const [longPressTimer, setLongPressTimer] = useState<any>(null);
  const [lastTapTime, setLastTapTime] = useState(0);
  const [movingTileIndex, setMovingTileIndex] = useState<number | null>(null);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isCheckingProfile, setIsCheckingProfile] = useState(false);
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const [initialTeam1Score, setInitialTeam1Score] = useState<number>(0);
  const [initialTeam2Score, setInitialTeam2Score] = useState<number>(0);

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      console.log("Auth state changed:", firebaseUser?.uid);
      setUser(firebaseUser);
      if (firebaseUser) {
        if (socket) {
          console.log("Emitting getUsername for:", firebaseUser.uid);
          setIsCheckingProfile(true);
          socket.emit('getUsername', firebaseUser.uid);
        } else {
          console.log("User logged in but socket not ready yet");
        }
      } else {
        setView('login');
        setIsCheckingProfile(false);
      }
    });
    return () => unsubscribe();
  }, [socket]);

  const handleGoogleSignIn = async () => {
    if (!auth || !googleProvider) {
      alert("Google Sign-In is not configured. Please check your Firebase settings.");
      return;
    }
    setIsLoggingIn(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (result.user.displayName) {
        setPlayerName(result.user.displayName);
      }
    } catch (error: any) {
      console.error("Login failed:", error);
      alert("Login failed: " + error.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSignOut = async () => {
    if (!auth) return;
    try {
      await signOut(auth);
      setPlayerName('');
    } catch (error) {
      console.error("Sign out failed:", error);
    }
  };

  const stagedTileIds = useMemo(() => stagedSets.flat().map(t => t.id), [stagedSets]);

  const stagedPoints = useMemo(() => {
    return stagedSets.reduce((total, set) => {
      return total + calculateSetPoints(set);
    }, 0);
  }, [stagedSets]);

  useEffect(() => {
    // Check if we are running on an ESP8266 (usually via IP directly)
    const isESP8266 = window.location.hostname.startsWith('192.168.4.');
    
    if (isESP8266) {
      const ws = new WebSocket(`ws://${window.location.hostname}:81`);
      ws.onmessage = (event) => {
        const state = JSON.parse(event.data);
        setGameState(state);
      };
      setSocket({
        id: 'esp-client', // Simplified for ESP
        emit: (event: string, data: any) => ws.send(JSON.stringify({ type: event, ...data })),
        disconnect: () => ws.close()
      } as any);
    } else {
      console.log("Connecting to socket at:", SOCKET_URL);
      const newSocket = io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5
      });
      
      setSocket(newSocket);

      newSocket.on('connect', () => {
        console.log("Socket connected!");
        setIsSocketConnected(true);
      });

      newSocket.on('disconnect', () => {
        console.log("Socket disconnected");
        setIsSocketConnected(false);
      });

      newSocket.on('connect_error', (err) => {
        console.error("Socket connection error:", err);
      });

      newSocket.on('gameState', (state: GameState) => {
        setGameState(state);
      });
      newSocket.on('roomCreated', (code: string) => {
        setRoomCode(code);
        localStorage.setItem('okey_room_code', code);
        setIsJoined(true);
        setView('game');
      });
      newSocket.on('roomJoined', (code: string) => {
        setRoomCode(code);
        localStorage.setItem('okey_room_code', code);
        setIsJoined(true);
        setView('game');
      });
      newSocket.on('exitedRoom', () => {
        setIsJoined(false);
        setRoomCode(null);
        localStorage.removeItem('okey_room_code');
        setView('lobby');
      });
      newSocket.on('usernameResult', ({ uid, username }: { uid: string, username: string | null }) => {
        console.log("Received usernameResult:", username);
        setIsCheckingProfile(false);
        if (username) {
          setPlayerName(username);
          setView('lobby');
          
          // Try to rejoin if we have a room code
          const savedRoomCode = localStorage.getItem('okey_room_code');
          if (savedRoomCode) {
            console.log("Attempting to rejoin room:", savedRoomCode);
            newSocket.emit('joinRoom', { roomCode: savedRoomCode, uid, name: username, team: 1 });
          }
        } else {
          setView('profile');
        }
      });
      newSocket.on('setUsernameResult', ({ success, username, error }: { success: boolean, username?: string, error?: string }) => {
        if (success && username) {
          setPlayerName(username);
          setView('lobby');
        } else {
          alert(error || "Failed to set username");
        }
      });
      newSocket.on('error', (msg: string) => {
        alert(msg);
      });
      newSocket.on('gameMessage', (msg: string) => {
        setMessages(prev => [...prev, msg]);
        setTimeout(() => {
          setMessages(prev => prev.filter(m => m !== msg));
        }, 5000);
      });
      return () => {
        newSocket.disconnect();
      };
    }
  }, []);

  const me = useMemo(() => {
    return gameState?.players.find(p => p.id === socket?.id);
  }, [gameState, socket]);

  useEffect(() => {
    if (me) {
      const currentHandIds = me.handGrid.filter(t => t !== null).map(t => t!.id);
      
      // If we just drew a tile (hand size increased)
      if (currentHandIds.length > prevHandIds.length && prevHandIds.length > 0) {
        const newId = currentHandIds.find(id => !prevHandIds.includes(id));
        if (newId) {
          setLastDrawnTileId(newId);
          // Clear after animation
          setTimeout(() => setLastDrawnTileId(null), 1000);
        }
      }
      setPrevHandIds(currentHandIds);
    }
  }, [me?.handGrid]);

  const opponents = useMemo(() => {
    if (!gameState || !socket) return [];
    const myIndex = gameState.players.findIndex(p => p.id === socket.id);
    if (myIndex === -1) return gameState.players;
    
    // Reorder players so "me" is at the bottom, and others are distributed
    const ordered = [];
    for (let i = 1; i < 4; i++) {
      const idx = (myIndex + i) % gameState.players.length;
      if (gameState.players[idx]) {
        ordered.push(gameState.players[idx]);
      }
    }
    return ordered;
  }, [gameState, socket]);

  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (playerName.trim() && socket && user) {
      socket.emit('createRoom', { uid: user.uid, name: playerName, team });
    }
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (playerName.trim() && inputRoomCode.length === 6 && socket && user) {
      setRoomCode(inputRoomCode);
      socket.emit('joinRoom', { roomCode: inputRoomCode, uid: user.uid, name: playerName, team });
      setIsJoined(true);
    }
  };

  const handleExitRoom = () => {
    if (roomCode && socket) {
      socket.emit('exitRoom', roomCode);
    }
  };

  const handleSetUsername = (e: React.FormEvent) => {
    e.preventDefault();
    if (playerName.trim() && socket && user) {
      socket.emit('setUsername', { uid: user.uid, username: playerName });
    }
  };

  const handleStart = () => {
    if (roomCode) socket?.emit('startGame', { 
      roomCode, 
      initialScores: { team1: initialTeam1Score, team2: initialTeam2Score } 
    });
  };

  const isMyTurn = useMemo(() => {
    return gameState?.currentTurnPlayerId === socket?.id;
  }, [gameState, socket]);

  useEffect(() => {
    if (isMyTurn) {
      // Play a subtle "pling" sound
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
        oscillator.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.1); // A4

        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.3);
      } catch (e) {
        console.log("Audio not supported or blocked");
      }
    }
  }, [isMyTurn]);

  const currentTurnPlayerName = useMemo(() => {
    return gameState?.players.find(p => p.id === gameState.currentTurnPlayerId)?.name;
  }, [gameState]);

  const handleDraw = () => {
    if (isMyTurn && gameState?.turnPhase === 'draw' && roomCode) {
      socket?.emit('drawTile', roomCode);
    }
  };

  const handleTakeDiscard = () => {
    if (isMyTurn && gameState?.turnPhase === 'draw' && gameState?.discardPile.length && roomCode) {
      socket?.emit('takeDiscard', roomCode);
    }
  };

  const handleReshuffle = () => {
    if (roomCode) socket?.emit('reshuffleDeck', roomCode);
  };

  const handleUndoTakeDiscard = () => {
    if (isMyTurn && gameState?.turnPhase === 'action' && me?.pendingDiscardId && roomCode) {
      socket?.emit('undoTakeDiscard', roomCode);
      setStagedSets([]);
    }
  };

  const handleDiscard = () => {
    if (selectedTileId && isMyTurn && gameState?.turnPhase === 'action' && me && roomCode) {
      if (me.pendingDiscardId) {
        const teammate = gameState.players.find(p => p.team === me.team && p.id !== me.id);
        const teammateHasOpened = teammate?.hasOpened || false;
        const minPoints = teammateHasOpened ? 61 : 81;
        alert(`You picked up a discard! You must open your game (${minPoints}+ points) before discarding.`);
        return;
      }
      if (me.hasPickedJokerThisTurn && !me.hasOpened) {
        const teammate = gameState.players.find(p => p.team === me.team && p.id !== me.id);
        const teammateHasOpened = teammate?.hasOpened || false;
        const minPoints = teammateHasOpened ? 61 : 81;
        alert(`You picked up a joker! You must open your game (${minPoints}+ points) before discarding.`);
        return;
      }
      socket?.emit('discardTile', { roomCode, tileId: selectedTileId });
      setSelectedTileId(null);
    }
  };

  const handleMoveTile = (fromIndex: number, toIndex: number) => {
    if (roomCode) socket?.emit('moveTileInGrid', { roomCode, fromIndex, toIndex });
  };

  const handleStageSet = () => {
    if (selectedForSet.length >= 3 && me && gameState) {
      const currentHand = me.handGrid.filter(t => t !== null) as Tile[];
      const tiles = currentHand.filter(t => selectedForSet.includes(t.id));
      
      // Check if any selected tiles are already staged
      if (tiles.some(t => stagedTileIds.includes(t.id))) {
        alert("One or more selected tiles are already staged in another set!");
        return;
      }

      if (isValidOkeySet(tiles)) {
        setStagedSets(prev => [...prev, tiles]);
        setSelectedForSet([]);
      } else {
        alert("Invalid set! Must be a run (same color, consecutive numbers) or a group (same number, different colors).");
      }
    }
  };

  const handleOpenKonkan = () => {
    if (socket && me?.isKonkan && selectedForSet.length === 14 && roomCode) {
      const tiles = selectedForSet.map(id => {
        return me.handGrid.find(t => t?.id === id);
      }).filter(t => t !== null) as Tile[];
      
      socket.emit('openKonkan', { roomCode, tiles });
      setSelectedForSet([]);
    }
  };

  const handleOpenGame = () => {
    if (isMyTurn && gameState?.turnPhase === 'action' && me && roomCode) {
      if (me.isKonkan) {
        handleOpenKonkan();
        return;
      }
      const teammate = gameState.players.find(p => p.team === me.team && p.id !== me.id);
      const teammateHasOpened = teammate?.hasOpened || false;
      const minPoints = teammateHasOpened ? 61 : 81;

      if (stagedPoints >= minPoints || me.hasOpened) {
        if (me.pendingDiscardId) {
          const usedTileIds = stagedSets.flat().map(t => t.id);
          if (!usedTileIds.includes(me.pendingDiscardId)) {
            alert("You must use the picked discard tile in your sets to open!");
            return;
          }
        }
        socket?.emit('openMultipleSets', { roomCode, sets: stagedSets });
        setStagedSets([]);
      } else {
        alert(`You need at least ${minPoints} points to open! Current: ${stagedPoints}`);
      }
    }
  };

  const handleToggleTileSelection = (tileId: string) => {
    if (stagedTileIds.includes(tileId)) return;
    
    // Unified selection for mobile: tapping adds to set selection
    // If only one is selected, it also acts as the "selected tile" for discard/add
    if (window.innerWidth < 768) {
      setSelectedForSet(prev => {
        const isSelected = prev.includes(tileId);
        const next = isSelected ? prev.filter(id => id !== tileId) : [...prev, tileId];
        
        if (next.length === 1) {
          setSelectedTileId(next[0]);
        } else {
          setSelectedTileId(null);
        }
        return next;
      });
      return;
    }

    if (selectedTileId === tileId) {
      setSelectedTileId(null);
    } else {
      setSelectedTileId(tileId);
    }
  };

  const handleToggleForSet = (tileId: string) => {
    if (stagedTileIds.includes(tileId)) return;
    if (window.innerWidth < 768) return; // Mobile uses handleToggleTileSelection for both
    setSelectedForSet(prev => 
      prev.includes(tileId) ? prev.filter(id => id !== tileId) : [...prev, tileId]
    );
  };

  const handleOpenSet = () => {
    if (selectedForSet.length >= 3 && roomCode) {
      socket?.emit('openSet', { roomCode, selectedForSet });
      setSelectedForSet([]);
    }
  };

  const handleAddToSet = (setId: string) => {
    if (selectedTileId && gameState && me && roomCode) {
      if (!me.hasOpened) {
        const teammate = gameState.players.find(p => p.team === me.team && p.id !== me.id);
        const teammateHasOpened = teammate?.hasOpened || false;
        const minPoints = teammateHasOpened ? 61 : 81;
        alert(`You must open your own hand (${minPoints}+ points) before adding tiles to sets on the table!`);
        return;
      }
      const set = gameState.openSets.find(s => s.id === setId);
      const currentHand = me.handGrid.filter(t => t !== null) as Tile[];
      const tile = currentHand.find(t => t.id === selectedTileId);
      if (set && tile) {
        const newTiles = [...set.tiles, tile];
        if (isValidOkeySet(newTiles)) {
          socket?.emit('addToSet', { roomCode, setId, tileId: selectedTileId });
          setSelectedTileId(null);
        } else {
          alert("This tile cannot be added to this set!");
        }
      }
    }
  };

  const handleReplaceJoker = (setId: string, tileId: string, jokerId: string) => {
    if (roomCode) {
      socket?.emit('replaceJoker', { roomCode, setId, tileId, jokerId });
      setSelectedTileId(null);
    }
  };

  const handleDeclareWin = () => {
    if (roomCode) socket?.emit('declareWin', roomCode);
  };

  const handleReset = () => {
    if (roomCode) socket?.emit('resetGame', roomCode);
  };

  const handleRequestKharbat = () => {
    if (roomCode) socket?.emit('requestKharbat', roomCode);
  };

  const handleVoteKharbat = (agree: boolean) => {
    if (roomCode) socket?.emit('voteKharbat', { roomCode, agree });
  };

  if (view === 'login') {
    return (
      <div className="min-h-screen bg-neutral-900 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-neutral-800 border border-white/10 rounded-[32px] p-10 text-center shadow-2xl">
          <Layers className="text-emerald-500 w-16 h-16 mx-auto mb-6" />
          <h1 className="text-3xl font-display font-bold text-white mb-2">JANA GROUP OKEY</h1>
          <p className="text-neutral-400 mb-10">Sign in to start playing with your friends online.</p>
          
          <div className="space-y-4">
            {!isSocketConnected && (
              <div className="text-amber-500 text-xs font-bold animate-pulse mb-4">
                Connecting to server...
              </div>
            )}
            
            {user && isCheckingProfile ? (
              <div className="flex flex-col items-center gap-4">
                <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-white font-medium">Loading your profile...</p>
              </div>
            ) : (
              <button 
                onClick={handleGoogleSignIn}
                disabled={isLoggingIn || !isSocketConnected}
                className="w-full py-4 bg-white text-black rounded-2xl font-bold transition-all hover:bg-neutral-200 flex items-center justify-center gap-3 disabled:opacity-50 shadow-lg"
              >
                <LogIn size={20} />
                {isLoggingIn ? 'Signing in...' : 'Sign in with Google'}
              </button>
            )}

            {user && !isCheckingProfile && !isSocketConnected && (
              <p className="text-red-400 text-xs mt-4">
                Logged in as {user.email}, but server is not responding. 
                Please check your internet or refresh.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (view === 'profile') {
    return (
      <div className="min-h-screen bg-neutral-900 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-neutral-800 border border-white/10 rounded-[32px] p-10 text-center shadow-2xl">
          <User className="text-emerald-500 w-16 h-16 mx-auto mb-6" />
          <h1 className="text-3xl font-display font-bold text-white mb-2">Set Your Name</h1>
          <p className="text-neutral-400 mb-10">Choose a username. You won't be able to change it later!</p>
          
          <form onSubmit={handleSetUsername} className="space-y-6">
            <input 
              type="text" 
              placeholder="Enter your name" 
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white text-center text-xl focus:outline-none focus:border-emerald-500/50 transition-all"
              required
              minLength={3}
              maxLength={15}
            />
            <button 
              type="submit"
              className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-white rounded-2xl font-bold transition-all shadow-lg shadow-emerald-500/20"
            >
              Confirm Name
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!isJoined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-4">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <h1 className="text-5xl font-display font-bold text-white tracking-tighter mb-2">OKEY PRO</h1>
            <p className="text-neutral-500 uppercase tracking-widest text-xs font-black">Multiplayer Arena</p>
          </div>

          <div className="bg-neutral-900 border border-white/5 rounded-3xl p-8 shadow-2xl space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-widest ml-1">Your Name</label>
                <input
                  type="text"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="Enter name..."
                  className="w-full bg-black/40 border border-white/10 text-white rounded-2xl px-6 py-4 focus:border-emerald-500/50 outline-none transition-all"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-widest ml-1">Select Team</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setTeam(1)}
                    className={`py-3 rounded-xl font-bold transition-all border-2 ${
                      team === 1 ? 'bg-blue-500/20 border-blue-500 text-blue-400' : 'bg-neutral-800 border-transparent text-neutral-500'
                    }`}
                  >
                    Team 1
                  </button>
                  <button
                    onClick={() => setTeam(2)}
                    className={`py-3 rounded-xl font-bold transition-all border-2 ${
                      team === 2 ? 'bg-red-500/20 border-red-500 text-red-400' : 'bg-neutral-800 border-transparent text-neutral-500'
                    }`}
                  >
                    Team 2
                  </button>
                </div>
              </div>

              <div className="pt-4 space-y-3">
                <button 
                  onClick={handleCreateRoom}
                  className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-white rounded-2xl font-bold transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                >
                  <Plus size={20} /> Create New Room
                </button>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/5"></div></div>
                  <div className="relative flex justify-center text-xs uppercase"><span className="bg-neutral-900 px-2 text-neutral-600 font-bold">Or Join Existing</span></div>
                </div>

                <div className="space-y-3">
                  <input 
                    type="text" 
                    placeholder="6-Digit Code" 
                    value={inputRoomCode}
                    onChange={(e) => setInputRoomCode(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 text-white text-center text-xl font-mono tracking-[0.5em] focus:outline-none focus:border-emerald-500/50 transition-all"
                    maxLength={6}
                  />
                  <button 
                    onClick={handleJoinRoom}
                    className="w-full py-4 bg-white/5 hover:bg-white/10 text-white rounded-2xl font-bold transition-all border border-white/5"
                  >
                    Join Room
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-4 text-center">
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center gap-3 bg-white/5 px-4 py-2 rounded-2xl border border-white/10">
                  {user?.photoURL && (
                    <img 
                      src={user.photoURL} 
                      alt={playerName} 
                      className="w-6 h-6 rounded-full"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <span className="text-sm text-neutral-300 font-medium">Playing as {playerName}</span>
                </div>
                <button 
                  onClick={handleSignOut}
                  className="text-neutral-500 hover:text-red-400 text-xs transition-colors flex items-center justify-center gap-2 mx-auto"
                >
                  <LogOut size={14} /> Sign Out
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!gameState) return <div className="min-h-screen bg-neutral-900 flex items-center justify-center text-white">Connecting...</div>;

  if (gameState.status === 'lobby') {
    return (
      <div className="min-h-screen bg-neutral-900 p-6 flex flex-col">
        <div className="max-w-4xl mx-auto w-full flex-1 flex flex-col">
          <header className="flex justify-between items-center mb-12">
            <div className="flex flex-col">
              <div className="flex items-center gap-3">
                <Layers className="text-emerald-500 w-8 h-8" />
                <h2 className="text-2xl font-display font-bold text-white">Lobby</h2>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] text-neutral-500 font-black uppercase tracking-widest">Room Code:</span>
                <span className="text-xl font-mono font-bold text-emerald-500">{roomCode}</span>
              </div>
            </div>
            <div className="bg-neutral-800 px-4 py-2 rounded-full border border-white/5 flex items-center gap-2 text-neutral-300">
              <Users size={16} />
              <span>{gameState.players.length} / 4 Players</span>
            </div>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider">Players at Table</h3>
              <div className="space-y-3">
                {gameState.players.map((p) => (
                  <div
                    key={p.id}
                    className={`p-4 rounded-2xl border flex items-center justify-between ${
                      p.id === socket?.id 
                        ? 'bg-emerald-500/10 border-emerald-500/30' 
                        : 'bg-neutral-800 border-white/5'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        p.id === socket?.id ? 'bg-emerald-500' : 'bg-neutral-700'
                      }`}>
                        <User size={20} className="text-white" />
                      </div>
                      <div>
                        <p className="text-white font-medium">
                          {p.name} {p.id === socket?.id && '(You)'}
                          {p.disconnected && <span className="ml-2 text-red-500 text-xs font-bold uppercase tracking-tighter">(Disconnected)</span>}
                        </p>
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-neutral-500">{p.isHost ? 'Host' : 'Player'}</p>
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            p.team === 1 ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'
                          }`}>
                            Team {p.team}
                          </span>
                          {p.isKonkan && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">KONKAN</span>
                          )}
                        </div>
                      </div>
                    </div>
                    {p.ready && <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />}
                  </div>
                ))}
                {Array.from({ length: 4 - gameState.players.length }).map((_, i) => (
                  <div key={i} className="p-4 rounded-2xl border border-dashed border-white/10 flex items-center gap-3 opacity-50">
                    <div className="w-10 h-10 rounded-full bg-neutral-800 border border-white/5" />
                    <p className="text-neutral-600 italic">Waiting for player...</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-neutral-800 rounded-3xl p-8 border border-white/5 flex flex-col justify-center text-center">
              <Info className="text-emerald-500 w-12 h-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-xl font-display font-bold text-white mb-2">Ready to Start?</h3>
              <p className="text-neutral-400 mb-6">The game will begin once 4 players have joined the table.</p>
              
              {me?.isHost && (
                <div className="mb-8 space-y-4">
                  <p className="text-xs font-bold text-neutral-500 uppercase tracking-widest">Initial Team Scores (Optional)</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] text-blue-400 font-bold uppercase">Team 1</label>
                      <input 
                        type="number"
                        value={initialTeam1Score}
                        onChange={(e) => setInitialTeam1Score(parseInt(e.target.value) || 0)}
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-center focus:outline-none focus:border-blue-500/50"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-red-400 font-bold uppercase">Team 2</label>
                      <input 
                        type="number"
                        value={initialTeam2Score}
                        onChange={(e) => setInitialTeam2Score(parseInt(e.target.value) || 0)}
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-white text-center focus:outline-none focus:border-red-500/50"
                      />
                    </div>
                  </div>
                </div>
              )}
              
              {me?.isHost ? (
                <button
                  onClick={handleStart}
                  disabled={gameState.players.length < 1}
                  className={`w-full py-4 rounded-2xl font-bold transition-all flex items-center justify-center gap-2 ${
                    gameState.players.length >= 1
                      ? 'bg-emerald-500 hover:bg-emerald-400 text-white shadow-lg shadow-emerald-500/20'
                      : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
                  }`}
                >
                  <Play size={20} /> Start Game
                </button>
              ) : (
                <div className="p-4 bg-neutral-700/50 rounded-2xl text-neutral-400 italic">
                  Waiting for host to start...
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-neutral-950 flex flex-col overflow-hidden select-none">
      {/* Sidenav Scoreboard */}
      <AnimatePresence>
        {isScoreboardOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsScoreboardOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] lg:hidden"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed left-0 top-0 bottom-0 w-72 bg-neutral-900 border-r border-white/10 z-[70] p-6 flex flex-col gap-6 lg:hidden"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Trophy className="text-amber-500 w-6 h-6" />
                  <h3 className="text-lg font-display font-bold text-white uppercase tracking-widest">Scoreboard</h3>
                </div>
                <button 
                  onClick={() => setIsScoreboardOpen(false)}
                  className="p-2 hover:bg-white/5 rounded-full text-neutral-400"
                >
                  <X size={20} />
                </button>
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-2xl text-center">
                  <p className="text-[10px] text-blue-400 font-black uppercase tracking-tighter">Team 1</p>
                  <p className="text-2xl font-display font-bold text-white">
                    {gameState.roundScores.reduce((sum, r) => sum + r.team1, 0)}
                  </p>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-2xl text-center">
                  <p className="text-[10px] text-red-400 font-black uppercase tracking-tighter">Team 2</p>
                  <p className="text-2xl font-display font-bold text-white">
                    {gameState.roundScores.reduce((sum, r) => sum + r.team2, 0)}
                  </p>
                </div>
              </div>

              <div className="flex-1 flex flex-col gap-3 overflow-hidden">
                <p className="text-[10px] text-neutral-500 font-bold uppercase tracking-widest px-1">Round History</p>
                <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar pr-1">
                  {gameState.roundScores.length === 0 ? (
                    <p className="text-sm text-neutral-600 italic px-1">No rounds played yet</p>
                  ) : (
                    gameState.roundScores.map((round, i) => (
                      <div key={i} className="bg-white/5 border border-white/5 rounded-xl p-3 grid grid-cols-2 items-center text-center">
                        <div className="flex flex-col">
                          <span className="text-[10px] text-neutral-500 uppercase font-bold">Round {i+1}</span>
                          <span className={`text-sm font-bold ${round.team1 > 0 ? 'text-blue-400' : 'text-neutral-600'}`}>{round.team1}</span>
                        </div>
                        <div className="flex flex-col border-l border-white/5">
                          <span className="text-[10px] text-neutral-500 uppercase font-bold">Round {i+1}</span>
                          <span className={`text-sm font-bold ${round.team2 > 0 ? 'text-red-400' : 'text-neutral-600'}`}>{round.team2}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Top Bar */}
      <div className="h-14 md:h-10 bg-neutral-900 border-b border-white/5 flex items-center justify-between px-4 md:px-6 z-50 shrink-0">
        <div className="flex items-center gap-2 md:gap-4 overflow-x-auto no-scrollbar">
          <button 
            onClick={() => setIsScoreboardOpen(true)}
            className="lg:hidden p-2 hover:bg-white/5 rounded-lg text-neutral-400 mr-1"
          >
            <Menu size={20} />
          </button>
          <div className="flex flex-col shrink-0">
            <span className="text-[10px] text-neutral-500 font-black uppercase tracking-widest leading-none">Room</span>
            <span className="text-lg font-mono font-bold text-emerald-500 leading-none">{roomCode}</span>
          </div>
          <div className="h-12 w-px bg-white/5 mx-2 hidden md:block shrink-0" />
          <div className="flex items-center gap-2 shrink-0">
            <div className={`w-2 h-2 rounded-full ${isMyTurn ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-[10px] md:text-xs font-bold text-white uppercase tracking-widest whitespace-nowrap">
              {isMyTurn ? 'Your Turn' : `${currentTurnPlayerName}'s Turn`}
            </span>
          </div>
          <div className="h-4 w-px bg-white/10 shrink-0" />
          <div className="flex items-center gap-2 text-neutral-400 text-[10px] md:text-xs shrink-0">
            <Layers size={14} />
            <span className="whitespace-nowrap">{gameState.deck.length} Tiles</span>
          </div>
          <div className="hidden md:block h-4 w-px bg-white/10" />
          <div className="hidden md:flex items-center gap-2 text-neutral-400 text-xs">
            <Info size={14} />
            <span className="capitalize">Phase: {gameState.turnPhase}</span>
          </div>
        </div>

          <div className="flex items-center gap-2 md:gap-3 shrink-0">
            {gameState.status === 'finished' && (
              <div className="bg-emerald-500/20 text-emerald-400 px-2 md:px-3 py-1 rounded-full text-[10px] md:text-xs font-bold border border-emerald-500/30 flex items-center gap-1 md:gap-2">
                <Trophy size={12} className="md:w-3.5 md:h-3.5" /> <span className="hidden sm:inline">Winner:</span> {gameState.winner}
              </div>
            )}
            
            {gameState.status === 'playing' && (
              <button 
                onClick={handleRequestKharbat}
                disabled={gameState.turnCount >= gameState.players.length}
                className={`p-1.5 md:p-2 rounded-lg transition-colors flex items-center gap-1 ${
                  gameState.turnCount < gameState.players.length
                    ? 'text-amber-400 hover:bg-amber-500/10'
                    : 'text-neutral-600 cursor-not-allowed'
                }`}
                title="Kharbat (Re-deal)"
              >
                <RotateCcw size={16} className={`md:w-[18px] md:h-[18px] ${gameState.turnCount < gameState.players.length ? 'animate-spin-slow' : ''}`} />
                <span className="text-[10px] font-bold uppercase hidden sm:inline">Kharbat</span>
              </button>
            )}

            <button 
              onClick={handleExitRoom}
              className="p-1.5 md:p-2 hover:bg-red-500/20 rounded-lg text-red-400 transition-colors flex items-center gap-1"
              title="Exit Game"
            >
              <LogOut size={16} className="md:w-[18px] md:h-[18px]" />
              <span className="text-[10px] font-bold uppercase hidden sm:inline">Exit Game</span>
            </button>
          </div>
      </div>

      {/* Main Game Area */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Scoreboard Overlay */}
        <div className="absolute left-4 top-4 bottom-4 w-48 md:w-56 bg-black/40 backdrop-blur-md border border-white/10 rounded-2xl p-4 flex flex-col gap-4 z-20 hidden lg:flex">
          <div className="flex items-center gap-2 mb-2">
            <Trophy className="text-amber-500 w-5 h-5" />
            <h3 className="text-sm font-bold text-white uppercase tracking-widest">Scoreboard</h3>
          </div>
          
          <div className="grid grid-cols-2 gap-2 mb-4">
            <div className="bg-blue-500/10 border border-blue-500/20 p-3 rounded-xl text-center">
              <p className="text-[10px] text-blue-400 font-black uppercase tracking-tighter">Team 1</p>
              <p className="text-xl font-display font-bold text-white">
                {gameState.roundScores.reduce((sum, r) => sum + r.team1, 0)}
              </p>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 p-3 rounded-xl text-center">
              <p className="text-[10px] text-red-400 font-black uppercase tracking-tighter">Team 2</p>
              <p className="text-xl font-display font-bold text-white">
                {gameState.roundScores.reduce((sum, r) => sum + r.team2, 0)}
              </p>
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-2 overflow-hidden">
            <p className="text-[10px] text-neutral-500 font-bold uppercase tracking-widest px-1">Round History</p>
            <div className="flex-1 overflow-y-auto space-y-1.5 custom-scrollbar pr-1">
              {gameState.roundScores.length === 0 ? (
                <p className="text-xs text-neutral-600 italic px-1">No rounds played yet</p>
              ) : (
                gameState.roundScores.map((round, i) => (
                  <div key={i} className="bg-white/5 border border-white/5 rounded-lg p-2 grid grid-cols-2 items-center text-center">
                    <div className="flex flex-col">
                      <span className="text-[8px] text-neutral-500 uppercase font-bold">R{i+1}</span>
                      <span className={`text-xs font-bold ${round.team1 > 0 ? 'text-blue-400' : 'text-neutral-600'}`}>{round.team1}</span>
                    </div>
                    <div className="flex flex-col border-l border-white/5">
                      <span className="text-[8px] text-neutral-500 uppercase font-bold">R{i+1}</span>
                      <span className={`text-xs font-bold ${round.team2 > 0 ? 'text-red-400' : 'text-neutral-600'}`}>{round.team2}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 relative okey-table overflow-hidden flex flex-col">
          {/* Game Messages Toast Area */}
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none">
            {messages.map((msg, i) => (
              <div
                key={i}
                className="bg-amber-500 text-black px-6 py-3 rounded-2xl font-bold text-sm shadow-2xl flex items-center gap-3 border border-amber-400/50"
              >
                <Info size={18} />
                {msg}
              </div>
            ))}
          </div>

          {/* Konkan Button Overlay */}
          <div className="absolute top-15 right-4 z-30">
            {me && !me.hasOpened && !me.isKonkan && gameState.status === 'playing' && (
              <button
                onClick={() => {
                  if (confirm("Are you sure you want to enter KONKAN mode? You won't be able to open normally!")) {
                    socket?.emit('enterKonkan', roomCode);
                  }
                }}
                className="bg-amber-500 hover:bg-amber-600 text-black px-4 py-2 rounded-xl font-bold text-sm transition-all shadow-lg shadow-amber-500/20 flex items-center gap-2"
              >
                <Layers size={16} />
                ENTER KONKAN
              </button>
            )}
            {me?.isKonkan && (
              <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-2">
                <Layers size={16} />
                KONKAN MODE ACTIVE
              </div>
            )}
          </div>

          {/* Opponents */}
        <div className="w-full flex justify-center gap-2 md:gap-8 p-2 md:p-4 z-10 shrink-0">
          {opponents.map((opp) => {
            const isOpponentTurn = gameState.currentTurnPlayerId === opp.id;
            return (
              <div key={opp.id} className="flex flex-col items-center gap-1 md:gap-2 w-full max-w-[120px] md:max-w-[200px]">
                <div className={`bg-black/40 backdrop-blur-md border rounded-xl md:rounded-2xl px-2 md:px-4 py-1.5 md:py-2 flex items-center gap-2 md:gap-3 w-full transition-all duration-300 ${
                  isOpponentTurn 
                    ? 'border-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.3)] ring-1 ring-emerald-500/50 scale-105' 
                    : 'border-white/10'
                }`}>
                  <div className={`w-6 h-6 md:w-8 md:h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                    isOpponentTurn ? 'bg-emerald-500' : 'bg-neutral-700'
                  }`}>
                    <User size={12} className="text-white md:w-4 md:h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className={`text-[10px] md:text-sm font-medium leading-none truncate transition-colors ${
                      isOpponentTurn ? 'text-emerald-400' : 'text-white'
                    }`}>
                      {opp.name}
                      {opp.disconnected && <span className="ml-1 text-red-500 text-[8px] font-bold">OFFLINE</span>}
                      {gameState.firstOpenerId === opp.id && (
                        <span className="ml-1 text-[8px] font-bold text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20">
                          1ST
                        </span>
                      )}
                      {opp.isKonkan && (
                        <span className="ml-1 text-[8px] font-bold text-amber-400 bg-amber-500/10 px-1 py-0.5 rounded border border-amber-500/20">
                          KONKAN
                        </span>
                      )}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5 md:mt-1">
                      <span className={`text-[8px] font-bold px-1 rounded ${
                        opp.team === 1 ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'
                      }`}>
                        T{opp.team}
                      </span>
                      {opp.isKonkan && (
                        <span className="text-[8px] font-bold px-1 rounded bg-amber-500/20 text-amber-400">KONKAN</span>
                      )}
                      <p className="text-[8px] md:text-[10px] text-neutral-400 uppercase tracking-tighter">{opp.handGrid.filter(t => t !== null).length} Tiles</p>
                    </div>
                  </div>
                </div>
                
                {/* Opponent's Open Sets */}
                <div className="flex flex-col gap-2 w-full max-h-32 md:max-h-70 overflow-y-auto custom-scrollbar">
                  {opp.hasOpened && (
                    <div className="bg-white/5 p-2 rounded-xl border border-white/5">
                      <div className="flex items-center justify-between mb-2 px-1">
                        <span className="text-[8px] font-black text-neutral-500 uppercase tracking-widest">Open Sets</span>
                        <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                          Total: {opp.openingPoints || opp.meldPoints}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {gameState.openSets.filter(s => s.ownerId === opp.id).map(set => (
                          <div 
                            key={set.id}
                            onClick={() => {
                              if (!me?.hasOpened && !me?.isKonkan) {
                                setMessages(prev => [...prev, "You must be OPENSET or KONKAN to take a joker!"]);
                                setTimeout(() => setMessages(prev => prev.slice(1)), 3000);
                                return;
                              }
                              handleAddToSet(set.id);
                            }}
                            className={`flex gap-0.5 p-1 bg-white/5 rounded-lg border border-white/5 hover:bg-white/10 cursor-pointer transition-all ${
                              selectedTileId ? 'ring-1 ring-emerald-500/50' : ''
                            }`}
                          >
                            {set.tiles.map(t => (
                              <TileView 
                                key={t.id}
                                tile={t} 
                                size="xs" 
                                onClick={(e) => {
                                  if (t.isFakeJoker && selectedTileId) {
                                    e.stopPropagation();
                                    handleReplaceJoker(set.id, selectedTileId, t.id);
                                  }
                                }}
                                className={t.isFakeJoker && selectedTileId ? "relative group" : ""}
                              >
                                {t.isFakeJoker && selectedTileId && (
                                  <div className="absolute inset-0 bg-emerald-500/40 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                    <RotateCcw size={10} className="text-white" />
                                  </div>
                                )}
                              </TileView>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Center Table */}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-12 items-center">
            {/* Draw Deck */}
            <div className="flex flex-col items-center gap-2 md:gap-3 order-2 md:order-1">
              <span className="text-[8px] md:text-[10px] font-bold text-white/40 uppercase tracking-widest">Deck</span>
              <div className="relative flex flex-col items-center">
                <button 
                  onClick={handleDraw}
                  disabled={!isMyTurn || gameState.turnPhase !== 'draw' || (gameState.deck.length === 0 && gameState.discardPile.length <= 1)}
                  className={`relative group transition-transform active:scale-95 ${
                    isMyTurn && gameState.turnPhase === 'draw' ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                  }`}
                >
                  <div className="w-12 h-16 md:w-16 md:h-24 bg-neutral-200 rounded-lg shadow-xl border-b-4 border-neutral-400 flex items-center justify-center">
                    <div className="w-full h-full border-2 border-neutral-300/50 rounded-lg flex items-center justify-center">
                      <div className="w-8 h-12 md:w-10 md:h-16 border border-neutral-400/30 rounded-md bg-neutral-100/50" />
                    </div>
                  </div>
                  {isMyTurn && gameState.turnPhase === 'draw' && gameState.deck.length > 0 && (
                    <div className="absolute -inset-2 bg-emerald-500/20 rounded-xl blur-lg animate-pulse" />
                  )}
                  {/* Animation source for drawn tiles */}
                  {lastDrawnTileId && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-12 h-16 md:w-16 md:h-24 bg-neutral-200 rounded-lg opacity-0" />
                    </div>
                  )}
                </button>
                
                {gameState.deck.length === 0 && gameState.discardPile.length > 1 && (
                  <button
                    onClick={handleReshuffle}
                    className="absolute -bottom-10 bg-blue-500 hover:bg-blue-400 text-white px-3 py-1 rounded-full text-[10px] font-bold shadow-lg flex items-center gap-1 whitespace-nowrap z-20"
                  >
                    <RotateCcw size={12} /> Shuffle Discards
                  </button>
                )}
              </div>
            </div>

            {/* Discard Pile */}
            <div className="flex flex-col items-center gap-2 md:gap-3 order-1 md:order-2">
              <span className="text-[8px] md:text-[10px] font-bold text-white/40 uppercase tracking-widest">Discard</span>
              <div className="relative">
                {gameState.discardPile.length > 0 ? (
                  <div className="relative">
                    <AnimatePresence mode="popLayout">
                      <motion.button 
                        key={gameState.discardPile[gameState.discardPile.length - 1].id}
                        initial={{ y: -100, opacity: 0, rotate: -10 }}
                        animate={{ y: 0, opacity: 1, rotate: 0 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                        transition={{ type: "spring", damping: 15, stiffness: 200 }}
                        onClick={handleTakeDiscard}
                        disabled={!isMyTurn || gameState.turnPhase !== 'draw'}
                        className={`transition-transform active:scale-95 ${
                          isMyTurn && gameState.turnPhase === 'draw' ? 'cursor-pointer hover:scale-105' : 'cursor-default'
                        }`}
                      >
                        <TileView 
                          tile={gameState.discardPile[gameState.discardPile.length - 1]} 
                          size={window.innerWidth < 768 ? 'sm' : 'md'} 
                        />
                        {isMyTurn && gameState.turnPhase === 'draw' && (
                          <div className="absolute -inset-2 bg-blue-500/20 rounded-xl blur-lg animate-pulse -z-10" />
                        )}
                      </motion.button>
                    </AnimatePresence>
                  </div>
                ) : (
                  <div 
                    key="empty-discard"
                    className="w-12 h-16 md:w-16 md:h-24 rounded-lg border-2 border-dashed border-white/10 flex items-center justify-center"
                  >
                    <ArrowUpRight className="text-white/10" size={24} />
                  </div>
                )}
              </div>
              {isMyTurn && gameState.turnPhase === 'draw' && !me?.hasOpened && !me?.isKonkan && (
                <p className="text-[8px] text-amber-500/60 font-bold uppercase tracking-tighter text-center max-w-[100px]">
                  
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* Bottom Player Area */}
      <div className="bg-neutral-900 border-t border-white/10 p-3 md:p-6 pb-6 md:pb-10 z-50 shrink-0">
        <div className="max-w-6xl mx-auto flex flex-col gap-3 md:gap-6">
          {/* Hand Controls */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-3 md:gap-6">
            <div className="flex flex-col gap-2 md:gap-4 flex-1 w-full">
              <div className="flex items-center gap-2 md:gap-4">
                <div className="flex items-center gap-2">
                  <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded ${
                    me?.team === 1 ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'
                  }`}>
                    Team {me?.team}
                  </span>
                  {me?.isKonkan && (
                    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                      KONKAN
                    </span>
                  )}
                  {gameState.firstOpenerId === me?.id && (
                    <span className="text-[8px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                      1ST OPENER
                    </span>
                  )}
                  {isMyTurn && (
                    <span className="text-[8px] font-bold text-emerald-400 bg-emerald-500/20 px-1.5 py-0.5 rounded border border-emerald-500/30 animate-pulse">
                      YOUR TURN
                    </span>
                  )}
                </div>
                {me?.handGrid.filter(t => t !== null).length === 15 && (
                  <div 
                    className="bg-amber-500/20 text-amber-500 px-2 md:px-3 py-1 rounded-full text-[8px] md:text-[10px] font-bold border border-amber-500/30 flex items-center gap-1 md:gap-2"
                  >
                    <Info size={12} /> <span className="hidden sm:inline">Must Discard</span><span className="sm:hidden">Discard!</span>
                  </div>
                )}
              </div>

              {/* My Open Sets */}
              <div className="flex flex-col gap-2 flex-1">
                {me?.hasOpened && (
                  <div className="bg-white/5 p-2 md:p-3 rounded-xl md:rounded-2xl border border-white/5">
                    <div className="flex items-center justify-between mb-2 px-1">
                      <span className="text-[10px] font-black text-neutral-500 uppercase tracking-widest">My Open Sets</span>
                      <span className="text-xs md:text-sm font-bold text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20">
                        Total Value: {me.openingPoints || me.meldPoints}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 md:gap-3 max-h-24 md:max-h-none overflow-y-auto">
                      {gameState.openSets.filter(s => s.ownerId === me?.id).map(set => (
                        <div 
                          key={set.id}
                          onClick={() => handleAddToSet(set.id)}
                          className={`flex gap-0.5 md:gap-1 p-1 md:p-1.5 bg-white/5 rounded-lg md:rounded-xl border border-white/5 hover:bg-white/10 cursor-pointer transition-all ${
                            selectedTileId ? 'ring-2 ring-emerald-500/50' : ''
                          }`}
                        >
                          {set.tiles.map(t => (
                            <TileView 
                              key={t.id}
                              tile={t} 
                              size="xs" 
                              onClick={(e) => {
                                if (t.isFakeJoker && selectedTileId) {
                                  e.stopPropagation();
                                  handleReplaceJoker(set.id, selectedTileId, t.id);
                                }
                              }}
                              className={t.isFakeJoker && selectedTileId ? "relative group" : ""}
                            >
                              {t.isFakeJoker && selectedTileId && (
                                <div className="absolute inset-0 bg-emerald-500/40 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                  <RotateCcw size={12} className="text-white" />
                                </div>
                              )}
                            </TileView>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 w-full md:w-auto justify-end">
              {stagedSets.length > 0 && (
                <div className="flex items-center gap-2 md:gap-3">
                  <div className="bg-blue-500/20 border border-blue-500/30 px-3 md:px-4 py-1.5 md:py-2 rounded-xl md:rounded-2xl flex flex-col items-center">
                    <p className="text-[7px] md:text-[8px] text-blue-400 font-black uppercase tracking-widest">Points</p>
                    <p className="text-white font-display font-bold text-sm md:text-lg">{stagedPoints}</p>
                  </div>
                  <button 
                    onClick={handleOpenGame}
                    className="bg-blue-600 hover:bg-blue-500 text-white px-4 md:px-6 py-2 rounded-lg md:rounded-xl font-bold text-xs md:text-sm transition-all shadow-lg shadow-blue-600/20 flex items-center gap-1 md:gap-2"
                  >
                    <Layers size={14} className="md:w-4 md:h-4" /> Open <span className="hidden sm:inline">({gameState.players.find(p => p.team === me?.team && p.id !== me?.id)?.hasOpened ? '61+' : '81+'})</span>
                  </button>
                  <button 
                    onClick={() => { setStagedSets([]); }}
                    className="bg-neutral-800 hover:bg-neutral-700 text-white px-3 md:px-4 py-2 rounded-lg md:rounded-xl font-bold text-xs md:text-sm transition-all border border-white/5"
                  >
                    Clear
                  </button>
                </div>
              )}

              {me?.pendingDiscardId && (
                <button 
                  onClick={handleUndoTakeDiscard}
                  className="bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 border border-orange-500/30 px-3 md:px-4 py-2 rounded-lg md:rounded-xl font-bold text-xs md:text-sm transition-all flex items-center gap-1 md:gap-2"
                >
                  <RotateCcw size={14} className="md:w-4 md:h-4" /> <span className="hidden sm:inline">Put Back Discard</span><span className="sm:hidden">Undo</span>
                </button>
              )}

              {selectedForSet.length >= 3 && !me?.isKonkan && (
                <button 
                  onClick={handleStageSet}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 md:px-6 py-2 rounded-lg md:rounded-xl font-bold text-xs md:text-sm transition-all shadow-lg shadow-indigo-600/20 flex items-center gap-1 md:gap-2"
                >
                  <Hand size={14} className="md:w-4 md:h-4" /> Stage
                </button>
              )}

              {me?.isKonkan && selectedForSet.length === 14 && (
                <button 
                  onClick={handleOpenKonkan}
                  className="bg-amber-500 hover:bg-amber-400 text-black px-4 md:px-6 py-2 rounded-lg md:rounded-xl font-bold text-xs md:text-sm transition-all shadow-lg shadow-amber-500/20 flex items-center gap-1 md:gap-2 animate-pulse"
                >
                  <Layers size={14} className="md:w-4 md:h-4" /> Open Konkan
                </button>
              )}
              
              <button 
                onClick={handleDiscard}
                disabled={!selectedTileId || !isMyTurn || gameState.turnPhase !== 'action'}
                className={`px-4 md:px-6 py-2 rounded-lg md:rounded-xl font-bold text-xs md:text-sm transition-all flex items-center gap-1 md:gap-2 ${
                  selectedTileId && isMyTurn && gameState.turnPhase === 'action'
                    ? 'bg-red-500 hover:bg-red-400 text-white shadow-lg shadow-red-500/20'
                    : 'bg-neutral-800 text-neutral-600 cursor-not-allowed border border-white/5'
                }`}
              >
                <ArrowUpRight size={14} className="md:w-4 md:h-4" /> Discard
              </button>

              {me?.handGrid.filter(t => t !== null).length === 0 && gameState.status === 'playing' && (
                <button 
                  onClick={handleDeclareWin}
                  className="bg-emerald-500 hover:bg-emerald-400 text-white px-6 md:px-8 py-2 rounded-lg md:rounded-xl font-bold text-xs md:text-sm transition-all shadow-lg shadow-emerald-500/20 flex items-center gap-1 md:gap-2 animate-bounce"
                >
                  <Trophy size={14} className="md:w-4 md:h-4" /> Win!
                </button>
              )}
            </div>
          </div>

          <div 
            className="grid grid-rows-2 gap-1 md:gap-2 p-2 md:p-4 bg-black/20 rounded-2xl md:rounded-3xl border border-white/5 overflow-x-auto no-scrollbar min-h-[160px] md:min-h-[260px]"
            style={{ gridTemplateColumns: 'repeat(15, minmax(var(--tile-width), 1fr))' }}
          >
            {me?.handGrid.map((tile, index) => (
              <div
                key={index}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const fromIndex = parseInt(e.dataTransfer.getData('fromIndex'));
                  handleMoveTile(fromIndex, index);
                }}
                onClick={() => {
                  if (movingTileIndex !== null && !tile) {
                    handleMoveTile(movingTileIndex, index);
                    setMovingTileIndex(null);
                  }
                }}
                className={`tile-slot rounded-md md:rounded-lg border border-dashed border-white/5 flex items-center justify-center transition-all bg-white/5 hover:bg-white/10 ${
                  movingTileIndex !== null && !tile ? 'bg-emerald-500/10 border-emerald-500/30 cursor-pointer ring-2 ring-emerald-500/20' : ''
                }`}
              >
                {tile && (
                  <TileView
                    tile={tile}
                    size={window.innerWidth < 768 ? 'sm' : 'md'}
                    selected={selectedTileId === tile.id}
                    initial={lastDrawnTileId === tile.id ? { y: 100, opacity: 0, scale: 0.5 } : { scale: 0.8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1, scale: 1 }}
                    transition={lastDrawnTileId === tile.id ? { type: "spring", damping: 12, stiffness: 150 } : {}}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (movingTileIndex !== null) {
                        setMovingTileIndex(null);
                        return;
                      }
                      const now = Date.now();
                      if (now - lastTapTime < 300) {
                        // Double tap
                        handleToggleForSet(tile.id);
                        setLastTapTime(0);
                      } else {
                        handleToggleTileSelection(tile.id);
                        setLastTapTime(now);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      handleToggleForSet(tile.id);
                    }}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('fromIndex', index.toString());
                    }}
                    className={`cursor-pointer transition-all duration-200 touch-none ${
                      selectedForSet.includes(tile.id) ? 'ring-2 md:ring-4 ring-blue-500' : ''
                    } ${stagedTileIds.includes(tile.id) ? 'opacity-40 grayscale' : ''}`}
                  >
                    {selectedForSet.includes(tile.id) && (
                      <div className="absolute -top-1 -right-1 md:-top-2 md:-right-2 bg-blue-500 text-white rounded-full p-0.5 md:p-1 shadow-lg z-10">
                        <Layers size={8} className="md:w-2.5 md:h-2.5" />
                      </div>
                    )}
                    {stagedTileIds.includes(tile.id) && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20 rounded-md md:rounded-lg z-10">
                        <Layers size={16} className="text-white/50 md:w-6 md:h-6" />
                      </div>
                    )}
                  </TileView>
                )}
              </div>
            ))}
          </div>
          <p className="text-center text-[8px] text-neutral-500 font-medium uppercase tracking-widest sm:hidden">
            Drag to Move • Tap to Select • Select 1 to Discard • Select 3+ to Stage
          </p>
        </div>
      </div>

      {/* Kharbat Voting Modal */}
      {gameState.kharbatVote && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-800 border border-white/10 p-6 rounded-3xl max-w-sm w-full shadow-2xl text-center">
            <RotateCcw className="text-amber-500 w-12 h-12 mx-auto mb-4 animate-spin-slow" />
            <h3 className="text-xl font-display font-bold text-white mb-2">Kharbat Request</h3>
            <p className="text-neutral-400 mb-6">
              {gameState.players.find(p => p.id === gameState.kharbatVote?.requesterId)?.name} wants to re-deal the hand. Do you agree?
            </p>
            
            {gameState.kharbatVote.votes[socket?.id] !== undefined ? (
              <div className="text-emerald-400 font-bold animate-pulse">
                Waiting for others... ({Object.keys(gameState.kharbatVote.votes).length} / {gameState.players.filter(p => !p.disconnected).length})
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => handleVoteKharbat(true)}
                  className="bg-emerald-500 hover:bg-emerald-400 text-white font-bold py-3 rounded-xl transition-all"
                >
                  Agree
                </button>
                <button
                  onClick={() => handleVoteKharbat(false)}
                  className="bg-red-500 hover:bg-red-400 text-white font-bold py-3 rounded-xl transition-all"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Win Overlay */}
      {gameState.status === 'finished' && (
        <div 
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-xl flex items-center justify-center p-4 md:p-6 overflow-y-auto"
        >
          <div 
            className="bg-neutral-900 border border-white/10 p-6 md:p-10 rounded-[32px] md:rounded-[40px] text-center max-w-4xl w-full shadow-2xl relative my-8"
          >
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 via-blue-500 to-emerald-500" />
            
            <div className="flex flex-col items-center mb-8">
              <div className="w-16 h-16 md:w-20 md:h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mb-4 border border-emerald-500/30">
                <Trophy className="text-emerald-500 w-8 h-8 md:w-10 md:h-10" />
              </div>
              <h2 className="text-3xl md:text-4xl font-display font-bold text-white mb-2">Victory!</h2>
              <p className="text-lg md:text-xl text-neutral-400">
                <span className="text-emerald-400 font-bold">{gameState.winner}</span> has won the game!
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 mb-10 text-left">
              {gameState.players.map(p => {
                const penalty = calculateHandPenalty(p.handGrid);
                const remainingTiles = p.handGrid.filter(t => t !== null);
                
                return (
                  <div key={p.id} className="bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-col gap-3">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                          p.team === 1 ? 'bg-blue-500' : 'bg-red-500'
                        }`}>
                          <User size={16} className="text-white" />
                        </div>
                        <div>
                          <p className="text-white font-bold text-sm md:text-base">
                            {p.name} {p.name === gameState.winner && '🏆'}
                          </p>
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            p.team === 1 ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'
                          }`}>
                            Team {p.team}
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-neutral-500 uppercase font-black tracking-widest">Penalty Points</p>
                        <p className={`text-xl font-display font-bold ${penalty === 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          +{penalty}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5 p-2 bg-black/20 rounded-xl min-h-[40px]">
                      {remainingTiles.length > 0 ? (
                        remainingTiles.map(t => (
                          <TileView key={t!.id} tile={t!} size="xs" />
                        ))
                      ) : (
                        <span className="text-xs text-neutral-600 italic flex items-center gap-2">
                          <Layers size={12} /> All tiles used in sets
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <button 
              onClick={handleReset}
              className="w-full bg-emerald-500 hover:bg-emerald-400 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
            >
              <RotateCcw size={20} /> Play Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TileViewProps {
  tile: Tile;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  selected?: boolean;
  children?: React.ReactNode;
  [key: string]: any;
}

function TileView({ tile, size = 'md', selected = false, className, children, ...props }: TileViewProps) {
  const sizeClasses = {
    xs: 'w-6 h-9 text-[10px]',
    sm: 'w-10 h-14 text-sm',
    md: 'w-16 h-24 text-2xl',
    lg: 'w-20 h-28 text-3xl',
  };

  const colorClasses = {
    red: 'text-red-500',
    black: 'text-neutral-900',
    blue: 'text-blue-500',
    yellow: 'text-amber-500',
    none: 'text-neutral-400',
  };

  return (
    <motion.div 
      layout
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ 
        scale: 1, 
        opacity: 1,
        y: selected ? -12 : 0
      }}
      exit={{ scale: 0.8, opacity: 0 }}
      className={`${sizeClasses[size]} bg-neutral-100 rounded-lg tile-shadow flex flex-col items-center justify-center relative border shrink-0 transition-colors duration-200 ${
        selected ? 'border-red-600 border-[3px] ring-4 ring-red-600/40' : 'border-neutral-300'
      } ${className || ''}`}
      {...props}
    >
      <div className="absolute inset-1 border border-neutral-200 rounded-md pointer-events-none" />
      {tile.isFakeJoker ? (
        <div className="flex flex-col items-center">
          <Layers size={size === 'lg' ? 32 : size === 'md' ? 24 : 12} className="text-neutral-400" />
          <span className="text-[8px] font-black uppercase tracking-tighter mt-1 text-neutral-400">Joker</span>
        </div>
      ) : (
        <span className={`font-display font-black ${colorClasses[tile.color]}`}>
          {tile.value}
        </span>
      )}
      {/* Decorative dot */}
      {!tile.isFakeJoker && (
        <div className={`w-1.5 h-1.5 rounded-full mt-1 ${
          tile.color === 'red' ? 'bg-red-500/20' : 
          tile.color === 'black' ? 'bg-black/10' : 
          tile.color === 'blue' ? 'bg-blue-500/20' : 
          'bg-amber-500/20'
        }`} />
      )}
      {children}
    </motion.div>
  );
}
