import { Tile, Color } from './types';

export function isWild(tile: Tile): boolean {
  return !!tile.isFakeJoker;
}

export function isValidOkeySet(tiles: Tile[]): boolean {
  if (tiles.length < 3) return false;

  // Check for Group (Same number, different colors)
  const checkGroup = () => {
    const nonWilds = tiles.filter(t => !isWild(t));
    if (nonWilds.length === 0) return true;

    const value = nonWilds[0].value;
    const colors = new Set();

    for (const t of tiles) {
      if (isWild(t)) continue;
      if (t.value !== value) return false;
      if (colors.has(t.color)) return false;
      colors.add(t.color);
    }
    return colors.size <= 4;
  };

  // Check for Run (Same color, consecutive numbers, 13-1 wrap allowed)
  const checkRun = () => {
    const nonWilds = tiles.filter(t => !isWild(t));
    if (nonWilds.length === 0) return true;

    const color = nonWilds[0].color;
    for (const t of tiles) {
      if (isWild(t)) continue;
      if (t.color !== color) return false;
    }

    const N = tiles.length;
    
    // Try all possible start values S from 1 to 13
    for (let S = 1; S <= 13; S++) {
      const sequence = [];
      for (let i = 0; i < N; i++) {
        let val = S + i;
        if (val > 13) {
          if (val === 14) val = 1;
          else break; 
        }
        sequence.push(val);
      }
      
      if (sequence.length < N) continue;

      // Check if this sequence contains all non-wild values
      const seqSet = new Set(sequence);
      const containsAll = nonWilds.every(t => seqSet.has(t.value));
      
      if (containsAll) {
        // Also check for duplicates in non-wilds (Okey runs don't have duplicates)
        const nonWildValues = nonWilds.map(t => t.value);
        const uniqueNonWildValues = new Set(nonWildValues);
        if (uniqueNonWildValues.size === nonWildValues.length) {
          return true;
        }
      }
    }
    return false;
  };

  return checkGroup() || checkRun();
}

export function getJokerReplacement(tiles: Tile[], jokerId: string): { value: number, color: Color }[] {
  const jokerIndex = tiles.findIndex(t => t.id === jokerId);
  if (jokerIndex === -1 || !isWild(tiles[jokerIndex])) return [];

  const results: { value: number, color: Color }[] = [];

  // Check if it's a Group
  const nonWilds = tiles.filter(t => !isWild(t));
  if (nonWilds.length > 0) {
    const isGroup = nonWilds.every(t => t.value === nonWilds[0].value) && 
                    new Set(nonWilds.map(t => t.color)).size === nonWilds.length;
    
    if (isGroup) {
      const value = nonWilds[0].value;
      const existingColors = new Set(nonWilds.map(t => t.color));
      const allColors: Color[] = ['red', 'black', 'blue', 'yellow'];
      allColors.forEach(c => {
        if (!existingColors.has(c)) {
          results.push({ value, color: c });
        }
      });
      return results;
    }

    // Check if it's a Run
    const color = nonWilds[0].color;
    const isRun = nonWilds.every(t => t.color === color);
    if (isRun) {
      const N = tiles.length;
      for (let S = 1; S <= 13; S++) {
        const sequence = [];
        for (let i = 0; i < N; i++) {
          let val = S + i;
          if (val > 13) {
            if (val === 14) val = 1;
            else break;
          }
          sequence.push(val);
        }
        if (sequence.length < N) continue;

        const seqSet = new Set(sequence);
        const containsAll = nonWilds.every(t => seqSet.has(t.value));
        if (containsAll) {
          results.push({ value: sequence[jokerIndex], color });
        }
      }
    }
  }

  return results;
}

