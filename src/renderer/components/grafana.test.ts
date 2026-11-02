/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { checkGrafanaUrl, grafanaDashboardUrl, grafanaRange } from "./grafana";

describe("the Grafana link (SPEC-0039)", () => {
  it("builds the URL of the CloudNativePG dashboard of a cluster, over the range of the Live View", () => {
    expect(
      grafanaDashboardUrl(
        { url: "https://grafana.example.com/", dashboardUid: "" },
        "cnpg-e2e",
        "e2e-main",
        grafanaRange("15m"),
      ),
    ).toBe(
      "https://grafana.example.com/d/cloudnative-pg?var-namespace=cnpg-e2e&var-cluster=e2e-main&from=now-15m&to=now",
    );
  });

  it("keeps a sub-path, takes a dashboard of the team, and reads 'since opened' as a fixed start", () => {
    expect(
      grafanaDashboardUrl(
        { url: "https://ops.example.com/grafana", dashboardUid: "team-pg" },
        "db",
        "app",
        grafanaRange("all", 1_793_260_343_000),
      ),
    ).toBe("https://ops.example.com/grafana/d/team-pg?var-namespace=db&var-cluster=app&from=1793260343000&to=now");
    expect(grafanaRange(undefined)).toEqual({ from: "now-1h", to: "now" });
    expect(grafanaRange("all")).toEqual({ from: "now-1h", to: "now" });
  });

  it("gives no link without a valid URL", () => {
    expect(grafanaDashboardUrl(undefined, "db", "app")).toBeUndefined();
    expect(grafanaDashboardUrl({ url: "", dashboardUid: "" }, "db", "app")).toBeUndefined();
    expect(grafanaDashboardUrl({ url: "ftp://grafana", dashboardUid: "" }, "db", "app")).toBeUndefined();
  });

  it("says what is wrong with a base URL, and never keeps credentials", () => {
    expect(checkGrafanaUrl("")).toEqual({});
    expect(checkGrafanaUrl("grafana.example.com").problem).toBe("Not a URL: write it as https://grafana.example.com");
    expect(checkGrafanaUrl("file:///etc/passwd").problem).toBe("Only http and https URLs open in the browser");
    expect(checkGrafanaUrl("https://admin:secret@grafana.example.com").problem).toBe(
      "No credentials in the URL: Grafana asks for them in the browser",
    );
    expect(checkGrafanaUrl("https://grafana.example.com/?orgId=1").problem).toContain("The base URL only");
    expect(checkGrafanaUrl(" http://localhost:3000// ")).toEqual({ url: "http://localhost:3000" });
  });
});
