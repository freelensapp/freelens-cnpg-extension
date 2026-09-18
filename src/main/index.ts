/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Main } from "@freelensapp/extensions";

// Everything of M1 lives in the renderer (ARCHITECTURE.md "Process model");
// the main process entry point stays for the lifecycle hooks later
// milestones need (the psql terminal of SPEC-0007).
export default class CnpgMain extends Main.LensExtension {}
