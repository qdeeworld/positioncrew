export const CAPITAL_CHECK_SEED_KEY = "positioncrew:capital-check:v1";

export interface CapitalCheckSeed {
  account: string;
  pancakePositionId?: string;
  checkedAt: string;
}

export function readCapitalCheckSeed(): CapitalCheckSeed | null {
  try {
    const raw = window.sessionStorage.getItem(CAPITAL_CHECK_SEED_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CapitalCheckSeed>;
    const account = value.account;
    if (typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account) || typeof value.checkedAt !== "string") {
      return null;
    }
    if (value.pancakePositionId !== undefined && !/^[1-9][0-9]{0,77}$/.test(value.pancakePositionId)) {
      return null;
    }
    return {
      account,
      checkedAt: value.checkedAt,
      ...(value.pancakePositionId ? { pancakePositionId: value.pancakePositionId } : {}),
    };
  } catch {
    return null;
  }
}

export function saveCapitalCheckSeed(seed: CapitalCheckSeed): void {
  try {
    window.sessionStorage.setItem(CAPITAL_CHECK_SEED_KEY, JSON.stringify(seed));
  } catch {
    // Session handoff is optional; the public scan remains useful without browser storage.
  }
}
