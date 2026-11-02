/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The main process of Freelens dev, reached through its inspector (`electron-vite dev --inspect`, port 5858 unless
// FREELENS_MAIN_INSPECT says otherwise): what the cases need of it is the dialog of a save (SPEC-0038), which they
// answer themselves, as freelens-velero-extension does through Playwright's Electron application.

const inspectPort = Number(process.env.FREELENS_MAIN_INSPECT ?? 5858);

/** Evaluates an expression in main and returns its value. */
export async function evaluateInMain<T>(expression: string): Promise<T> {
  const targets = (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()) as Array<{
    webSocketDebuggerUrl: string;
  }>;
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  try {
    const answer = await new Promise<{ result?: { result?: { value?: T }; exceptionDetails?: { text?: string } } }>(
      (resolve) => {
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));

          if (message.id === 1) resolve(message);
        });
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      },
    );

    if (answer.result?.exceptionDetails) throw new Error(`main: ${answer.result.exceptionDetails.text}`);
    return answer.result?.result?.value as T;
  } finally {
    socket.close();
  }
}

export interface SaveDialogCall {
  title: string;
  defaultPath: string;
}

const ELECTRON = "(typeof require === 'function' ? require : process.mainModule.require)('electron')";

/**
 * Stands in the place of Electron's save dialog in main: from now on no dialog is shown, and the one asked answers
 * `file`, or that it was closed when `file` is empty. The extension asks Electron for its dialog at each save.
 */
export async function replaceSaveDialog(file: string): Promise<void> {
  await evaluateInMain(`(() => {
    const { dialog } = ${ELECTRON};
    const kept = (globalThis.cnpgSaveDialog ??= { answer: "", calls: [] });
    kept.answer = ${JSON.stringify(file)};
    if (!kept.original) {
      kept.original = dialog.showSaveDialog;
      dialog.showSaveDialog = (...asked) => {
        const options = asked[asked.length - 1] ?? {};
        kept.calls.push({ title: String(options.title ?? ""), defaultPath: String(options.defaultPath ?? "") });
        return Promise.resolve(kept.answer ? { canceled: false, filePath: kept.answer } : { canceled: true, filePath: "" });
      };
    }
    return true;
  })()`);
}

/** What the replaced dialog was asked so far. */
export function saveDialogCalls(): Promise<SaveDialogCall[]> {
  return evaluateInMain("globalThis.cnpgSaveDialog?.calls ?? []");
}

/** Puts Electron's own dialog back. */
export async function restoreSaveDialog(): Promise<void> {
  await evaluateInMain(`(() => {
    const kept = globalThis.cnpgSaveDialog;
    if (kept?.original) ${ELECTRON}.dialog.showSaveDialog = kept.original;
    delete globalThis.cnpgSaveDialog;
    return true;
  })()`);
}
