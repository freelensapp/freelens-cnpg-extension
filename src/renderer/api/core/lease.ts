/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Kubernetes Lease (`coordination.k8s.io/v1`) as the views read it
// (SPEC-0016, SPEC-0019). The host already has an API and a store for the
// kind, so the extension registers nothing: it asks the host's API manager for
// that store, and so a lease links to the host's own details panel.

import { Renderer } from "@freelensapp/extensions";
import { maybe } from "../../../common/utils";

export const LEASE_API_BASE = "/apis/coordination.k8s.io/v1/leases";

export interface LeaseSpec {
  holderIdentity?: string;
  /** MicroTime: RFC 3339 with six fractional digits. */
  acquireTime?: string;
  renewTime?: string;
  leaseDurationSeconds?: number;
  leaseTransitions?: number;
}

export interface LeaseLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: LeaseSpec;
  selfLink?: string;
}

export interface LeaseStoreLike {
  items: LeaseLike[];
  isLoaded?: boolean;
  getByName(name: string, namespace?: string): (LeaseLike & { selfLink: string }) | undefined;
}

/** The host's store of leases; `undefined` on a host that does not register the kind. */
export function getLeaseStore(): LeaseStoreLike | undefined {
  return (
    maybe(() => Renderer.K8sApi.apiManager.getStore(LEASE_API_BASE) as unknown as LeaseStoreLike | undefined) ??
    undefined
  );
}
