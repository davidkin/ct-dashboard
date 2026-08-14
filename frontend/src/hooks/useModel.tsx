import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchModels, isExportConfigured, type ModelOption } from "../api";

/**
 * Выбранная модель — глобальный фильтр всех экранов (Velora / Lily).
 * Пустая строка = все модели. Выбор переживает перезагрузку (localStorage)
 * и синхронизирован с ?model= в URL, чтобы ссылкой можно было делиться.
 */
const STORAGE_KEY = "couture-model-v1";

interface ModelCtx {
  model: string;
  setModel: (m: string) => void;
  models: ModelOption[];
  label: string;
}

const Ctx = createContext<ModelCtx>({ model: "", setModel: () => {}, models: [], label: "Все модели" });

function initialModel(): string {
  if (typeof window === "undefined") return "";
  const fromUrl = new URLSearchParams(window.location.search).get("model");
  if (fromUrl !== null) return fromUrl;
  return window.localStorage.getItem(STORAGE_KEY) ?? "";
}

export function ModelProvider({ children }: { children: ReactNode }) {
  const [model, setModel] = useState<string>(initialModel);
  const [models, setModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    if (!isExportConfigured()) return;
    fetchModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, model);
    /* URL держим в актуальном состоянии, но без записи в историю переходов */
    const url = new URL(window.location.href);
    if (model) url.searchParams.set("model", model);
    else url.searchParams.delete("model");
    window.history.replaceState(null, "", url.toString());
  }, [model]);

  const value = useMemo<ModelCtx>(() => {
    const label = models.find((m) => m.group === model)?.label ?? "Все модели";
    return { model, setModel, models, label };
  }, [model, models]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useModel(): ModelCtx {
  return useContext(Ctx);
}
