/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The channels main answers (`common/ipc.ts`): the local port forwards of
// SPEC-0031 and the files of the primary of SPEC-0035. Each answer goes to the
// frame that asked.

import { Main } from "@freelensapp/extensions";
import { CNPG_IPC } from "../common/ipc";
import { createKubectlHost } from "./kubectl-host";
import { ServiceForwards } from "./port-forwards";
import { readPrimaryFiles } from "./primary-files";

import type { ForwardListRequest, ForwardStartRequest, ForwardStopRequest, PrimaryFilesRequest } from "../common/ipc";
import type { KubectlHost } from "./kubectl";

export class CnpgIpcMain extends Main.Ipc {
  private readonly host: KubectlHost;
  readonly forwards: ServiceForwards;

  constructor(extension: Main.LensExtension) {
    super(extension);
    this.host = createKubectlHost(() => extension.manifestPath);
    this.forwards = new ServiceForwards(this.host);

    this.handle(CNPG_IPC.forwardStart, (_event, request: ForwardStartRequest) => this.forwards.start(request));
    this.handle(CNPG_IPC.forwardStop, (_event, request: ForwardStopRequest) =>
      this.forwards.stop(String(request?.id ?? "")),
    );
    this.handle(CNPG_IPC.forwardList, (_event, request: ForwardListRequest) => this.forwards.list(request));
    this.handle(CNPG_IPC.primaryFiles, (_event, request: PrimaryFilesRequest) => readPrimaryFiles(this.host, request));
  }

  /** Every forward closed: the extension is deactivated. */
  shutdown(): Promise<void> {
    return this.forwards.closeAll();
  }
}
