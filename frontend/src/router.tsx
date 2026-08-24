import { lazy } from "react";
import { createBrowserRouter, Navigate, useLocation } from "react-router-dom";
import { RouteError } from "@/components/common/RouteError";
import { Layout } from "@/components/layout/Layout";

/** Old /ovlab bookmarks land on /derivatives. */
function OvlabRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/derivatives${search}`} replace />;
}

// Heavy pages load on demand; Suspense boundary lives in Layout around <Outlet />.
const AShare = lazy(() => import("@/pages/AShare").then((m) => ({ default: m.AShare })));
const Portfolio = lazy(() => import("@/pages/Portfolio").then((m) => ({ default: m.Portfolio })));
const Ovlab = lazy(() => import("@/pages/DerivCockpit").then((m) => ({ default: m.DerivCockpit })));
const Arb = lazy(() => import("@/pages/ArbCockpit").then((m) => ({ default: m.ArbCockpit })));
const Event = lazy(() => import("@/pages/EventCockpit").then((m) => ({ default: m.EventCockpit })));
const Dxx = lazy(() => import("@/pages/DxxCockpit").then((m) => ({ default: m.DxxCockpit })));
const UsMarket = lazy(() => import("@/pages/UsMarket").then((m) => ({ default: m.UsMarket })));
const Settings = lazy(() => import("@/pages/Settings").then((m) => ({ default: m.Settings })));
const AiWatch = lazy(() => import("@/pages/AiWatch").then((m) => ({ default: m.AiWatch })));
const FinWindow = lazy(() => import("@/pages/FinWindow").then((m) => ({ default: m.FinWindow })));
const Research = lazy(() => import("@/pages/Research").then((m) => ({ default: m.Research })));
const Backtest = lazy(() => import("@/pages/Backtest").then((m) => ({ default: m.Backtest })));
const Data = lazy(() => import("@/pages/Data").then((m) => ({ default: m.Data })));

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { path: "/", element: <Navigate to="/a-share" replace /> },
          { path: "/a-share", element: <AShare /> },
          { path: "/portfolio", element: <Portfolio /> },
          { path: "/derivatives", element: <Ovlab /> },
          { path: "/arb", element: <Arb /> },
          { path: "/event", element: <Event /> },
          { path: "/dxx", element: <Dxx /> },
          { path: "/ovlab", element: <OvlabRedirect /> },
          { path: "/us-market", element: <UsMarket /> },
          { path: "/research", element: <Research /> },
          { path: "/backtest", element: <Backtest /> },
          { path: "/data", element: <Data /> },
          { path: "/ai-watch", element: <AiWatch /> },
          { path: "/fin", element: <FinWindow /> },
          { path: "/settings", element: <Settings /> },
        ],
      },
    ],
  },
]);
