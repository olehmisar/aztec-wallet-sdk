// copied and adapted from CoinbaseWalletSdk: https://github.com/coinbase/coinbase-wallet-sdk/blob/bb531e34133fde40f53229966812b77a6e5a2626/packages/wallet-sdk/src/core/communicator/Communicator.ts

const DEFAULT_IFRAME_RPC_CALLS = ["aztec_call"];

type Popup = {
  window: Window | null;
  url: URL;
  fallbackOpenPopup?: FallbackOpenPopup;
  closeInterval: any;
};

type IFrame = {
  url: URL;
  rpcCalls: string[];
  element: HTMLIFrameElement | null;
};

type CommunicatorParams = {
  popupParams: {
    url: string;
    fallbackOpenPopup?: FallbackOpenPopup;
  };
  iframeParams: {
    url: string;
    rpcCalls?: string[];
    element?: HTMLIFrameElement;
  };
};

type WindowType = "popup" | "iframe";
type DisconnectOption = WindowType | "both";

type ListenerInfo = {
  reject: (_: Error) => void;
  type: "popup" | "iframe";
};

/**
 * Communicates with a wallet popup window for to send and receive messages.
 *
 * This class is responsible for opening a popup window, posting messages to it,
 * and listening for responses.
 *
 * It also handles cleanup of event listeners and the popup window itself when necessary.
 */
export class Communicator {
  // private listeners = new Map<(_: MessageEvent) => void, { reject: (_: Error) => void }>()
  private listeners = new Map<(_: MessageEvent) => void, ListenerInfo>();
  private popup: Popup;
  private iframe: IFrame;

  /**
   * @param params
   * @param params.popupParams - Parameters for the popup window
   * @param params.iframeParams - Parameters for the iframe
   */
  constructor(params: CommunicatorParams) {
    this.popup = {
      url: new URL(params.popupParams.url),
      window: null,
      closeInterval: null,
    };
    this.iframe = {
      url: new URL(params.iframeParams.url),
      rpcCalls: params.iframeParams.rpcCalls || DEFAULT_IFRAME_RPC_CALLS,
      element: params.iframeParams.element || null,
    };
  }

  /**
   * Posts a message to the popup window
   */
  postMessage = async (message: Message, type: WindowType) => {
    console.log("postMessage", message);
    if (type === "iframe") {
      console.log("posting to iframe...");
      const iframeWindow = await this.waitForIframeLoaded();
      iframeWindow.postMessage(message, this.iframe.url.origin);
    } else {
      console.log("posting to popup...");
      const popup = await this.waitForPopupLoaded();
      popup.postMessage(message, this.popup.url.toString());
    }
  };

  /**
   * Posts a request to the popup window and waits for a response
   */
  postRequestAndWaitForResponse = async <M extends Message>(
    request: Message,
  ): Promise<M> => {
    console.log("postRequestAndWaitForResponse", request);

    let type: WindowType = this.iframe.rpcCalls.includes(request.data.method)
      ? "iframe"
      : "popup";
    const responsePromise = this.onMessage<M>(
      ({ requestId }) => requestId === request.requestId,
      type,
    );
    await this.postMessage(request, type);
    return await responsePromise;
  };

  /**
   * Retrieves the iframe's window, creating the iframe if it doesn't exist.
   */
  private getIframeWindow(): Window | null {
    console.log("getIframeWindow...");
    let iframe = this.iframe.element;
    if (iframe) {
      if (!iframe.isConnected || !iframe.contentWindow) {
        console.log("iframe is disconnected or contentWindow is unavailable");
        this.iframe.element = null;
      } else {
        console.log("iframe.contentWindow", iframe.contentWindow);
        return iframe.contentWindow;
      }
    }

    if (!iframe) {
      console.log("creating iframe...");
      iframe = document.createElement("iframe");
      iframe.src = this.iframe.url.toString();
      iframe.style.display = "none";
      document.body.appendChild(iframe);
    }

    return iframe ? iframe.contentWindow : null;
  }
  /**
   * Listens for messages from the popup window that match a given predicate.
   */
  onMessage = async <M extends Message>(
    predicate: (_: Partial<M>) => boolean,
    type: WindowType,
  ): Promise<M> => {
    return new Promise((resolve, reject) => {
      const listener = (event: MessageEvent<M>) => {
        const validPopup = event.origin === this.popup.url.origin;
        const validIframe = event.origin === this.iframe.url.origin;
        if (!validPopup && !validIframe) return; // origin validation

        const message = event.data;
        if (predicate(message)) {
          resolve(message);
          window.removeEventListener("message", listener);
          this.listeners.delete(listener);
        }
      };

      window.addEventListener("message", listener);
      this.listeners.set(listener, { reject, type });
    });
  };

