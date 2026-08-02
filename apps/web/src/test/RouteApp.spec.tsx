// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteApp } from "../RouteApp";

describe("RouteApp", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ cards: [], nextCursor: null }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the public application at the root", () => {
    render(<RouteApp pathname="/" />);
    expect(screen.getByRole("heading", { name: "每天一点新知识" })).toBeInTheDocument();
  });

  it("renders the private dashboard at the admin route", () => {
    render(<RouteApp pathname="/admin" />);
    expect(screen.getByRole("heading", { name: "采集运行状态" })).toBeInTheDocument();
  });

  it("renders a not-found view for unknown routes", () => {
    render(<RouteApp pathname="/missing" />);
    expect(screen.getByRole("heading", { name: "页面不存在" })).toBeInTheDocument();
  });
});
