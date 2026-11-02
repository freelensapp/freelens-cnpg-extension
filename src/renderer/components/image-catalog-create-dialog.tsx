/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Create ImageCatalog and Create ClusterImageCatalog (SPEC-0032): the host
// wiring around `image-catalog-create.ts`. It reads the catalogs of the kind
// on open, asks the API server whether the account may create one (W3) and
// sends the one `create` whose YAML the user read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ClusterImageCatalog, ImageCatalog } from "../api/cnpg/image-catalog-v1";
import { accessGuard, sharedAccessReviews } from "./access-review";
import { createActionDialogModel } from "./action-dialog";
import { Field, KeyValueEditor, openCreateDialog, createDialogStyles as styles, TextField } from "./create-dialog";
import { defaultNamespace, toYaml } from "./create-forms";
import {
  CATALOG_IMAGES_MAX,
  catalogBlockReason,
  catalogBody,
  catalogErrors,
  catalogFacts,
  catalogSuccessMessage,
  catalogWarnings,
  defaultCatalogForm,
  emptyCatalogInputs,
} from "./image-catalog-create";
import { COMMON_FIELDS, prefixFieldOf } from "./server-check";
import { apiFailureFacts, failureSentence, isAlreadyExists } from "./write-actions";

import type { CatalogKind } from "../api/cnpg/image-catalog-v1";
import type { ActionDialogModel } from "./action-dialog";
import type { KeyValue } from "./create-forms";
import type { CatalogForm, CatalogInputs } from "./image-catalog-create";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, NamespaceSelect, Notifications },
  K8sApi: { namespaceStore },
  Navigation: { getDetailsUrl },
} = Renderer;

const TEST_IDS: Record<CatalogKind, string> = {
  ImageCatalog: "cnpg-create-image-catalog",
  ClusterImageCatalog: "cnpg-create-cluster-image-catalog",
};

const TITLES: Record<CatalogKind, string> = {
  ImageCatalog: "Create image catalog",
  ClusterImageCatalog: "Create cluster image catalog",
};

const RESOURCES: Record<CatalogKind, string> = {
  ImageCatalog: "imagecatalogs",
  ClusterImageCatalog: "clusterimagecatalogs",
};

interface CatalogCreateModel extends ActionDialogModel {
  form: CatalogForm;
  inputs: CatalogInputs;
  accessReason?: string;
}

interface NamedLike {
  getName(): string;
}

function createModel(kind: CatalogKind, namespace: string): CatalogCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultCatalogForm(kind, namespace),
      inputs: emptyCatalogInputs(),
      accessReason: undefined,
    },
    { inputs: Mobx.observableRef },
  );
}

