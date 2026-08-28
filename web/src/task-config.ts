import type { LucideIcon } from "lucide-react";
import { Activity, ChartNoAxesCombined, Grid3X3, RefreshCw } from "lucide-react";
import type { ServiceId } from "./types";

export interface TaskConfig {
  id: ServiceId;
  index: string;
  title: string;
  shortTitle: string;
  action: string;
  description: string;
  currentSource: string;
  currentAction: string;
  decisionContract: {
    input: string;
    output: string;
    noAction: string;
    refusal: string;
  };
  icon: LucideIcon;
  inputs: Array<{ label: string; value: string; emphasis?: boolean }>;
}

export const TASKS: TaskConfig[] = [
  {
    id: "LENDING_RESCUE",
    index: "01",
    title: "Rescue a lending position",
    shortTitle: "Lending rescue",
    action: "Check providers and rescue",
    description: "Find the smallest allowed action that restores a stressed lending position.",
    currentSource: "Block-pinned Venus position",
    currentAction: "Load current position, check eligibility, and hire",
    decisionContract: {
      input: "A BSC address. PositionCrew loads its current Venus Classic position and applies the displayed fixed safety policy.",
      output: "The smallest allowed rescue action, projected health factors, expiry, and execution guards.",
      noAction: "A position already above target returns NONE with the reason and the evaluated health factors.",
      refusal: "No complete position, stale evidence, or unsafe oracle data produces a receipted refusal.",
    },
    icon: Activity,
    inputs: [
      { label: "Protocol", value: "Venus" },
      { label: "Current HF", value: "1.043", emphasis: true },
      { label: "Stress HF", value: "0.939", emphasis: true },
      { label: "Target HF", value: "1.250" },
      { label: "Action cap", value: "$250" },
      { label: "Max slippage", value: "30 bps" },
    ],
  },
  {
    id: "LP_REBALANCE",
    index: "02",
    title: "Reset an LP range",
    shortTitle: "LP rebalance",
    action: "Run range check",
    description: "Move an out-of-range position only when net benefit clears hard costs.",
    currentSource: "Block-pinned PancakeSwap V3 position",
    currentAction: "Load current LP and hire",
    decisionContract: {
      input: "A PancakeSwap V3 position plus editable benefit, cost, horizon, and gas assumptions.",
      output: "A keep-or-rebalance decision with target ticks, expected costs, net benefit, and expiry.",
      noAction: "A valid range or insufficient net benefit returns HOLD with the reason and evaluated economics.",
      refusal: "An unavailable position, stale evidence, or invalid request produces a receipted refusal.",
    },
    icon: RefreshCw,
    inputs: [
      { label: "Current tick", value: "150", emphasis: true },
      { label: "Current range", value: "-120 to 120" },
      { label: "Position", value: "$10,000" },
      { label: "24h fees", value: "$2,000" },
      { label: "Min benefit", value: "$5" },
      { label: "Tick spacing", value: "60" },
    ],
  },
  {
    id: "YIELD_OPTIMIZATION",
    index: "03",
    title: "Improve a yield allocation",
    shortTitle: "Yield optimise",
    action: "Compare allocation",
    description: "Choose an allowlisted destination after costs, liquidity, lockup, and risk checks.",
    currentSource: "Block-pinned Venus markets",
    currentAction: "Load current markets and hire",
    decisionContract: {
      input: "Capital, holding period, risk ceiling, minimum liquidity, and maximum lockup for the loaded Venus markets.",
      output: "The single best eligible allocation with yield, liquidity, cost, and risk evidence.",
      noAction: "When no market clears every constraint, the provider returns HOLD and explains why.",
      refusal: "Stale market evidence or an invalid request produces a receipted refusal.",
    },
    icon: ChartNoAxesCombined,
    inputs: [
      { label: "Capital", value: "$1,000" },
      { label: "Current APY", value: "4.00%" },
      { label: "Candidate APY", value: "9.00%", emphasis: true },
      { label: "Risk ceiling", value: "Medium" },
      { label: "Min liquidity", value: "$1m" },
      { label: "Horizon", value: "90 days" },
    ],
  },
  {
    id: "BOUNDED_GRID",
    index: "04",
    title: "Build or reject a bounded grid",
    shortTitle: "Bounded grid",
    action: "Build bounded grid",
    description: "Construct orders only inside inventory, loss, liquidity, and volatility limits.",
    currentSource: "Block-pinned PancakeSwap market",
    currentAction: "Load current market and hire",
    decisionContract: {
      input: "A current supported market plus the capital, range, order-count, inventory, and loss limits shown in the workspace.",
      output: "A bounded order ladder or NONE decision with maximum loss, invalidation rules, and expiry.",
      noAction: "A grid that breaches policy returns NO_GRID with the failed constraints and no orders.",
      refusal: "Stale or unsafe market evidence, or an invalid request, produces a receipted refusal.",
    },
    icon: Grid3X3,
    inputs: [
      { label: "Pair", value: "WBNB / USDT" },
      { label: "Mid price", value: "$10.00" },
      { label: "Grid range", value: "$9 to $11" },
      { label: "Capital", value: "$1,000" },
      { label: "Loss cap", value: "$150", emphasis: true },
      { label: "Levels", value: "5" },
    ],
  },
];
