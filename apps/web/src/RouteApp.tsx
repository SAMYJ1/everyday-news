import { App } from "./App";
import { PublicApp } from "./PublicApp";

function NotFound() {
  return <main className="not-found">
    <section>
      <p className="eyebrow">Everyday News</p>
      <h1>页面不存在</h1>
      <p>这个地址没有对应的页面。</p>
      <a href="/">返回公开首页</a>
    </section>
  </main>;
}

export function RouteApp({
  pathname = typeof window === "undefined" ? "/" : window.location.pathname,
}: {
  pathname?: string;
}) {
  if (pathname === "/") return <PublicApp />;
  if (pathname === "/admin" || pathname === "/admin/") return <App />;
  return <NotFound />;
}
