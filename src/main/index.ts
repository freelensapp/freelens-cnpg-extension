/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Main } from "@freelensapp/extensions";
import { CnpgPreferencesStore } from "../common/preferences-store";

// Everything of M1 to M8 lives in the renderer (ARCHITECTURE.md "Process
// model"); main loads the preferences store of SPEC-0039, whose file it keeps.
export default class CnpgMain extends Main.LensExtension {
  async onActivate() {
    // The preferences of SPEC-0039: main keeps the file the renderer edits.
    await CnpgPreferencesStore.getInstanceOrCreate().loadExtension(this);
  }
}
