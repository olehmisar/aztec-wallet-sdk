import type { CompleteAddress, PXE } from "@aztec/aztec.js";
import type { AsyncOrSync } from "ts-essentials";
import type { Eip1193Provider, RpcRequestMap } from "./types.js";

const CAIP_PREFIX = "aztec";
const AZTEC_CHAIN_ID = "1";
export const CAIP = {
  chain() {
    return `${CAIP_PREFIX}:${AZTEC_CHAIN_ID}`;
  },
  address(address: string) {
    return `${CAIP_PREFIX}:${AZTEC_CHAIN_ID}:${address.toLowerCase()}`;
  },
};

export const DEFAULT_WALLET_URL = "https://obsidion.vercel.app";

export const METHODS_NOT_REQUIRING_CONFIRMATION: (keyof RpcRequestMap)[] = [
  "aztec_accounts",
  "aztec_call",
];

export function lazyValue<T>(fn: () => T) {
  let value: T;
  let initialized = false;
  return () => {
    if (!initialized) {
      initialized = true;
      value = fn();
    }
    return value;
  };
}

export async function accountFromCompleteAddress(
  provider: Eip1193Provider,
  pxe: PXE,
  address: CompleteAddress,
) {
  const { Eip1193Account } = await import("./exports/eip1193.js");
  return new Eip1193Account(address.address, provider, pxe);
}

export function resolvePxe(getPxe: PXE | (() => AsyncOrSync<PXE>)) {
  const getPxe2 = typeof getPxe === "function" ? getPxe : () => getPxe;
  return lazyValue(async () => {
    const { waitForPXE } = await import("@aztec/aztec.js");
    const pxe = await getPxe2();
    await waitForPXE(pxe);
    return pxe;
  });
}
