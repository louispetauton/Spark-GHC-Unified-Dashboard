import React from "react";
import { createRoot } from "react-dom/client";
import UnifiedDashboard from "../UnifiedDashboard.jsx";
import AuthGate from "./AuthGate.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <UnifiedDashboard />
    </AuthGate>
  </React.StrictMode>
);