  /**
   * Closes the popup, rejects all requests and clears the listeners
   */
  disconnect = (disconnectOption: DisconnectOption) => {
    if (disconnectOption === "popup" || disconnectOption === "both") {
      closePopup(this.popup.window);
      this.popup.window = null;

      if (this.popup.closeInterval != null) {
        clearInterval(this.popup.closeInterval);
        this.popup.closeInterval = undefined;
      }
    }

    if (disconnectOption === "iframe" || disconnectOption === "both") {
      closeIframe(this.iframe.element);
      this.iframe.element = null;
    }

    this.listeners.forEach(({ reject, type }, listener) => {
      if (type === disconnectOption || disconnectOption === "both") {
        reject(new Error("Request rejected"));
        window.removeEventListener("message", listener);
        this.listeners.delete(listener);
      }
    });
  };

  /**
   * Waits for the popup window to fully load and then sends a version message.
   */
  waitForPopupLoaded = async (): Promise<Window> => {
    if (this.popup.window && !this.popup.window.closed) {
      // In case the user un-focused the popup between requests, focus it again
      this.popup.window.focus();
      return this.popup.window;
    }

    this.popup.window = openPopup(this.popup.url);
    if (!this.popup.window && this.popup.fallbackOpenPopup) {
      console.log("failed to open, trying fallback");
      this.popup.window = await this.popup.fallbackOpenPopup(() =>
        openPopup(this.popup.url),
      );
    }
    if (!this.popup.window) {
      throw new Error("Failed to open popup: failed to load");
    }

    this.onMessage<ConfigMessage>(
      ({ event }) => event === "PopupUnload",
      "popup",
    )
      .then(() => this.disconnect("popup"))
      .catch(() => {});
    if (this.popup.closeInterval == null) {
      this.popup.closeInterval = setInterval(() => {
        if (!this.popup.window || this.popup.window.closed) {
          this.disconnect("popup");
        }
      }, 100);
    }

    const pingInterval: any = setInterval(() => {
      if (!this.popup.window || this.popup.window.closed) {
        clearInterval(pingInterval);
        return;
      }
      this.popup.window.postMessage(
        { event: "PopupLoadedRequest" },
        this.popup.url.origin,
      );
    }, 100);
    try {
      const message = await this.onMessage<ConfigMessage>(({ event }) => {
        return event === "PopupLoaded";
      }, "popup");
      console.log("message in waitForPopupLoaded", message);
    } finally {
      clearInterval(pingInterval);
    }

    return this.popup.window;
  };

  private async waitForIframeLoaded(): Promise<Window> {
    // Get or create the iframe window
    const iframeWindow = this.getIframeWindow();
    if (!iframeWindow) {
      throw new Error("Failed to create/find iframe");
    }

    // Create a "ping" loop
    const pingInterval = setInterval(() => {
      // If we can't access the window for some reason, stop
      if (!iframeWindow) {
        clearInterval(pingInterval);
        return;
      }
      // Send a ping message
      iframeWindow.postMessage(
        { event: "IFrameLoadedRequest" },
        this.iframe.url.origin,
      );
    }, 100);

    try {
      // Use `this.onMessage` to wait for an event: "IFrameLoaded"
      // This returns once the iframe has posted back a "IFrameLoaded" message
      const message = await this.onMessage<ConfigMessage>(({ event }) => {
        return event === "IFrameLoaded";
      }, "iframe");
      console.log("Iframe responded with IFrameLoaded:", message);
    } finally {
      // Stop the ping loop, whether success or error/timeout
      clearInterval(pingInterval);
    }

    // At this point, the iframe is “handshake complete”
    return iframeWindow;
  }
}

const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 540;

// Window Management

export function openPopup(url: URL): Window | null {
  const left = (window.innerWidth - POPUP_WIDTH) / 2 + window.screenX;
  const top = (window.innerHeight - POPUP_HEIGHT) / 2 + window.screenY;

  const popup = window.open(
    url,
    "Smart Wallet",
    `width=${POPUP_WIDTH}, height=${POPUP_HEIGHT}, left=${left}, top=${top}`,
  );

  popup?.focus();

  return popup;
}

export function closePopup(popup: Window | null) {
  if (popup && !popup.closed) {
    popup.close();
  }
}

export function closeIframe(iframe: HTMLIFrameElement | null) {
  if (iframe && !iframe.hasAttribute("data-external")) {
    document.body.removeChild(iframe);
  }
}

type Message = {
  requestId: string;
  data: {
    method: string;
  };
};

export interface ConfigMessage extends Message {
  event: ConfigEvent;
}

export type ConfigEvent = "PopupLoaded" | "PopupUnload" | "IFrameLoaded";

export type FallbackOpenPopup = (
  openPopup: () => Window | null,
) => Promise<Window | null>;
