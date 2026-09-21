/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_FENCED_LIFT_REASON,
  COLD_SNAPSHOT_LIFT_REASON,
  canFenceAll,
  canFenceInstance,
  canLiftAll,
  canLiftInstance,
  coldSnapshotRunning,
  fenceOff,
  fenceOn,
  fencingDialogFacts,
  fencingPatch,
  HIBERNATED_FENCE_REASON,
  isFencedIn,
  parseFenced,
  serializeFenced,
} from "./fencing";

import type { FencedSet, FencingBackupFacts, FencingClusterFacts } from "./fencing";

function cluster(overrides: Partial<FencingClusterFacts> = {}): FencingClusterFacts {
  return {
    name: "pg",
    namespace: "db",
    resourceVersion: "42",
    hibernated: false,
    status: { currentPrimary: "pg-1", instanceNames: ["pg-1", "pg-2", "pg-3"] },
    ...overrides,
  };
}

const NONE: FencedSet = { kind: "none" };
const ALL: FencedSet = { kind: "all" };
const names = (...list: string[]): FencedSet => ({ kind: "names", names: list });

const COLD: FencingBackupFacts = { name: "cold", method: "volumeSnapshot", online: false, phase: "running" };

describe("parseFenced", () => {
  it("reads nobody from an absent, blank or empty value", () => {
    expect(parseFenced(undefined)).toEqual(NONE);
    expect(parseFenced(null)).toEqual(NONE);
    expect(parseFenced("  ")).toEqual(NONE);
    expect(parseFenced("[]")).toEqual(NONE);
  });

  it("reads the names, sorted and once each", () => {
    expect(parseFenced('["pg-3","pg-2","pg-3"]')).toEqual(names("pg-2", "pg-3"));
  });

  it("reads the star as every instance, whatever stands next to it", () => {
    expect(parseFenced('["*"]')).toEqual(ALL);
    expect(parseFenced('["pg-2","*"]')).toEqual(ALL);
  });

  it("says that a value does not parse, instead of reading nobody", () => {
    for (const raw of ["pg-2", '{"pg-2":true}', '"pg-2"', "[1,2]", '["pg-2",null]', "["]) {
      expect(parseFenced(raw)).toEqual({ kind: "unparseable", raw });
    }
  });

  it("knows who is fenced", () => {
    expect(isFencedIn(ALL, "pg-1")).toBe(true);
    expect(isFencedIn(names("pg-2"), "pg-2")).toBe(true);
    expect(isFencedIn(names("pg-2"), "pg-1")).toBe(false);
    expect(isFencedIn(NONE, "pg-1")).toBe(false);
    expect(isFencedIn({ kind: "unparseable", raw: "x" }, "pg-1")).toBe(false);
  });
});

describe("serializeFenced", () => {
  it("writes compact sorted JSON, the star alone, and null to remove the key", () => {
    expect(serializeFenced(names("pg-3", "pg-2"))).toBe('["pg-2","pg-3"]');
    expect(serializeFenced(ALL)).toBe('["*"]');
    expect(serializeFenced(NONE)).toBeNull();
    expect(serializeFenced(names())).toBeNull();
    expect(serializeFenced({ kind: "unparseable", raw: "x" })).toBeNull();
  });
});

describe("fenceOn", () => {
  it("adds a name, keeping the set sorted", () => {
    expect(fenceOn(NONE, "pg-2")).toEqual({ kind: "next", set: names("pg-2") });
    expect(fenceOn(names("pg-3"), "pg-2")).toEqual({ kind: "next", set: names("pg-2", "pg-3") });
    expect(fenceOn({ kind: "unparseable", raw: "x" }, "pg-2")).toEqual({ kind: "next", set: names("pg-2") });
  });

  it("replaces the names with the star", () => {
    expect(fenceOn(names("pg-2"), "*")).toEqual({ kind: "next", set: ALL });
    expect(fenceOn(NONE, "*")).toEqual({ kind: "next", set: ALL });
  });

  it("changes nothing when the instance is fenced already, by name or by the star", () => {
    expect(fenceOn(names("pg-2"), "pg-2")).toEqual({ kind: "unchanged" });
    expect(fenceOn(ALL, "pg-2")).toEqual({ kind: "unchanged" });
    expect(fenceOn(ALL, "*")).toEqual({ kind: "unchanged" });
  });
});

