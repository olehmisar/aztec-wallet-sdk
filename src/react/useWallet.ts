import { createPXEClient } from "@aztec/aztec.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Eip1193Account } from "../exports/eip1193.js";
import { PopupWalletSdk } from "../popup.js";
import { DEFAULT_PXE_URL } from "../utils.js";

export function useWallet(
  pxeUrl: string | undefined,
  walletUrl: string | undefined,
) {
  const [account, setAccount] = useState<Eip1193Account | undefined>(undefined);
  const [sdk, setSdk] = useState<PopupWalletSdk | undefined>(undefined);
  const iframeRef = useRef<HTMLIFrameElement | undefined>(undefined);
  const [isIframeReady, setIsIframeReady] = useState(false);

  useEffect(() => {
    if (!isIframeReady || !iframeRef.current) return;

    const pxe = createPXEClient(pxeUrl || DEFAULT_PXE_URL);

    console.log("iframeRef.current", iframeRef.current);
    const sdk = new PopupWalletSdk(pxe, {
      walletUrl,
      externalIframe: iframeRef.current,
    });
    setSdk(sdk);
  }, [pxeUrl, walletUrl, isIframeReady]);

  useEffect(() => {
    if (!sdk) return;

    const unsubscribe = sdk.accountObservable.subscribe((account) => {
      setAccount(account);
    });
    return () => unsubscribe();
  }, [sdk]);

  const handleIframeLoad = useCallback(() => {
    setIsIframeReady(true);
  }, []);

  const setIframeRef = useCallback((node: HTMLIFrameElement | null) => {
    if (node !== null) {
      iframeRef.current = node;
    }
  }, []);

  return {
    account,
    sdk,
    handleIframeLoad,
    setIframeRef,
  };
}
