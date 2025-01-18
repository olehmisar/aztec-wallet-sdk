import { createContext, type ReactNode, useContext } from "react";
import type { Eip1193Account } from "../exports/eip1193.js";
import type { PopupWalletSdk } from "../popup.js";
import { DEFAULT_WALLET_URL } from "../utils.js";
import { useWallet } from "./useWallet.js";

const WalletContext = createContext<
  | { account: Eip1193Account | undefined; sdk: PopupWalletSdk | undefined }
  | undefined
>(undefined);
export function useWalletContext() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWalletContext must be used within a WalletProvider");
  }
  return context;
}

interface WalletProviderProps {
  pxeUrl: string | undefined;
  walletUrl: string | undefined;
  children: ReactNode;
}

export function WalletProvider({
  pxeUrl,
  walletUrl,
  children,
}: WalletProviderProps) {
  const { account, sdk, handleIframeLoad, setIframeRef } = useWallet(
    pxeUrl,
    walletUrl,
  );

  return (
    <WalletContext.Provider value={{ account, sdk }}>
      {children}
      <WalletIFrame
        url={walletUrl}
        setIframeRef={setIframeRef}
        isLoaded={handleIframeLoad}
      />
    </WalletContext.Provider>
  );
}

export function WalletIFrame({
  url,
  setIframeRef,
  isLoaded,
}: {
  url: string | undefined;
  setIframeRef: (node: HTMLIFrameElement | null) => void;
  isLoaded: () => void;
}) {
  return (
    <iframe
      ref={setIframeRef}
      src={(url || DEFAULT_WALLET_URL) + "/data"}
      loading="eager"
      onLoad={isLoaded}
      width="0"
      height="0"
      style={{
        opacity: 0,
        position: "absolute",
        top: 0,
        left: 0,
        border: "none",
      }}
    />
  );
}
