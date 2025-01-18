# Aztec Wallet SDK

Connect your Aztec app to any Aztec wallet.

[Docs](https://docs.shieldswap.org/modal)

## EIP-1193 RPC docs

```ts
// before
import { Wallet } from "@aztec/aztec.js";
const account: Wallet;
const token = await TokenContract.at(address, account);

// after
import { PopupWalletSdk } from "@shieldswap/wallet-sdk";
import { Eip1193Account, Contract } from "@shieldswap/wallet-sdk/eip1193";
const Token = Contract.fromAztec(TokenContract, TokenContractArtifact);

const wallet = new PopupWalletSdk(pxe);
const account = await wallet.getAccount();
const token = await Token.at(address, account);
```

## Example

App.tsx

```tsx
import { YourComponent } from "./YourComponent";
import { WalletProvider } from "@shieldswap/wallet-sdk/react";

export const PXE_URL = "http://localhost:8080"; // change it to your pxe url
export const WALLET_URL = "http://localhost:5173"; // change it to your wallet url

const App = () => {
  return (
    <>
      <WalletProvider pxeUrl={PXE_URL} walletUrl={WALLET_URL}>
        <YourComponent />
      </WalletProvider>
    </>
  );
};

export default App;
```

YourComponent.tsx

```tsx
import { useWalletContext } from "@shieldswap/wallet-sdk/react";

const YourComponent = () => {
  const { account, sdk } = useWalletContext();

  return (
    <div>
      <p>Your Component</p>
      <button onClick={() => sdk?.connect()}>Connect</button>
    </div>
  );
};

export default YourComponent;
```