export function calculateSetPoints(tiles: Tile[]): number {
  if (!isValidOkeySet(tiles)) return 0;

  const nonWilds = tiles.filter(t => !isWild(t));
  if (nonWilds.length === 0) return 0;

  const getPointValue = (val: number) => {
    if (val === 1 || val === 11 || val === 12 || val === 13) return 10;
    return val;
  };

  // Check if it's a group
  const isGroup = () => {
    const val = nonWilds[0].value;
    return nonWilds.every(t => t.value === val);
  };

  if (isGroup()) {
    // In a group, all tiles (including wildcards) have the same value
    return getPointValue(nonWilds[0].value) * tiles.length;
  } else {
    // It's a run.
    // We need to find the values of the wildcards.
    // Try all possible starting positions for a sequence of length N that contains all non-wilds.
    let bestSum = 0;
    const N = tiles.length;
    
    // Try all possible start values S from 1 to 13
    for (let S = 1; S <= 13; S++) {
      const sequence = [];
      for (let i = 0; i < N; i++) {
        let val = S + i;
        if (val > 13) {
          // Wrap around only allowed if it's 13 -> 1
          if (val === 14) val = 1;
          else break; // Cannot continue after 1
        }
        sequence.push(val);
      }
      
      if (sequence.length < N) continue;

      // Does this sequence contain all non-wild values?
      const seqSet = new Set(sequence);
      const containsAll = nonWilds.every(t => seqSet.has(t.value));
      
      if (containsAll) {
        const currentSum = sequence.reduce((sum, val) => sum + getPointValue(val), 0);
        if (currentSum > bestSum) bestSum = currentSum;
      }
    }
    return bestSum;
  }
}

export function calculateHandPenalty(tiles: (Tile | null)[]): number {
  const getPointValue = (val: number) => {
    if (val === 1 || val === 11 || val === 12 || val === 13) return 10;
    return val;
  };

  return tiles.reduce((sum, tile) => {
    if (!tile) return sum;
    if (tile.isFakeJoker) return sum + 20;
    return sum + getPointValue(tile.value);
  }, 0);
}

export function isValidKonkan(tiles: Tile[], tilesOnTable: number = 0): boolean {
  const totalTilesInHand = tiles.length;
  if (totalTilesInHand + tilesOnTable !== 14) return false;

  // Helper to check if a subset of tiles is a valid Okey set
  // and if it's a run, it must be of a specific color (if provided)
  const isSpecificRunOrSet = (ts: Tile[], mustBeSameColor: boolean) => {
    if (!isValidOkeySet(ts)) return false;
    if (mustBeSameColor) {
      const nonWilds = ts.filter(t => !isWild(t));
      if (nonWilds.length === 0) return true;
      const color = nonWilds[0].color;
      if (ts.some(t => !isWild(t) && t.color !== color)) return false;
      
      // Also ensure it's a run, not a group (groups have different colors)
      const isGroup = nonWilds.every(t => t.value === nonWilds[0].value);
      if (isGroup && nonWilds.length > 1) return false; 
    }
    return true;
  };

  // Case 1: All tiles in hand form a single long run (length >= 10)
  if (isSpecificRunOrSet(tiles, true)) return true;

  // Case 2: Hand contains a 10-run and a second valid set (length >= 3)
  // This is only possible if hand has at least 13 tiles.
  if (totalTilesInHand >= 13) {
    // Try all possible sizes for the second set (from 3 up to totalTilesInHand - 10)
    for (let secondSetSize = 3; secondSetSize <= totalTilesInHand - 10; secondSetSize++) {
      const getSubsets = (arr: Tile[], k: number): number[][] => {
        const results: number[][] = [];
        const helper = (start: number, current: number[]) => {
          if (current.length === k) {
            results.push([...current]);
            return;
          }
          for (let i = start; i < arr.length; i++) {
            current.push(i);
            helper(i + 1, current);
            current.pop();
          }
        };
        helper(0, []);
        return results;
      };

      const indices = getSubsets(tiles, secondSetSize);
      for (const secondSetIndices of indices) {
        const secondSet = secondSetIndices.map(i => tiles[i]);
        const firstSet = tiles.filter((_, i) => !secondSetIndices.includes(i));
        
        // First set must be a same-color run of at least 10 tiles
        if (firstSet.length >= 10 && isSpecificRunOrSet(firstSet, true) && isValidOkeySet(secondSet)) {
          return true;
        }
      }
    }
  }

  return false;
}
