import React from "react";
import { createRoot } from "react-dom/client";
import KalibriDashboard from "../KalibriDashboard.jsx";
import AuthGate from "./AuthGate.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <KalibriDashboard />
    </AuthGate>
  </React.StrictMode>
);