describe("fenceOff", () => {
  it("removes a name, and the key with the last one", () => {
    expect(fenceOff(names("pg-2", "pg-3"), "pg-2")).toEqual({ kind: "next", set: names("pg-3") });
    expect(fenceOff(names("pg-2"), "pg-2")).toEqual({ kind: "next", set: NONE });
  });

  it("clears everything with the star, a value that does not parse included", () => {
    expect(fenceOff(ALL, "*")).toEqual({ kind: "next", set: NONE });
    expect(fenceOff(names("pg-2"), "*")).toEqual({ kind: "next", set: NONE });
    expect(fenceOff({ kind: "unparseable", raw: "x" }, "*")).toEqual({ kind: "next", set: NONE });
  });

  it("refuses to lift one name under the star", () => {
    expect(fenceOff(ALL, "pg-2")).toEqual({ kind: "refused", reason: ALL_FENCED_LIFT_REASON });
  });

  it("changes nothing when there is nothing to lift", () => {
    expect(fenceOff(NONE, "*")).toEqual({ kind: "unchanged" });
    expect(fenceOff(NONE, "pg-2")).toEqual({ kind: "unchanged" });
    expect(fenceOff(names("pg-3"), "pg-2")).toEqual({ kind: "unchanged" });
  });
});

describe("the guards", () => {
  it("fences an instance of the cluster that is not fenced yet", () => {
    expect(canFenceInstance(cluster(), "pg-2").enabled).toBe(true);
    expect(canFenceInstance(cluster(), "other-1").reason).toBe("other-1 is not an instance of the cluster");
    expect(canFenceInstance(cluster({ fencedAnnotation: '["pg-2"]' }), "pg-2").reason).toBe("It is fenced already");
    expect(canFenceInstance(cluster({ fencedAnnotation: '["*"]' }), "pg-2").reason).toBe("It is fenced already");
    expect(canFenceInstance(cluster({ hibernated: true }), "pg-2").reason).toBe(HIBERNATED_FENCE_REASON);
  });

  it("fences all unless all are fenced, or the cluster sleeps", () => {
    expect(canFenceAll(cluster()).enabled).toBe(true);
    expect(canFenceAll(cluster({ fencedAnnotation: '["pg-2"]' })).enabled).toBe(true);
    expect(canFenceAll(cluster({ fencedAnnotation: '["*"]' })).reason).toBe("Every instance is fenced already");
    expect(canFenceAll(cluster({ hibernated: true })).reason).toBe(HIBERNATED_FENCE_REASON);
  });

  it("lifts one fence, but not under the star and not during a cold snapshot backup", () => {
    expect(canLiftInstance(cluster({ fencedAnnotation: '["pg-2"]' }), "pg-2", []).enabled).toBe(true);
    expect(canLiftInstance(cluster({ fencedAnnotation: '["pg-2"]' }), "pg-3", []).reason).toBe("It is not fenced");
    expect(canLiftInstance(cluster({ fencedAnnotation: '["*"]' }), "pg-2", []).reason).toBe(ALL_FENCED_LIFT_REASON);
    expect(canLiftInstance(cluster({ fencedAnnotation: '["pg-2"]' }), "pg-2", [COLD]).reason).toBe(
      COLD_SNAPSHOT_LIFT_REASON,
    );
  });

  it("lifts all fences, a value that does not parse included, but not during a cold snapshot backup", () => {
    expect(canLiftAll(cluster({ fencedAnnotation: '["*"]' }), []).enabled).toBe(true);
    expect(canLiftAll(cluster({ fencedAnnotation: "broken" }), []).enabled).toBe(true);
    expect(canLiftAll(cluster(), []).reason).toBe("No instance is fenced");
    expect(canLiftAll(cluster({ fencedAnnotation: '["*"]' }), [COLD]).reason).toBe(COLD_SNAPSHOT_LIFT_REASON);
  });

  it("knows a cold snapshot backup that is running from every other backup", () => {
    expect(coldSnapshotRunning([COLD])).toBe(COLD);
    expect(coldSnapshotRunning([{ ...COLD, phase: "completed" }])).toBeUndefined();
    expect(coldSnapshotRunning([{ ...COLD, phase: "failed" }])).toBeUndefined();
    expect(coldSnapshotRunning([{ ...COLD, phase: undefined }])).toBeUndefined();
    expect(coldSnapshotRunning([{ ...COLD, online: true }])).toBeUndefined();
    expect(coldSnapshotRunning([{ ...COLD, online: undefined }])).toBeUndefined();
    expect(coldSnapshotRunning([{ ...COLD, method: "plugin" }])).toBeUndefined();
  });
});

