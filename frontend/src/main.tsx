import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { router } from "./router";
import "./fonts.css";
import "./index.css";

document.documentElement.classList.add("dark");
document.documentElement.classList.remove("light");

// Cockpit polls every 1-5s. RR7 startTransition nav can starve; keep clicks sync.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} useTransitions={false} />
      <Toaster position="bottom-right" theme="dark" richColors closeButton duration={3500} />
    </ErrorBoundary>
  </StrictMode>
);
