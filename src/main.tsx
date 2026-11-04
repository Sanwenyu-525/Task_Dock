import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorHandlers } from "./lib/globalErrors";
import { initLocale } from "./i18n";
import "./styles.css";
import "./styles-themes.css";
import "./styles-ui.css";
import "./components/global-search/global-search.css";

initLocale();
installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="主窗口">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
