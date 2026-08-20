import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProtocolStudio } from "../app/studio";
import "../app/globals.css";

// React 严格模式可以在开发阶段提前发现不安全的副作用和状态逻辑。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ProtocolStudio />
  </StrictMode>,
);
