
export type Color = 'red' | 'black' | 'blue' | 'yellow' | 'none';

export interface Tile {
  id: string;
  color: Color;
  value: number; // 1-13, or 0 for fake joker
  isFakeJoker?: boolean;
}

export interface Player {
  id: string;
  uid: string;
  name: string;
  team?: 1 | 2;
  handGrid: (Tile | null)[]; // 30 slots (2 rows of 15)
  isHost: boolean;
  ready: boolean;
  hasOpened: boolean;
  openingPoints?: number;
  meldPoints: number;
  pendingDiscardId?: string | null;
  hasPickedJokerThisTurn?: boolean;
  disconnected?: boolean;
  isKonkan?: boolean;
}

export interface OpenSet {
  id: string;
  tiles: Tile[];
  ownerId: string;
}

export type GameStatus = 'lobby' | 'playing' | 'finished';

export type TurnPhase = 'draw' | 'action' | 'discard';

export interface RoundScore {
  team1: number;
  team2: number;
}

export interface KharbatVote {
  requesterId: string;
  votes: Record<string, boolean>; // playerId -> true/false
}

export interface GameState {
  status: GameStatus;
  players: Player[];
  deck: Tile[];
  discardPile: Tile[];
  openSets: OpenSet[];
  winner: string | null;
  currentTurnPlayerId: string | null;
  turnPhase: TurnPhase;
  roundScores: RoundScore[];
  highestOpeningScore: { 1: number; 2: number };
  firstOpenerId: string | null;
  turnCount: number;
  kharbatVote: KharbatVote | null;
}
