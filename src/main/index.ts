/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Main } from "@freelensapp/extensions";
import { CnpgPreferencesStore } from "../common/preferences-store";
import { CnpgIpcMain } from "./ipc";

// The views live in the renderer (ARCHITECTURE.md "Process model"); main keeps
// the preferences store of SPEC-0039, runs the local port forwards of
// SPEC-0031 and reads the files of the primary of SPEC-0035.
export default class CnpgMain extends Main.LensExtension {
  private ipc?: CnpgIpcMain;

  async onActivate() {
    // The preferences of SPEC-0039: main keeps the file the renderer edits.
    await CnpgPreferencesStore.getInstanceOrCreate().loadExtension(this);
    CnpgIpcMain.resetInstance();
    this.ipc = CnpgIpcMain.createInstance(this);
  }

  protected async onDeactivate() {
    // No forward outlives the extension (SPEC-0031).
    await this.ipc?.shutdown();
    this.ipc = undefined;
    CnpgIpcMain.resetInstance();
  }
}
