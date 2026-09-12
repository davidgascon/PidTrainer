import React from "react";
import { createRoot } from "react-dom/client";

// Fonts are bundled rather than fetched from Google. Building automation
// networks are frequently isolated, and a webfont that silently fails to
// load makes the whole thing look broken.
import "@fontsource/barlow-semi-condensed/500.css";
import "@fontsource/barlow-semi-condensed/600.css";
import "@fontsource/barlow-semi-condensed/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";

import App from "./PidTrainer.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
