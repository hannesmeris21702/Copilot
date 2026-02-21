import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import * as dotenv from "dotenv";

dotenv.config();

export interface BotConfig {
  // RPC / wallet
  suiRpcUrl: string;
  keystorePath?: string;
  mnemonic?: string;
  walletAddress: string;

  // Pool / position
  poolId: string;
  positionId?: string;
  tokenAType: string;
  tokenBType: string;

  // Cetus package IDs
  cetusPackageIds?: Record<string, string>;

  // Strategy
  rebalanceMode: "price_band" | "drift";
  priceBandPct: number;   // e.g. 1.5 means ±1.5%
  driftTriggerPct: number; // trigger rebalance if price drifts more than X% from center
  minIntervalSeconds: number;
  slippageBps: number;    // e.g. 50 = 0.5%

  // Safety
  gasBudget: bigint;
  maxRetries: number;
  dryRun: boolean;
  confirm: boolean;

  // Observability
  telegramWebhook?: string;
  logLevel: string;
}

function loadYamlConfig(configPath: string): Partial<BotConfig> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw) as Record<string, unknown>;
  return parsed as Partial<BotConfig>;
}

export function loadConfig(configFilePath?: string): BotConfig {
  const yamlPath =
    configFilePath ||
    process.env.CONFIG_FILE ||
    path.resolve(process.cwd(), "config", "config.yaml");

  const file = loadYamlConfig(yamlPath);

  const dryRun =
    process.env.DRY_RUN === "true" ||
    (file.dryRun as boolean | undefined) === true ||
    true; // default safe

  const confirm =
    process.env.CONFIRM === "true" ||
    (file.confirm as boolean | undefined) === true ||
    false;

  return {
    suiRpcUrl:
      process.env.SUI_RPC_URL ||
      (file.suiRpcUrl as string | undefined) ||
      "https://fullnode.mainnet.sui.io:443",

    keystorePath:
      process.env.KEYSTORE_PATH || (file.keystorePath as string | undefined),
    mnemonic:
      process.env.MNEMONIC || (file.mnemonic as string | undefined),
    walletAddress:
      process.env.WALLET_ADDRESS ||
      (file.walletAddress as string | undefined) ||
      "",

    poolId:
      process.env.POOL_ID ||
      (file.poolId as string | undefined) ||
      "",
    positionId:
      process.env.POSITION_ID || (file.positionId as string | undefined),
    tokenAType:
      process.env.TOKEN_A_TYPE ||
      (file.tokenAType as string | undefined) ||
      "",
    tokenBType:
      process.env.TOKEN_B_TYPE ||
      (file.tokenBType as string | undefined) ||
      "",

    cetusPackageIds:
      (file.cetusPackageIds as Record<string, string> | undefined) ||
      undefined,

    rebalanceMode:
      (process.env.REBALANCE_MODE as BotConfig["rebalanceMode"]) ||
      (file.rebalanceMode as BotConfig["rebalanceMode"] | undefined) ||
      "price_band",

    priceBandPct:
      parseFloat(process.env.PRICE_BAND_PCT || "") ||
      (file.priceBandPct as number | undefined) ||
      1.5,

    driftTriggerPct:
      parseFloat(process.env.DRIFT_TRIGGER_PCT || "") ||
      (file.driftTriggerPct as number | undefined) ||
      0.5,

    minIntervalSeconds:
      parseInt(process.env.MIN_INTERVAL_SECONDS || "") ||
      (file.minIntervalSeconds as number | undefined) ||
      60,

    slippageBps:
      parseInt(process.env.SLIPPAGE_BPS || "") ||
      (file.slippageBps as number | undefined) ||
      50,

    gasBudget: BigInt(
      process.env.GAS_BUDGET ||
      String((file.gasBudget as number | undefined) || 500_000_000)
    ),

    maxRetries:
      parseInt(process.env.MAX_RETRIES || "") ||
      (file.maxRetries as number | undefined) ||
      3,

    dryRun,
    confirm,

    telegramWebhook:
      process.env.TELEGRAM_WEBHOOK ||
      (file.telegramWebhook as string | undefined),

    logLevel:
      process.env.LOG_LEVEL ||
      (file.logLevel as string | undefined) ||
      "info",
  };
}