function update(model: CatalogCreateModel, patch: Partial<CatalogForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

function api(kind: CatalogKind) {
  return kind === "ImageCatalog"
    ? ImageCatalog.getStore<ImageCatalog>().api
    : ClusterImageCatalog.getStore<ClusterImageCatalog>().api;
}

function loadCatalogs(model: CatalogCreateModel): void {
  const { kind, namespace } = model.form;
  if (kind === "ImageCatalog" && namespace === "") return;
  Mobx.runInAction(() => {
    model.inputs = { catalogs: [], reads: { catalogs: "loading" } };
  });
  const listed = (kind === "ImageCatalog" ? api(kind).list({ namespace }) : api(kind).list()) as Promise<
    NamedLike[] | null
  >;
  void listed.then(
    (items) =>
      Mobx.runInAction(() => {
        model.inputs = { catalogs: (items ?? []).map((item) => item.getName()), reads: { catalogs: "ready" } };
      }),
    () =>
      Mobx.runInAction(() => {
        model.inputs = { catalogs: [], reads: { catalogs: "unavailable" } };
      }),
  );
}

function askAccess(model: CatalogCreateModel): void {
  const { kind, namespace } = model.form;
  if (kind === "ImageCatalog" && namespace === "") return;
  const question = { verb: "create" as const, group: "postgresql.cnpg.io", resource: RESOURCES[kind], namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

const CatalogCreateForm = observer(({ model }: { model: CatalogCreateModel }) => {
  const { form, inputs } = model;
  const testId = TEST_IDS[form.kind];
  const errors = catalogErrors(inputs, form);
  const warnings = catalogWarnings(form);
  const rowWarnings = Object.values(warnings);
  return (
    <>
      {form.kind === "ImageCatalog" ? (
        <Field label="Namespace" error={errors.namespace} testId={`${testId}-namespace`}>
          <NamespaceSelect
            id={`${testId}-namespace-select`}
            themeName="lens"
            menuClass={styles.selectMenu}
            value={form.namespace || null}
            onChange={(option: { value: string } | null) => {
              update(model, { namespace: option?.value ?? "" });
              loadCatalogs(model);
              askAccess(model);
            }}
          />
        </Field>
      ) : null}
      <TextField
        label="Name"
        value={form.name}
        onChange={(name) => update(model, { name })}
        placeholder="postgresql"
        inputTestId={`${testId}-name`}
        testId={`${testId}-name-field`}
        hint={
          form.kind === "ImageCatalog"
            ? "Clusters of this namespace refer to the catalog by this name."
            : "Clusters of every namespace refer to the catalog by this name."
        }
        error={errors.name}
      />
      <Field
        label="Images"
        hint={`One image per PostgreSQL major (${CATALOG_IMAGES_MAX} at most): the major a cluster asks for, and the image it runs then. The tag starts with the PostgreSQL version.`}
        error={
          errors.images && !Object.keys(errors).some((key) => key.startsWith("images.")) ? errors.images : undefined
        }
        warning={rowWarnings.length > 0 ? rowWarnings.join(". ") : undefined}
        testId={`${testId}-images-field`}
      >
        <KeyValueEditor
          rows={form.images.map((row) => ({ key: row.major, value: row.image }))}
          onChange={(rows: KeyValue[]) =>
            update(model, { images: rows.map((row) => ({ major: row.key, image: row.value })) })
          }
          errors={(index) => ({ key: errors[`images.${index}.major`], value: errors[`images.${index}.image`] })}
          keyPlaceholder="17"
          valuePlaceholder="ghcr.io/cloudnative-pg/postgresql:17.5-standard-trixie"
          addLabel="Add an image"
          testId={`${testId}-images`}
        />
      </Field>
    </>
  );
});

function open(model: CatalogCreateModel, delayed: boolean, changedNotice?: string): void {
  const { kind } = model.form;
  const kindClass = kind === "ImageCatalog" ? ImageCatalog : ClusterImageCatalog;
  openCreateDialog(
    {
      title: TITLES[kind],
      testId: TEST_IDS[kind],
      facts: () => catalogFacts(model.form),
      form: () => <CatalogCreateForm model={model} />,
      yaml: () => toYaml(catalogBody(model.form)),
      server: {
        apiBase: kindClass.apiBase,
        namespace: () => (kind === "ImageCatalog" ? model.form.namespace : undefined),
        body: () => catalogBody(model.form),
        fieldOf: prefixFieldOf([...COMMON_FIELDS, ["spec.images", "Images"]]),
      },
      blockReason: () => catalogBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: async () => {
        const { name, namespace } = model.form;
        const body = catalogBody(model.form);
        const attempted = {
          verb: "create" as const,
          resource: RESOURCES[kind],
          namespace: kind === "ImageCatalog" ? namespace : "the cluster",
        };
        try {
          const created =
            kind === "ImageCatalog"
              ? await ImageCatalog.getStore<ImageCatalog>().create({ name, namespace }, body as never)
              : await ClusterImageCatalog.getStore<ClusterImageCatalog>().create({ name }, body as never);
          const url = created?.selfLink ? getDetailsUrl(created.selfLink) : undefined;
          Notifications.ok(
            <span>
              {catalogSuccessMessage(model.form)}
              {url ? (
                <>
                  {" "}
                  <MaybeLink to={url}>Open it</MaybeLink>
                </>
              ) : null}
            </span>,
          );
        } catch (error) {
          const failure = apiFailureFacts(error);
          const notice = isAlreadyExists(failure)
            ? `A catalog named ${name} appeared in the meantime: pick another name.`
            : failureSentence(failure, attempted);
          loadCatalogs(model);
          open(model, true, notice);
        }
      },
    },
    model,
    delayed,
  );
}

/** Opens Create ImageCatalog or Create ClusterImageCatalog, from the floating button of its list. */
export function openCreateCatalogDialog(kind: CatalogKind): void {
  const namespace = defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(kind, namespace);
  loadCatalogs(model);
  askAccess(model);
  open(model, false);
}
