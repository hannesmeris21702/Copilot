/**
 * Persistence – stores the last known position state and last action time
 * in a local JSON file so the bot can resume safely after restarts.
 */

import * as fs from "fs";
import * as path from "path";
import { getLogger } from "./logger";

export interface BotState {
  lastRebalanceTime?: number;   // Unix timestamp ms
  lastPositionId?: string;
  lastTickLower?: number;
  lastTickUpper?: number;
  lastLiquidity?: string;       // bigint as string
  totalRebalances: number;
  lastTxDigest?: string;
}

const DEFAULT_STATE: BotState = { totalRebalances: 0 };

export function loadState(statePath: string): BotState {
  try {
    if (!fs.existsSync(statePath)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(statePath, "utf8");
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<BotState>) };
  } catch (err) {
    getLogger().warn({ err, statePath }, "Failed to read state file – using default");
    return { ...DEFAULT_STATE };
  }
}

export function saveState(statePath: string, state: BotState): void {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function updateStateAfterRebalance(
  state: BotState,
  positionId: string,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
  txDigest: string
): BotState {
  return {
    ...state,
    lastRebalanceTime: Date.now(),
    lastPositionId: positionId,
    lastTickLower: tickLower,
    lastTickUpper: tickUpper,
    lastLiquidity: liquidity.toString(),
    totalRebalances: state.totalRebalances + 1,
    lastTxDigest: txDigest,
  };
}
