import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import CreatorPage from "./pages/CreatorPage";
import TrafficSheet from "./pages/TrafficSheet";
import PartnerDetail from "./pages/PartnerDetail";
import PartnerManage from "./pages/PartnerManage";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<TrafficSheet />} />
          <Route path="manage" element={<PartnerManage />} />
          <Route path="partners/:id" element={<PartnerDetail />} />
          <Route path="creators/:slug" element={<CreatorPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
