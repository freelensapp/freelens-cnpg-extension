/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The renderer's side of the channels of `common/ipc.ts`: the local port
// forwards of SPEC-0031 and the files of the primary of SPEC-0035. Each call
// carries the id of the Kubernetes cluster of this frame.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_IPC } from "../common/ipc";

import type {
  ForwardDto,
  ForwardListRequest,
  ForwardStartAnswer,
  ForwardStartRequest,
  PrimaryFilesAnswer,
  PrimaryFilesRequest,
} from "../common/ipc";

/** The id of the Kubernetes cluster of this frame, or undefined outside a cluster. */
export function activeClusterId(): string | undefined {
  try {
    return Renderer.Catalog.getActiveCluster()?.id;
  } catch {
    return undefined;
  }
}

export class CnpgIpcRenderer extends Renderer.Ipc {
  startForward(request: ForwardStartRequest): Promise<ForwardStartAnswer> {
    return this.invoke(CNPG_IPC.forwardStart, request) as Promise<ForwardStartAnswer>;
  }

  stopForward(id: string): Promise<ForwardDto | undefined> {
    return this.invoke(CNPG_IPC.forwardStop, { id }) as Promise<ForwardDto | undefined>;
  }

  listForwards(request: ForwardListRequest): Promise<ForwardDto[]> {
    return this.invoke(CNPG_IPC.forwardList, request) as Promise<ForwardDto[]>;
  }

  readPrimaryFiles(request: PrimaryFilesRequest): Promise<PrimaryFilesAnswer> {
    return this.invoke(CNPG_IPC.primaryFiles, request) as Promise<PrimaryFilesAnswer>;
  }
}

/** The client, once the extension is active. */
export function cnpgIpc(): CnpgIpcRenderer | undefined {
  try {
    return CnpgIpcRenderer.getInstance();
  } catch {
    return undefined;
  }
}
