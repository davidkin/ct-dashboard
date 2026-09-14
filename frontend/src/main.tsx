import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./App";
import { ModelProvider } from "./hooks/useModel";
import Analytics from "./pages/Analytics";
import CreatorPage from "./pages/CreatorPage";
import Glossary from "./pages/Glossary";
import PartnerDetail from "./pages/PartnerDetail";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <ModelProvider>
        <Routes>
          <Route element={<App />}>
            <Route index element={<Analytics />} />
            {/* Старая страница «Трафик» больше не актуальна: старые ссылки ведём на Аналитику. */}
            <Route path="traffic" element={<Navigate to="/" replace />} />
            <Route path="glossary" element={<Glossary />} />
            <Route path="partners/:id" element={<PartnerDetail />} />
            <Route path="creators/:slug" element={<CreatorPage />} />
          </Route>
        </Routes>
      </ModelProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