describe("the patch", () => {
  it("carries the resource version and the serialized value, or null to remove the key", () => {
    expect(fencingPatch(cluster(), names("pg-2"))).toEqual({
      metadata: { resourceVersion: "42", annotations: { "cnpg.io/fencedInstances": '["pg-2"]' } },
    });
    expect(fencingPatch(cluster(), NONE)).toEqual({
      metadata: { resourceVersion: "42", annotations: { "cnpg.io/fencedInstances": null } },
    });
  });
});

describe("the dialogs", () => {
  it("spells the old and the new value, and asks for the name before fencing", () => {
    const facts = fencingDialogFacts(cluster({ fencedAnnotation: '["pg-3"]' }), { kind: "fence", instance: "pg-2" });

    expect(facts.subject).toBe("Cluster db/pg");
    expect(facts.typedName).toBe("pg");
    expect(facts.writes).toEqual([
      {
        verb: "patch",
        text: 'patch Cluster db/pg: annotation cnpg.io/fencedInstances ["pg-3"] -> ["pg-2","pg-3"]',
      },
    ]);
    expect(facts.notes[0]).toContain("The pod of pg-2 stays and PostgreSQL is shut down in it");
    expect(facts.warnings).toEqual([]);
  });

  it("warns that writes stop and nothing fails over when the primary is fenced, alone or with all", () => {
    const primary = fencingDialogFacts(cluster(), { kind: "fence", instance: "pg-1" });
    const all = fencingDialogFacts(cluster(), { kind: "fence", instance: "*" });

    expect(primary.warnings).toEqual([
      "Writes stop and no failover happens while the primary is fenced: that is what fencing is for.",
    ]);
    expect(all.warnings).toEqual(primary.warnings);
    expect(all.writes[0].text).toBe('patch Cluster db/pg: annotation cnpg.io/fencedInstances (unset) -> ["*"]');
  });

  it("warns when required synchronous replication needs the standby", () => {
    const synchronous = (dataDurability?: "required" | "preferred", number = 2) =>
      cluster({ spec: { postgresql: { synchronous: { number, dataDurability } } } });

    expect(fencingDialogFacts(synchronous("required"), { kind: "fence", instance: "pg-2" }).warnings).toEqual([
      "Synchronous replication is required with 2 standbys: without pg-2 the cluster has 1, and writes wait until the fence is lifted.",
    ]);
    expect(fencingDialogFacts(synchronous(undefined), { kind: "fence", instance: "pg-2" }).warnings).toHaveLength(1);
    expect(fencingDialogFacts(synchronous("preferred"), { kind: "fence", instance: "pg-2" }).warnings).toEqual([]);
    expect(fencingDialogFacts(synchronous("required", 1), { kind: "fence", instance: "pg-2" }).warnings).toEqual([]);
    // A standby that is fenced already cannot acknowledge a write either.
    expect(
      fencingDialogFacts(
        { ...synchronous("required", 1), fencedAnnotation: '["pg-3"]' },
        { kind: "fence", instance: "pg-2" },
      ).warnings,
    ).toHaveLength(1);
  });

  it("lifts with one click, and removes the key with the last fence", () => {
    const facts = fencingDialogFacts(cluster({ fencedAnnotation: '["pg-2"]' }), { kind: "lift", instance: "pg-2" });

    expect(facts.typedName).toBeUndefined();
    expect(facts.writes[0].text).toBe('patch Cluster db/pg: annotation cnpg.io/fencedInstances ["pg-2"] -> (unset)');
    expect(facts.notes).toEqual(["The instance manager of pg-2 starts PostgreSQL again, and the pod turns ready."]);
  });

  it("says that a value that does not parse fences nobody, and removes it", () => {
    const facts = fencingDialogFacts(cluster({ fencedAnnotation: "broken" }), { kind: "lift", instance: "*" });

    expect(facts.writes[0].text).toBe("patch Cluster db/pg: annotation cnpg.io/fencedInstances broken -> (unset)");
    expect(facts.notes[1]).toBe("The value does not parse, so nobody is fenced today: this removes it.");
  });

  it("lists no write when nothing would change", () => {
    expect(
      fencingDialogFacts(cluster({ fencedAnnotation: '["*"]' }), { kind: "fence", instance: "pg-2" }).writes,
    ).toEqual([]);
    expect(fencingDialogFacts(cluster(), { kind: "lift", instance: "*" }).writes).toEqual([]);
    expect(
      fencingDialogFacts(cluster({ fencedAnnotation: '["*"]' }), { kind: "lift", instance: "pg-2" }).writes,
    ).toEqual([]);
  });
});
