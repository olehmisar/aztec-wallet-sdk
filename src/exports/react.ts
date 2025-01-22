import { useEffect, useState } from "react";
import type { PopupWalletSdk } from "../popup.js";
import type { ReownWalletSdk } from "../reown.js";
import type { ReownPopupWalletSdk } from "../reownPopup.js";
import type { Eip1193Account } from "./eip1193.js";

export function useAccount(
  wallet: PopupWalletSdk | ReownPopupWalletSdk | ReownWalletSdk,
) {
  const [account, setAccount] = useState<Eip1193Account | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = wallet.accountObservable.subscribe((account) => {
      setAccount(account);
    });
    return () => unsubscribe();
  }, []);

  return account;
}
