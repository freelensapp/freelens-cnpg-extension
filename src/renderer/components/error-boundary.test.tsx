// @vitest-environment jsdom

/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common, type Renderer } from "@freelensapp/extensions";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorBoundary,
  withDetailsErrorBoundary,
  withMenuItemErrorBoundary,
  withPageErrorBoundary,
} from "./error-boundary";
import { withErrorPage } from "./error-page";

// A minimal stub extension - only `name` is read by the boundary.
const extension = { name: "@freelensapp/cnpg-extension" } as Renderer.LensExtension;

beforeEach(() => {
  // React reports an error that a boundary caught on the console as well.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const Throws = ({ message = "boom" }: { message?: string }): React.JSX.Element => {
  throw new Error(message);
};

// A child that throws only for some objects, as a details panel does for an object without a field it reads.
const ThrowsFor = ({ object }: { object: { broken: boolean } }) => {
  if (object.broken) throw new Error("broken object");
  return <p>fine object</p>;
};

describe("ErrorBoundary", () => {
  it("renders the error page in place of a child that throws, logs it, and leaves its siblings rendered", () => {
    render(
      <>
        <p>before</p>
        <ErrorBoundary extension={extension}>
          <p>inside</p>
          <Throws />
        </ErrorBoundary>
        <p>after</p>
      </>,
    );

    expect(screen.getByText("Error: boom")).toBeDefined();
    expect(screen.queryByText("inside")).toBeNull();
    expect(screen.getByText("before")).toBeDefined();
    expect(screen.getByText("after")).toBeDefined();
    expect(Common.logger.error).toHaveBeenCalledTimes(1);
    expect(Common.logger.error).toHaveBeenCalledWith("[@freelensapp/cnpg-extension]: Error: boom", expect.any(String));
  });

  it("renders nothing in place of a child that throws with the fallback nothing, and logs it", () => {
    render(
      <ul>
        <li>Edit</li>
        <ErrorBoundary extension={extension} fallback="nothing">
          <li>Suspend</li>
          <Throws message="menu item" />
        </ErrorBoundary>
        <li>Delete</li>
      </ul>,
    );

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Edit", "Delete"]);
    expect(Common.logger.error).toHaveBeenCalledWith(
      "[@freelensapp/cnpg-extension]: Error: menu item",
      expect.any(String),
    );
  });

  it("renders its children without an error", () => {
    render(
      <ErrorBoundary extension={extension}>
        <p>inside</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("inside")).toBeDefined();
    expect(Common.logger.error).not.toHaveBeenCalled();
  });

  it("renders the children again for a new reset key", () => {
    const broken = { broken: true };
    const fixed = { broken: false };
    const { rerender } = render(
      <ErrorBoundary extension={extension} resetKey={broken}>
        <ThrowsFor object={broken} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Error: broken object")).toBeDefined();

    rerender(
      <ErrorBoundary extension={extension} resetKey={fixed}>
        <ThrowsFor object={fixed} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("fine object")).toBeDefined();
    expect(screen.queryByText("Error: broken object")).toBeNull();
  });
});

describe("the registration wrappers", () => {
  it("keep an error of a page inside the page", () => {
    const { Page } = withPageErrorBoundary(extension, {
      id: "broken",
      components: { Page: () => <Throws /> },
    }).components;

    render(
      <>
        <Page params={{}} />
        <p>sidebar</p>
      </>,
    );

    expect(screen.getByText("Error: boom")).toBeDefined();
    expect(screen.getByText("sidebar")).toBeDefined();
  });

  // A `try`/`catch` around the call of the page, as `withErrorPage` is, does not see an error of a child component:
  // the child renders after the call returned. The boundary keeps it inside the page.
  it("keep an error that a child component of the page throws inside the page, which withErrorPage does not", () => {
    const Page = () =>
      withErrorPage({ extension }, () => (
        <section>
          <h1>Clusters</h1>
          <Throws message="a row without a field" />
        </section>
      ));

    expect(() => render(<Page />)).toThrow("a row without a field");
    cleanup();

    const Wrapped = withPageErrorBoundary(extension, { id: "clusters", components: { Page } }).components.Page;

    render(
      <>
        <Wrapped params={{}} />
        <p>sidebar</p>
      </>,
    );

    expect(screen.getByText("Error: a row without a field")).toBeDefined();
    expect(screen.getByText("sidebar")).toBeDefined();
    expect(Common.logger.error).toHaveBeenCalledWith(
      "[@freelensapp/cnpg-extension]: Error: a row without a field",
      expect.any(String),
    );
  });

  it("keep an error of a details panel inside the panel, and render it again for a new object", () => {
    const { Details } = withDetailsErrorBoundary(extension, {
      kind: "Cluster",
      apiVersions: ["postgresql.cnpg.io/v1"],
      components: { Details: ThrowsFor },
    }).components;

    const { rerender } = render(
      <>
        <Details object={{ broken: true }} />
        <p>other panel</p>
      </>,
    );

    expect(screen.getByText("Error: broken object")).toBeDefined();
    expect(screen.getByText("other panel")).toBeDefined();

    rerender(
      <>
        <Details object={{ broken: false }} />
        <p>other panel</p>
      </>,
    );

    expect(screen.getByText("fine object")).toBeDefined();
  });

  it("render nothing for a menu item that throws, and leave the other items rendered", () => {
    const { MenuItem } = withMenuItemErrorBoundary(extension, {
      kind: "Cluster",
      apiVersions: ["postgresql.cnpg.io/v1"],
      components: { MenuItem: () => <Throws message="menu item" /> },
    }).components;

    render(
      <ul>
        <li>Edit</li>
        <MenuItem object={{}} />
        <li>Delete</li>
      </ul>,
    );

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Edit", "Delete"]);
    expect(screen.queryByText(/menu item/)).toBeNull();
    expect(Common.logger.error).toHaveBeenCalledWith(
      "[@freelensapp/cnpg-extension]: Error: menu item",
      expect.any(String),
    );
  });
});
