/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { CnpgPreferencesStore } from "./preferences-store";

describe("the preferences of the extension (SPEC-0039)", () => {
  it("keeps one Grafana per Kubernetes cluster, and forgets it when its URL is emptied", () => {
    const store = new CnpgPreferencesStore();
    store.setGrafana("cluster-a", { url: "https://grafana.example.com", dashboardUid: "" });
    store.setGrafana("cluster-b", { url: "http://localhost:3000", dashboardUid: "team" });
    expect(store.toJSON()).toEqual({
      grafana: {
        "cluster-a": { url: "https://grafana.example.com", dashboardUid: "" },
        "cluster-b": { url: "http://localhost:3000", dashboardUid: "team" },
      },
    });
    store.setGrafana("cluster-a", { url: "  ", dashboardUid: "x" });
    expect(Object.keys(store.toJSON().grafana)).toEqual(["cluster-b"]);
  });

  it("hands the host a model it can clone to send it to main", () => {
    const store = new CnpgPreferencesStore();
    store.setGrafana("cluster-a", { url: "https://grafana.example.com", dashboardUid: "" });
    expect(() => structuredClone(store.toJSON())).not.toThrow();
    expect(structuredClone(store.toJSON())).toEqual(store.toJSON());
  });

  it("reads back what it saved, and an old file without the key", () => {
    const store = new CnpgPreferencesStore();
    store.fromStore({ grafana: { c: { url: "https://g", dashboardUid: "" } } });
    expect(store.grafana.c.url).toBe("https://g");
    store.fromStore({} as never);
    expect(store.grafana).toEqual({});
  });
});
