import React from "react";
import { createRoot } from "react-dom/client";
import KalibriDashboard from "../KalibriDashboard.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <KalibriDashboard />
  </React.StrictMode>
);
