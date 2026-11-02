// @vitest-environment jsdom

/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { act, cleanup, render, screen } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAvailableVersionPage } from "./available-version";

import type { AvailableVersionPageProps } from "./available-version";

// The installation guide asks the API server what is installed: not under test here.
vi.mock("./install-guide-view", () => ({
  useClusterComponents: () => undefined,
  InstallGuide: () => <span>install guide</span>,
}));

const extension = { name: "@freelensapp/cnpg-extension" } as Renderer.LensExtension;

// The stub's `getStore()` throws, as the host's does for a version it does not serve.
class ClusterV1 extends Renderer.K8sApi.LensExtensionKubeObject {}

const ClustersPage = createAvailableVersionPage<AvailableVersionPageProps>(
  "PostgreSQL Clusters",
  [
    {
      kubeObjectClass: ClusterV1,
      PageComponent: ({ extension: { name } }) => <span>clusters of {name}</span>,
      version: "v1",
    },
  ],
  "Install the operator.",
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the page of a kind whose CRD may be served later", () => {
  it("renders the page when the host serves the version", () => {
    vi.spyOn(ClusterV1, "getStore").mockReturnValue({} as Renderer.K8sApi.KubeObjectStore<any, any, any>);
    render(<ClustersPage extension={extension} />);
    expect(screen.getByText("clusters of @freelensapp/cnpg-extension")).toBeDefined();
  });

  it("says the kind is not available, with the hint, the versions tried and the guide", () => {
    render(<ClustersPage extension={extension} />);
    expect(screen.getByText("PostgreSQL Clusters Not Available")).toBeDefined();
    expect(screen.getByText("Install the operator.")).toBeDefined();
    expect(screen.getByText("v1")).toBeDefined();
    expect(screen.getByText("install guide")).toBeDefined();
  });

  it("renders the page once the host serves the version after the first render (the first view of a cluster)", () => {
    // The host's `getStore()` reads its observable API registry; the spy reads an observable in its place.
    const served = observable.box(false);
    vi.spyOn(ClusterV1, "getStore").mockImplementation(() => {
      if (!served.get()) throw new Error("no API for ClusterV1");
      return {} as Renderer.K8sApi.KubeObjectStore<any, any, any>;
    });
    render(<ClustersPage extension={extension} />);
    expect(screen.getByText("PostgreSQL Clusters Not Available")).toBeDefined();
    act(() => runInAction(() => served.set(true)));
    expect(screen.getByText("clusters of @freelensapp/cnpg-extension")).toBeDefined();
    expect(screen.queryByText("PostgreSQL Clusters Not Available")).toBeNull();
  });
});
