import type { PXE } from "@aztec/aztec.js";
import { persisted } from "svelte-persisted-store";
import { get, readonly, writable } from "svelte/store";
import { assert, type AsyncOrSync } from "ts-essentials";
import { joinURL } from "ufo";
import { Communicator, type FallbackOpenPopup } from "./Communicator.js";
import type { Eip1193Account } from "./exports/eip1193.js";
import type {
  RpcRequest,
  RpcRequestMap,
  TypedEip1193Provider,
} from "./types.js";
import {
  DEFAULT_WALLET_URL,
  accountFromCompleteAddress,
  resolvePxe,
} from "./utils.js";

export class PopupWalletSdk implements TypedEip1193Provider {
  readonly #pxe: () => AsyncOrSync<PXE>;

  readonly #communicator: Communicator;

  #pendingRequestsCount = 0;

  readonly #connectedAccountCompleteAddress = persisted<string | null>(
    "aztec-wallet-connected-complete-address",
    null,
  );
  readonly #account = writable<Eip1193Account | undefined>(undefined);
  readonly accountObservable = readonly(this.#account);

  readonly walletUrl: string;

  constructor(
    pxe: (() => AsyncOrSync<PXE>) | PXE,
    params: {
      /**
       * Called when user browser blocks a popup. Use this to attempt to re-open the popup.
       * Must call the provided callback right after user clicks a button, so browser does not block it.
       * Browsers usually don't block popups if they are opened within a few milliseconds of a button click.
       */
      fallbackOpenPopup?: FallbackOpenPopup;
      walletUrl?: string;
      externalIframe?: HTMLIFrameElement;
    } = {},
  ) {
    this.#pxe = resolvePxe(pxe);
    this.walletUrl = params.walletUrl ?? DEFAULT_WALLET_URL;
    this.#communicator = new Communicator({
      popupParams: {
        url: joinURL(this.walletUrl, "/sign"),
        fallbackOpenPopup: params.fallbackOpenPopup,
      },
      iframeParams: {
        url: joinURL(this.walletUrl, "/data"),
        element: params.externalIframe,
      },
    });

    let accountId = 0;
    this.#connectedAccountCompleteAddress.subscribe(async (completeAddress) => {
      if (typeof window === "undefined") {
        return;
      }

      const thisAccountId = ++accountId;

      const { CompleteAddress } = await import("@aztec/aztec.js");

      const account = completeAddress
        ? await accountFromCompleteAddress(
            this,
            await this.#pxe(),
            CompleteAddress.fromString(completeAddress),
          )
        : undefined;
      if (thisAccountId !== accountId) {
        // prevent race condition
        return;
      }
      this.#account.set(account);
    });
  }
  getAccount() {
    return get(this.#account);
  }

  async connect() {
    const { CompleteAddress } = await import("@aztec/aztec.js");
    const result = await this.request({
      method: "aztec_requestAccounts",
      params: [],
    });
    const [address] = result;
    assert(address, "No accounts found");
    const account = await accountFromCompleteAddress(
      this,
      await this.#pxe(),
      CompleteAddress.fromString(address),
    );
    this.#connectedAccountCompleteAddress.set(address);
    return account;
  }

  async disconnect() {
    this.#connectedAccountCompleteAddress.set(null);
    this.#communicator.disconnect("both");
  }

  /**
   * @deprecated not needed anymore
   */
  async reconnect() {}

  /**
   * Sends a raw RPC request to the user's wallet.
   */
  async request<M extends keyof RpcRequestMap>(
    request: RpcRequest<M>,
  ): Promise<ReturnType<RpcRequestMap[M]>> {
    const result = await this.#requestPopup(request);
    return result;
  }

  async #requestPopup<M extends keyof RpcRequestMap>(
    request: RpcRequest<M>,
  ): Promise<ReturnType<RpcRequestMap[M]>> {
    this.#pendingRequestsCount++;
    // TODO: handle batch requests
    try {
      const rpcRequest = {
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: request.method,
        params: request.params,
      };
      const response: any = (
        await this.#communicator.postRequestAndWaitForResponse({
          requestId: crypto.randomUUID(),
          data: rpcRequest,
        })
      )?.data;
      if ("error" in response) {
        throw new Error(JSON.stringify(response.error));
      }
      return response.result;
    } finally {
      this.#pendingRequestsCount--;

      const disconnectIfNoPendingRequests = () => {
        if (this.#pendingRequestsCount <= 0) {
          this.#communicator.disconnect("popup");
        }
      };

      if (finalMethods.includes(request.method)) {
        disconnectIfNoPendingRequests();
      } else {
        setTimeout(disconnectIfNoPendingRequests, 1000);
      }
    }
  }
}

const finalMethods: readonly (keyof RpcRequestMap)[] = [
  "aztec_requestAccounts",
  "aztec_sendTransaction",
];
