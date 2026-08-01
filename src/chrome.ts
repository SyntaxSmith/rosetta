/**
 * Subset of `chrome-remote-interface`'s client surface that rosetta uses.
 *
 * `chrome-remote-interface` returns a generic `Client` whose typed accessors
 * (`Page`, `Runtime`, `Network`, `Fetch`, `Input`, `IO`, `Target`) are
 * resolved at runtime against the bundled DevTools protocol mapping. We
 * narrow it here so callers see strongly-typed CDP commands without pulling
 * the full CDP client type into our public API surface.
 */
export interface ChromeClient {
  Page: {
    enable(): Promise<void>;
    navigate(params: { url: string }): Promise<{ frameId: string }>;
    reload(params?: { ignoreCache?: boolean }): Promise<void>;
    bringToFront(): Promise<void>;
    loadEventFired(): Promise<{ timestamp: number }>;
  };
  Runtime: {
    enable(): Promise<void>;
    evaluate(params: {
      expression: string;
      returnByValue?: boolean;
      awaitPromise?: boolean;
    }): Promise<{
      // `objectId` is present when `returnByValue` is false and the expression
      // evaluates to a non-primitive (e.g. a DOM element) — we use it to hand a
      // node handle to `DOM.setFileInputFiles`. `subtype:"null"` distinguishes
      // a real `null` (selector matched nothing) from an object handle.
      result?: { value?: unknown; objectId?: string; subtype?: string };
      exceptionDetails?: { text: string };
    }>;
  };
  DOM: {
    // Set files on an `<input type="file">` from real on-disk paths. This is
    // the trusted, browser-native path (same as Playwright/Puppeteer
    // `setInputFiles`) — it fires the `change` event ChatGPT's React composer
    // actually consumes, unlike a hand-built DataTransfer + synthetic event.
    // Pass the input element's `objectId` (from a `returnByValue:false`
    // Runtime.evaluate) so we don't need DOM.getDocument.
    setFileInputFiles(params: {
      files: string[];
      objectId?: string;
      backendNodeId?: number;
      nodeId?: number;
    }): Promise<void>;
  };
  Network: {
    enable(params?: {
      maxTotalBufferSize?: number;
      maxResourceBufferSize?: number;
    }): Promise<void>;
    getCookies(params: { urls: string[] }): Promise<{ cookies: Array<{ name: string; value: string }> }>;
    getResponseBody(params: { requestId: string }): Promise<{ body: string; base64Encoded: boolean }>;
    requestWillBeSent(
      handler: (event: { requestId: string; request: { url: string } }) => void,
    ): () => void;
    responseReceived(
      handler: (event: {
        requestId: string;
        response: { status: number; mimeType?: string; headers?: Record<string, string> };
      }) => void,
    ): () => void;
    loadingFinished(
      handler: (event: { requestId: string; encodedDataLength?: number }) => void,
    ): () => void;
    loadingFailed(
      handler: (event: { requestId: string; errorText: string }) => void,
    ): () => void;
    webSocketCreated(
      handler: (event: { requestId: string; url: string }) => void,
    ): () => void;
    webSocketFrameReceived(
      handler: (event: { requestId: string; response: { payloadData: string } }) => void,
    ): () => void;
    webSocketClosed(
      handler: (event: { requestId: string }) => void,
    ): () => void;
  };
  Fetch: {
    enable(params: {
      patterns: Array<{
        urlPattern?: string;
        requestStage?: "Request" | "Response";
      }>;
    }): Promise<void>;
    disable(): Promise<void>;
    continueRequest(params: {
      requestId: string;
      postData?: string;
      headers?: Array<{ name: string; value: string }>;
      interceptResponse?: boolean;
    }): Promise<void>;
    failRequest(params: {
      requestId: string;
      errorReason: "Aborted";
    }): Promise<void>;
    requestPaused(
      handler: (event: {
        requestId: string;
        request: {
          url: string;
          postData?: string;
          hasPostData?: boolean;
          headers: Record<string, string>;
        };
        responseStatusCode?: number;
        responseHeaders?: Array<{ name: string; value: string }>;
      }) => void,
    ): () => void;
  };
  Input: {
    insertText(params: { text: string }): Promise<void>;
    dispatchKeyEvent(params: {
      type: "keyDown" | "keyUp" | "char";
      text?: string;
      key?: string;
      code?: string;
      windowsVirtualKeyCode?: number;
    }): Promise<void>;
  };
  Target: {
    createTarget(params: { url: string; background?: boolean }): Promise<{ targetId: string }>;
    closeTarget(params: { targetId: string }): Promise<{ success: boolean }>;
    getTargetInfo(params?: { targetId?: string }): Promise<{
      targetInfo?: { targetId?: string; url?: string };
    }>;
  };
  close(): Promise<void>;
}
