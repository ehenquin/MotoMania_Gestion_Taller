"use strict";
const $ = (s) => document.querySelector(s),
  esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const state = {
  token: "",
  db: {},
  view: "dashboard",
  loading: false,
  galleryRequest: 0,
  activeOrderId: "",
  paymentOrderContextId: "",
  photoSources: new Map(),
  photoRequests: new Map(),
  galleryAbortController: null,
  cashFilter: { period: "month", start: "", end: "" },
  orderFilter: "",
  quick: null,
  photoQueues: new Map(),
  navStack: [],
  currentScreen: { kind: "view", view: "dashboard" },

  // SERVICIOS - Tabla compacta
  serviceSort: "alpha",
  serviceQuery: "",
};
const PHOTO_UPLOAD_CONCURRENCY = 2;

function sameScreen(a, b) {
  return a?.kind === b?.kind && a?.id === b?.id && a?.view === b?.view && a?.table === b?.table;
}
function rememberScreen(next) {
  if (!sameScreen(state.currentScreen, next)) {
    if (!sameScreen(state.navStack[state.navStack.length - 1], state.currentScreen))
      state.navStack.push({ ...state.currentScreen });
    state.currentScreen = { ...next };
  }
}
function goBack(fallback = { kind: "view", view: "Ordenes_Trabajo" }) {
  const target = state.navStack.pop() || fallback;
  state.currentScreen = target;
  if (target.kind === "order") return orderDetail(target.id, false);
  if (target.kind === "customer") return customerDetail(target.id, false);
  if (target.kind === "moto") return motoDetail(target.id, false);
  if (target.kind === "form") return form(target.table, target.id, target.preset || {}, false, target.orderId || "");
  state.view = target.view || fallback.view;
  render();
}
function openOrderEditForm(table, id, orderId) {
  if (!id || !orderId) return;
  form(table, id, {}, true, orderId);
}
function orderEditFields(table) {
  const allowed = {
    Clientes: ["Nombre", "Telefono", "WhatsApp", "DNI", "Domicilio", "Observaciones"],
    Motos: ["Patente", "Marca", "Modelo", "Cilindrada", "Anio", "Color", "Chasis", "Observaciones"],
    Ordenes_Trabajo: ["Kilometraje", "Problema", "Diagnostico", "FechaPrometida", "Observaciones"],
  };
  return allowed[table] || defs[table]?.fields || [];
}
const PHOTO_GALLERY_CONCURRENCY = 3;
const PHOTO_SOURCE_CACHE_LIMIT = 24;
const defs = {
  Clientes: {
    title: "Clientes",
    fields: ["Nombre", "WhatsApp", "DNI", "Domicilio", "Observaciones"],
    required: ["Nombre"],
  },
  Motos: {
    title: "Motos",
    fields: [
      "IDCliente",
      "Patente",
      "Marca",
      "Modelo",
      "Cilindrada",
      "Anio",
      "Color",
      "Chasis",
      "Observaciones",
    ],
    required: ["IDCliente", "Patente", "Marca", "Modelo"],
  },
  Ordenes_Trabajo: {
    title: "Órdenes de trabajo",
    fields: [
      "IDMoto",
      "Kilometraje",
      "Problema",
      "Diagnostico",
      "Estado",
      "FechaPrometida",
      "FechaEntrega",
      "Observaciones",
      "Descuento",
    ],
    required: ["IDMoto", "Problema"],
  },
  Detalle_Trabajo: {
    title: "Conceptos",
    fields: ["IDOrden", "Tipo", "Descripcion", "Cantidad", "PrecioUnitario"],
    required: ["IDOrden", "Tipo", "Descripcion", "Cantidad", "PrecioUnitario"],
  },
  Pagos: {
    title: "Cobros",
    fields: ["IDOrden", "Fecha", "Importe", "Medio", "Observaciones"],
    required: ["IDOrden", "Importe", "Medio"],
  },
  Servicios: {
    title: "Servicios",
    fields: ["Nombre", "PrecioSugerido", "Activo"],
    required: ["Nombre"],
  },
  Repuestos: {
    title: "Repuestos",
    fields: ["Codigo", "Descripcion", "Costo", "PrecioVenta", "Activo"],
    required: ["Descripcion"],
  },
};
function toast(m) {
  const n = $("#notice");
  n.textContent = m;
  n.classList.add("show");
  setTimeout(() => n.classList.remove("show"), 4500);
}
let activeAppModal = null;
function showAppModal({
  title,
  message,
  confirmText = "Entendido",
  cancelText = "",
  danger = false,
} = {}) {
  if (activeAppModal) activeAppModal.close(false);
  const opener = document.activeElement;
  const labelId = `app-modal-title-${Date.now()}`;
  const descriptionId = `app-modal-description-${Date.now()}`;
  const overlay = document.createElement("div");
  const dialog = document.createElement("section");
  const heading = document.createElement("h2");
  const description = document.createElement("p");
  const actions = document.createElement("div");
  const confirmButton = document.createElement("button");
  const cancelButton = cancelText ? document.createElement("button") : null;

  overlay.className = "app-modal-overlay";
  dialog.className = `app-modal${danger ? " is-danger" : ""}`;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", labelId);
  dialog.setAttribute("aria-describedby", descriptionId);
  heading.id = labelId;
  heading.textContent = title || "Aviso";
  description.id = descriptionId;
  description.textContent = message || "";
  actions.className = "app-modal-actions";
  confirmButton.className = "app-modal-confirm";
  confirmButton.type = "button";
  confirmButton.textContent = confirmText;
  if (cancelButton) {
    cancelButton.className = "ghost app-modal-cancel";
    cancelButton.type = "button";
    cancelButton.textContent = cancelText;
    actions.append(cancelButton);
  }
  actions.append(confirmButton);
  dialog.append(heading, description, actions);
  overlay.append(dialog);

  return new Promise((resolve) => {
    let closed = false;
    const close = (result) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      document.body.classList.remove("modal-open");
      if (activeAppModal?.overlay === overlay) activeAppModal = null;
      if (opener instanceof HTMLElement) opener.focus();
      resolve(result);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = [...dialog.querySelectorAll("button:not([disabled])")];
      if (!buttons.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    activeAppModal = { overlay, close };
    cancelButton?.addEventListener("click", () => close(false));
    confirmButton.addEventListener("click", () => close(true));
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close(false);
    });
    document.body.classList.add("modal-open");
    document.body.append(overlay);
    document.addEventListener("keydown", onKeydown);
    (cancelButton || confirmButton).focus();
  });
}
function confirmModal(options) {
  return showAppModal(options);
}
function infoModal(title, message) {
  return showAppModal({ title, message, confirmText: "Entendido" });
}
function errorModal(title, message) {
  return showAppModal({ title, message, confirmText: "Cerrar", danger: true });
}
class SessionExpiredError extends Error {}
class ApiResponseError extends Error {
  constructor(message, { status = 0, retriable = false } = {}) {
    super(message);
    this.status = status;
    this.retriable = retriable;
  }
}
function isSessionError(message) {
  return /(?:sesión|session|token).*(?:expir|venc|inválid|invalid|no autoriz|unauthoriz)|(?:expir|venc|inválid|invalid|no autoriz|unauthoriz).*(?:sesión|session|token)/i.test(
    message || "",
  );
}
function setConnection(status = "online") {
  const el = $("#connectionStatus");
  if (!el) return;
  el.className = `connection${status === "loading" ? " is-loading" : status === "error" ? " is-error" : ""}`;
  el.innerHTML = `<i></i> ${status === "loading" ? "Actualizando…" : status === "error" ? "Sin conexión" : "En línea"}`;
}
function showLoading(message = "Preparando el panel…") {
  $("#content").innerHTML =
    `<div class="panel loading-state"><div><div class="spinner"></div><strong>${message}</strong><p>Estamos sincronizando la información del taller.</p></div></div>`;
}
function showLogin(message = "") {
  state.galleryAbortController?.abort();
  state.galleryAbortController = null;
  state.token = "";
  state.db = {};
  state.loading = false;
  state.photoSources.clear();
  state.photoRequests.clear();
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#logout").hidden = true;
  $("#refresh").hidden = true;
  $("#password").focus();
  setConnection("online");
  if (message) toast(message);
}
async function api(action, extra = {}, options = {}) {
  if (
    !window.MOTOMANIA_API_URL ||
    window.MOTOMANIA_API_URL.includes("PEGAR_AQUI")
  )
    throw Error("Configurá la URL de Apps Script en config.js");
  const started = performance.now();
  let res;
  try {
    res = await fetch(window.MOTOMANIA_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, token: state.token, ...extra }),
      redirect: "follow",
      signal: options.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (!options.background) setConnection("error");
    throw new ApiResponseError(
      "No se pudo conectar. Revisá tu conexión e intentá nuevamente.",
      { retriable: true },
    );
  }
  if (!res.ok) {
    const redirectedToGoogleContent = (() => {
      try {
        return new URL(res.url).hostname === "script.googleusercontent.com";
      } catch (_) {
        return false;
      }
    })();
    const retriable =
      res.status >= 500 || (redirectedToGoogleContent && res.status === 404);
    console.warn(`[MOTOMANÍA] ${action}: respuesta HTTP ${res.status}`, {
      finalUrl: res.url,
    });
    if (!options.background) setConnection("error");
    throw new ApiResponseError(
      retriable
        ? "La respuesta temporal de Google no estuvo disponible."
        : `Error de servidor (${res.status})`,
      { status: res.status, retriable },
    );
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    if (!options.background) setConnection("error");
    throw new ApiResponseError(
      "La respuesta del servidor no pudo procesarse. Intentá nuevamente.",
      { status: res.status, retriable: true },
    );
  }
  console.info(
    `[MOTOMANÍA] ${action}: ${(performance.now() - started).toFixed(0)} ms`,
  );
  if (!res.ok || !data || !data.ok) {
    const message = data?.error || `Error de servidor (${res.status})`;
    if (
      action !== "login" &&
      (res.status === 401 || res.status === 403 || isSessionError(message))
    )
      throw new SessionExpiredError(
        "Tu sesión venció o ya no es válida. Ingresá nuevamente.",
      );
    throw new ApiResponseError(message, { status: res.status });
  }
  setConnection("online");
  return data.data;
}
async function load() {
  if (state.loading) return;
  const tables = [
    "Clientes",
    "Motos",
    "Ordenes_Trabajo",
    "Detalle_Trabajo",
    "Pagos",
    "Movimientos_Caja",
    "Fotos",
    "Servicios",
    "Repuestos",
  ];
  state.loading = true;
  state.tableStatus = Object.fromEntries(
    tables.map((table) => [table, { status: "loading", error: null }]),
  );
  setConnection("loading");
  const started = performance.now();
  try {
    const db = await api("bootstrap");
    state.db = {
      ...db,
      Clientes: Array.isArray(db?.Clientes) ? db.Clientes : [],
      Motos: Array.isArray(db?.Motos) ? db.Motos : [],
      Ordenes_Trabajo: Array.isArray(db?.Ordenes_Trabajo)
        ? db.Ordenes_Trabajo
        : [],
      Detalle_Trabajo: Array.isArray(db?.Detalle_Trabajo)
        ? db.Detalle_Trabajo
        : [],
      Pagos: Array.isArray(db?.Pagos) ? db.Pagos : [],
      Movimientos_Caja: Array.isArray(db?.Movimientos_Caja)
        ? db.Movimientos_Caja
        : [],
      Fotos: Array.isArray(db?.Fotos) ? db.Fotos : [],
      Servicios: Array.isArray(db?.Servicios) ? db.Servicios : [],
      Repuestos: Array.isArray(db?.Repuestos) ? db.Repuestos : [],
    };
    state.tableStatus = Object.fromEntries(
      tables.map((table) => [
        table,
        {
          status: Array.isArray(db?.[table]) ? "loaded" : "unloaded",
          error: null,
        },
      ]),
    );
    $("#summary").textContent =
      `${state.db.Clientes.length} clientes · ${state.db.Motos.filter(motoIsActive).length} motos activas · ${state.db.Ordenes_Trabajo.length} órdenes`;
    render();
    const elapsed = performance.now() - started;
    $("#loadMetric").textContent =
      `Sincronizado en ${(elapsed / 1000).toFixed(1)} s`;
    console.info(`[MOTOMANÍA] bootstrap + render: ${elapsed.toFixed(0)} ms`);
  } catch (error) {
    state.tableStatus = Object.fromEntries(
      tables.map((table) => [
        table,
        { status: "error", error: error?.message || "Error de lectura" },
      ]),
    );
    throw error;
  } finally {
    state.loading = false;
  }
}
async function ensureTablesLoaded(tables, options = {}) {
  const knownTables = [
    "Clientes",
    "Motos",
    "Ordenes_Trabajo",
    "Detalle_Trabajo",
    "Pagos",
    "Movimientos_Caja",
    "Fotos",
    "Servicios",
    "Repuestos",
  ];
  if (!Array.isArray(tables))
    throw Error("Las tablas solicitadas deben indicarse en un arreglo.");
  const requested = [...new Set(tables)];
  const invalid = requested.filter((table) => !knownTables.includes(table));
  if (invalid.length)
    throw Error(`Tablas no operativas solicitadas: ${invalid.join(", ")}.`);

  const catalogTables = ["Servicios", "Repuestos"];
  const requestedCatalogs = requested.filter((table) =>
    catalogTables.includes(table),
  );
  const catalogEntries = requestedCatalogs.map((table) => ({
    table,
    status: state.tableStatus?.[table]?.status || "unloaded",
    error: state.tableStatus?.[table]?.error || "",
  }));
  const catalogErrors = catalogEntries.filter(
    (entry) => entry.status === "error",
  );
  const retryCatalogs = options.retry === true && catalogErrors.length > 0;
  if (catalogErrors.length && !retryCatalogs)
    throw Error(
      `Error al cargar las tablas: ${catalogErrors.map((entry) => `${entry.table}${entry.error ? ` (${entry.error})` : ""}`).join(", ")}.`,
    );
  const needsCatalogs =
    requestedCatalogs.some(
      (table) =>
        (state.tableStatus?.[table]?.status || "unloaded") === "unloaded",
    ) || retryCatalogs;
  const loadingCatalogs = requestedCatalogs.filter(
    (table) => state.tableStatus?.[table]?.status === "loading",
  );
  if (needsCatalogs || loadingCatalogs.length) {
    let request = ensureTablesLoaded.catalogRequest;
    if (!request) {
      if (loadingCatalogs.length)
        throw Error(
          `La carga de las tablas está en curso: ${loadingCatalogs.join(", ")}.`,
        );
      state.tableStatus ||= {};
      const requestStatus = {};
      catalogTables.forEach((table) => {
        const status = { status: "loading", error: null };
        state.tableStatus[table] = status;
        requestStatus[table] = status;
      });
      const isCurrentRequest = () =>
        catalogTables.every(
          (table) => state.tableStatus?.[table] === requestStatus[table],
        );
      request = (async () => {
        try {
          const catalogs = await api("loadCatalogs");
          if (
            !Array.isArray(catalogs?.Servicios) ||
            !Array.isArray(catalogs?.Repuestos)
          )
            throw Error("El servidor no devolvió catálogos válidos.");
          if (!isCurrentRequest()) return;
          state.db.Servicios = catalogs.Servicios;
          state.db.Repuestos = catalogs.Repuestos;
          catalogTables.forEach((table) => {
            state.tableStatus[table] = { status: "loaded", error: null };
          });
        } catch (error) {
          if (!isCurrentRequest()) return;
          const message =
            error?.message || "No se pudieron cargar los catálogos.";
          catalogTables.forEach((table) => {
            state.tableStatus[table] = { status: "error", error: message };
          });
          throw error;
        }
      })();
      ensureTablesLoaded.catalogRequest = request;
    }
    try {
      await request;
    } finally {
      if (ensureTablesLoaded.catalogRequest === request)
        ensureTablesLoaded.catalogRequest = null;
    }
  }

  const entries = requested.map((table) => ({
    table,
    status: state.tableStatus?.[table]?.status || "unloaded",
    error: state.tableStatus?.[table]?.error || "",
  }));
  const failed = entries.filter((entry) => entry.status === "error");
  if (failed.length)
    throw Error(
      `Error al cargar las tablas: ${failed.map((entry) => `${entry.table}${entry.error ? ` (${entry.error})` : ""}`).join(", ")}.`,
    );
  const loading = entries.filter((entry) => entry.status === "loading");
  if (loading.length)
    throw Error(
      `La carga de las tablas está en curso: ${loading.map((entry) => entry.table).join(", ")}.`,
    );
  const unloaded = entries.filter((entry) => entry.status !== "loaded");
  if (unloaded.length)
    throw Error(
      `Falta cargar las tablas: ${unloaded.map((entry) => entry.table).join(", ")}. La carga diferida todavía no está disponible.`,
    );
}
async function withSession(action) {
  try {
    return await action();
  } catch (err) {
    if (err instanceof SessionExpiredError) showLogin(err.message);
    else toast(err.message);
  }
}
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const submit = $("#loginSubmit"),
    started = performance.now();
  submit.disabled = true;
  setConnection("loading");
  try {
    const d = await api("login", { password: $("#password").value });
    if (!d?.token) throw Error("El servidor no devolvió una sesión válida.");
    state.token = d.token;
    $("#password").value = "";
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#logout").hidden = false;
    $("#refresh").hidden = false;
    showLoading("Acceso correcto. Cargando datos…");
    await load();
    console.info(
      `[MOTOMANÍA] ingreso completo: ${(performance.now() - started).toFixed(0)} ms`,
    );
  } catch (err) {
    state.token = "";
    setConnection("error");
    toast(err.message);
  } finally {
    submit.disabled = false;
  }
};
$("#togglePassword").onclick = () => {
  const input = $("#password"),
    visible = input.type === "text";
  input.type = visible ? "password" : "text";
  $("#togglePassword").setAttribute(
    "aria-label",
    visible ? "Mostrar contraseña" : "Ocultar contraseña",
  );
  $("#togglePassword").setAttribute(
    "title",
    visible ? "Mostrar contraseña" : "Ocultar contraseña",
  );
  $("#togglePassword").setAttribute("aria-pressed", String(!visible));
  input.focus();
};
$("#logout").onclick = () => showLogin();
$("#refresh").onclick = () => withSession(load);
$("#nav").onclick = async (e) => {
  const b = e.target.closest("[data-view]");
  if (b) {
    if (state.view === "intake" && state.intake) {
      captureIntake();
      persistIntake();
      const leave = await confirmModal({
        title: "¿Salir del nuevo ingreso?",
        message:
          "El borrador se conservará, pero las fotografías seleccionadas solo permanecen mientras esta página siga abierta.",
        cancelText: "Seguir cargando",
        confirmText: "Guardar y salir",
      });
      if (!leave) return;
    }
    if (state.view === "quickIntake" && state.quick) {
      if (state.quick.saving)
        return toast("Esperá que termine de guardarse el ingreso.");
      quickCapture();
      const leave = await confirmModal({
        title: "¿Salir del ingreso sin guardar?",
        message:
          "Se descartarán los datos de este ingreso rápido que todavía no fueron guardados.",
        cancelText: "Seguir con el ingreso",
        confirmText: "Salir sin guardar",
        danger: true,
      });
      if (!leave) return;
      state.quick = null;
    }
    state.view = b.dataset.view;
    state.navStack = [];
    state.orderFilter = "";
    document.querySelector(".nav-more")?.removeAttribute("open");
    render();
  }
};
window.addEventListener("beforeunload", (event) => {
  const photosPending = [...state.photoQueues.values()].some((queue) => queue.some((item) => item.status === "pending" || item.status === "uploading" || item.status === "failed"));
  if (state.view === "intake" && state.intake) {
    captureIntake();
    persistIntake();
    event.preventDefault();
    event.returnValue = "";
  }
  if (photosPending) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function moto(id) {
  const m = (state.db.Motos || []).find((x) => x.IDMoto === id);
  return m ? `${m.Patente} · ${m.Marca} ${m.Modelo}` : "Moto no encontrada";
}
function cliente(id) {
  return (
    (state.db.Clientes || []).find((x) => x.IDCliente === id)?.Nombre ||
    "Cliente no encontrado"
  );
}
function totals(id) {
  const items = (state.db.Detalle_Trabajo || []).filter(
    (x) => x.IDOrden === id,
  );
  const o = state.db.Ordenes_Trabajo.find((x) => x.IDOrden === id);
  const total = Math.max(
    0,
    items.reduce((s, x) => s + Number(x.Subtotal || 0), 0) -
      Number(o?.Descuento || 0),
  );
  const paid = (state.db.Pagos || [])
    .filter((x) => x.IDOrden === id)
    .reduce((s, x) => s + Number(x.Importe || 0), 0);
  return { total, paid, due: total - paid };
}
const money = (n) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  }).format(n);
const ORDER_STAGES = [
  ["Recibida", "Recibida"],
  ["Diagnosticando", "En diagnóstico"],
  ["Presupuestada", "Presupuestada"],
  ["Esperando aprobación", "Esperando aprobación"],
  ["Esperando repuestos", "Esperando repuestos"],
  ["En reparación", "En reparación"],
  ["Lista para retirar", "Lista para retirar"],
  ["Entregada", "Entregada"],
  ["Cancelada", "Cancelada"],
];
const ORDER_STAGE_LABELS = Object.fromEntries(ORDER_STAGES);
function orderStageLabel(stage) {
  return ORDER_STAGE_LABELS[stage] || stage || "Sin estado";
}
function orderContext(id) {
  const order = (state.db.Ordenes_Trabajo || []).find(
    (row) => row.IDOrden === id,
  );
  const bike =
    order && (state.db.Motos || []).find((row) => row.IDMoto === order.IDMoto);
  const client =
    bike &&
    (state.db.Clientes || []).find((row) => row.IDCliente === bike.IDCliente);
  return {
    order,
    bike,
    client,
    items: (state.db.Detalle_Trabajo || []).filter((row) => row.IDOrden === id),
    payments: (state.db.Pagos || []).filter((row) => row.IDOrden === id),
    photos: (state.db.Fotos || []).filter((row) => row.IDOrden === id),
    totals: totals(id),
  };
}
function nextOrderStage(stage) {
  const flow = {
    Recibida: "Diagnosticando",
    Diagnosticando: "Presupuestada",
    Presupuestada: "Esperando aprobación",
    "Esperando aprobación": "En reparación",
    "Esperando repuestos": "En reparación",
    "En reparación": "Lista para retirar",
    "Lista para retirar": "Entregada",
  };
  return flow[stage] || "";
}
async function changeOrderStage(id, nextStage) {
  const current = orderContext(id).order;
  if (!current || !ORDER_STAGE_LABELS[nextStage]) return;
  const backwardsFromDelivered =
    current.Estado === "Entregada" && nextStage !== "Entregada";
  const accepted = await confirmModal({
    title: backwardsFromDelivered
      ? "¿Reabrir una orden entregada?"
      : "¿Actualizar estado de la orden?",
    message: backwardsFromDelivered
      ? "La orden volverá a una etapa anterior. Confirmá únicamente si necesitás corregir el historial."
      : `La orden pasará a “${orderStageLabel(nextStage)}”.`,
    cancelText: "Cancelar",
    confirmText: backwardsFromDelivered ? "Reabrir orden" : "Actualizar estado",
    danger: backwardsFromDelivered,
  });
  if (!accepted) return;
  await withSession(async () => {
    const record = { IDOrden: id, Estado: nextStage };
    if (nextStage === "Entregada" && !current.FechaEntrega)
      record.FechaEntrega = localToday();
    const saved = await api("save", { table: "Ordenes_Trabajo", record });
    updateDbRecord("Ordenes_Trabajo", saved, "IDOrden");
    toast("Estado actualizado correctamente.");
    orderDetail(id);
  });
}

/* =========================================================
   MOTOMANIA - WHATSAPP DESDE CLIENTES Y MOTOS
   Permite presupuesto por orden o mensaje libre.
   ========================================================= */

function openContactWhatsApp(clientId, motoId = "") {
  const customer = (state.db.Clientes || []).find(
    (c) => String(c.IDCliente) === String(clientId),
  );

  if (!customer) {
    toast("No se encontró el cliente.");
    return;
  }

  const numero =
    normalizeWhatsApp(customer.WhatsApp) ||
    normalizeWhatsApp(customer.Telefono, true);

  if (!numero) {
    toast("Este cliente no tiene un WhatsApp válido.");
    return;
  }

  // Órdenes relacionadas con el cliente o con la moto elegida.
  const motosCliente = (state.db.Motos || []).filter(
    (m) => String(m.IDCliente) === String(clientId),
  );

  const motosPermitidas = new Set(
    motosCliente
      .filter((m) => !motoId || String(m.IDMoto) === String(motoId))
      .map((m) => String(m.IDMoto)),
  );

  const ordenes = (state.db.Ordenes_Trabajo || [])
    .filter((o) => motosPermitidas.has(String(o.IDMoto)))
    .sort((a, b) => {
      const f = String(b.FechaIngreso || "").localeCompare(
        String(a.FechaIngreso || ""),
      );
      return f || String(b.IDOrden).localeCompare(String(a.IDOrden));
    });

  const overlay = document.createElement("div");
  overlay.className = "app-modal-overlay";

  const modal = document.createElement("section");
  modal.className = "app-modal wa-order-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "WhatsApp del cliente");

  modal.innerHTML = `
    <h2>WhatsApp</h2>

    <p><strong>${esc(customer.Nombre)}</strong></p>

    <div class="wa-modal-section">
      <h3>Enviar presupuesto</h3>

      ${
        ordenes.length
          ? `
            <label>
              Seleccionar trabajo
              <select id="waContactOrder">
                ${ordenes
                  .map((o) => {
                    const m = motosCliente.find(
                      (x) => String(x.IDMoto) === String(o.IDMoto),
                    );

                    const descripcion = [
                      argentinaDate(o.FechaIngreso),
                      m?.Patente || "Sin patente",
                      m?.Marca || "",
                      m?.Modelo || "",
                      o.Problema || "",
                    ]
                      .filter(Boolean)
                      .join(" · ");

                    return `
                    <option value="${esc(o.IDOrden)}">
                      ${esc(descripcion)}
                    </option>
                  `;
                  })
                  .join("")}
              </select>
            </label>

            <button type="button" id="waContactBudget">
              Enviar presupuesto
            </button>
          `
          : `
            <p>Este cliente o moto todavía no tiene trabajos registrados.</p>
          `
      }
    </div>

    <div class="wa-modal-section">
      <h3>Otro mensaje</h3>

      <label>
        Mensaje
        <textarea
          id="waContactMessage"
          placeholder="Hola, te escribo de MOTOMANÍA..."
          rows="4"
        ></textarea>
      </label>

      <button type="button" id="waContactCustom">
        Abrir WhatsApp
      </button>
    </div>

    <div class="app-modal-actions">
      <button type="button" class="ghost" id="waContactCancel">
        Cancelar
      </button>
    </div>
  `;

  overlay.append(modal);

  const cerrar = () => {
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();

    if (!document.querySelector(".app-modal-overlay")) {
      document.body.classList.remove("modal-open");
    }
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") cerrar();
  };

  modal.querySelector("#waContactCancel").onclick = cerrar;

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) cerrar();
  });

  // PRESUPUESTO: reutiliza la función que ya funciona.
  const budgetButton = modal.querySelector("#waContactBudget");

  if (budgetButton) {
    budgetButton.onclick = () => {
      const orderId = modal.querySelector("#waContactOrder").value;

      if (!orderId) return;

      const conceptos = (state.db.Detalle_Trabajo || []).filter(
        (x) => String(x.IDOrden) === String(orderId),
      );

      if (!conceptos.length) {
        toast("Este trabajo todavía no tiene conceptos presupuestados.");
        return;
      }

      // Se abre desde el clic para evitar bloqueos de ventanas.
      budgetWhatsApp(orderId);
      cerrar();
    };
  }

  // MENSAJE LIBRE: funciona aunque no existan trabajos.
  modal.querySelector("#waContactCustom").onclick = () => {
    const mensaje = modal.querySelector("#waContactMessage").value.trim();

    const url = mensaje
      ? `https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`
      : `https://wa.me/${numero}`;

    window.open(url, "_blank", "noopener");
    cerrar();
  };

  document.body.append(overlay);
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onKeyDown);

  (
    modal.querySelector("#waContactBudget") ||
    modal.querySelector("#waContactMessage")
  ).focus();
}

/* =========================================================
   MOTOMANIA - WHATSAPP POR ORDEN DE TRABAJO
   Presupuesto automático o mensaje personalizado
   ========================================================= */

function openOrderWhatsApp(id) {
  const { order, bike, client, items } = orderContext(id);

  if (!order || !bike || !client) {
    toast("No se encontraron los datos del trabajo.");
    return;
  }

  const numero =
    normalizeWhatsApp(client.WhatsApp) ||
    normalizeWhatsApp(client.Telefono, true);

  if (!numero) {
    toast("Este cliente no tiene un WhatsApp válido.");
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "app-modal-overlay";

  const modal = document.createElement("section");
  modal.className = "app-modal wa-order-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Enviar WhatsApp");

  modal.innerHTML = `
    <h2>WhatsApp del trabajo</h2>

    <p>
      <strong>${esc(client.Nombre)}</strong><br>
      ${esc(bike.Patente)} ·
      ${esc(bike.Marca)} ${esc(bike.Modelo)}
    </p>

    <div class="wa-modal-section">
      <h3>Presupuesto</h3>
      <p>
        Envía los trabajos, repuestos y el importe total
        del presupuesto cargado.
      </p>

      <button type="button" id="waSendBudget">
        Enviar presupuesto
      </button>
    </div>

    <div class="wa-modal-section">
      <h3>Otro mensaje</h3>

      <label for="waCustomMessage">
        Escribí el mensaje
      </label>

      <textarea
        id="waCustomMessage"
        rows="4"
        placeholder="Hola, te escribo de MOTOMANÍA para avisarte que..."
      ></textarea>

      <button type="button" id="waSendCustom">
        Abrir WhatsApp
      </button>
    </div>

    <div class="app-modal-actions">
      <button type="button" class="ghost" id="waCancel">
        Cancelar
      </button>
    </div>
  `;

  overlay.appendChild(modal);

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      cerrar();
    }
  };

  function cerrar() {
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
    if (!document.querySelector(".app-modal-overlay")) {
      document.body.classList.remove("modal-open");
    }
  }

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) cerrar();
  });

  modal.querySelector("#waCancel").onclick = cerrar;

  // OPCION 1: PRESUPUESTO AUTOMATICO
  modal.querySelector("#waSendBudget").onclick = () => {
    if (!items.length) {
      toast("Primero cargá los trabajos o repuestos del presupuesto.");
      return;
    }

    cerrar();

    // Reutiliza la función existente.
    budgetWhatsApp(id);
  };

  // OPCION 2: MENSAJE LIBRE
  modal.querySelector("#waSendCustom").onclick = () => {
    const mensaje = modal.querySelector("#waCustomMessage").value.trim();

    const url = mensaje
      ? `https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`
      : `https://wa.me/${numero}`;

    window.open(url, "_blank", "noopener");

    cerrar();
  };

  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onKeyDown);

  modal.querySelector("#waSendBudget").focus();
}

function budgetWhatsApp(id) {
  const { order, bike, client, items, totals: summary } = orderContext(id);
  if (!order || !bike || !client)
    return toast("No se pudieron recuperar los datos de la orden.");
  const number =
    normalizeWhatsApp(client.WhatsApp) ||
    normalizeWhatsApp(client.Telefono, true);
  if (!number)
    return toast("El cliente no tiene un teléfono de WhatsApp válido.");
  const bikeName =
    [bike.Marca, bike.Modelo].filter(Boolean).join(" ") || "Moto";
  const lines = items.length
    ? items.map(
        (item) =>
          `- ${item.Descripcion || "Concepto"}: ${money(Number(item.Subtotal) || Number(item.Cantidad || 0) * Number(item.PrecioUnitario || 0))}`,
      )
    : ["- Sin trabajos presupuestados todavía"];
  const message = [
    "MOTOMANÍA — PRESUPUESTO",
    "",
    `Cliente: ${client.Nombre || ""}`,
    `Moto: ${bikeName}`,
    `Patente: ${bike.Patente || "Sin patente"}`,
    `Orden: ${order.IDOrden}`,
    "",
    "Trabajos y repuestos:",
    ...lines,
    "",
    `TOTAL: ${money(summary.total)}`,
    "",
    "Por favor, confirmá si autorizás los trabajos presupuestados.",
    "Gracias por confiar en MOTOMANÍA.",
  ].join("\n");
  window.open(
    `https://wa.me/${number}?text=${encodeURIComponent(message)}`,
    "_blank",
    "noopener",
  );
}
function printOrder(id) {
  state.printOrderId = id;
  document.body.classList.add("printing-order");
  window.addEventListener(
    "afterprint",
    () => document.body.classList.remove("printing-order"),
    { once: true },
  );
  window.print();
}

function render() {
  state.currentScreen = { kind: "view", view: state.view };
  state.galleryAbortController?.abort();
  state.galleryAbortController = null;
  state.activeOrderId = "";
  state.galleryRequest += 1;

  document
    .querySelectorAll("#nav button")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.view === state.view),
    );

  // Inicio
  if (state.view === "dashboard") {
    return dashboard();
  }

  // Ingreso rápido
  if (state.view === "quickIntake" && state.quick) {
    return renderQuickIntake(false);
  }

  // Ingreso guiado
  if (state.view === "intake" && state.intake) {
    return renderIntake();
  }

  // Caja
  if (state.view === "Caja") {
    return cashDashboard();
  }

  // Servicios: nueva tabla compacta
  if (state.view === "Servicios") {
    return servicesView();
  }

  // Clientes, Motos, Trabajos, Repuestos y demás
  list(state.view);
}

/* ==========================================================
   MOTOMANÍA - SELECTOR MODO DÍA / NOCHE
   Guarda la preferencia en el navegador.
   No modifica datos ni interrumpe formularios.
   ========================================================== */

function setupThemeToggle() {
  const STORAGE_KEY = "motomania.theme";

  const header = document.querySelector(".header-actions");

  if (!header) return;

  // Evitar insertar dos veces el botón.
  if (document.getElementById("themeToggle")) return;

  // Recuperar preferencia anterior.
  let savedTheme = "dark";

  try {
    const stored = localStorage.getItem(STORAGE_KEY);

    if (stored === "light" || stored === "dark") {
      savedTheme = stored;
    }
  } catch (error) {
    console.warn("No se pudo recuperar el tema guardado.");
  }

  // Crear botón.
  const button = document.createElement("button");

  button.id = "themeToggle";
  button.type = "button";
  button.className = "ghost header-button theme-toggle";

  button.innerHTML = `
    <span class="theme-toggle-icon" aria-hidden="true"></span>
    <span class="theme-toggle-label"></span>
  `;

  // Ubicar antes del botón Actualizar.
  const refreshButton = document.getElementById("refresh");

  if (refreshButton && refreshButton.parentElement === header) {
    header.insertBefore(button, refreshButton);
  } else {
    header.appendChild(button);
  }

  // Aplicar tema elegido.
  function applyTheme(theme) {
    const isLight = theme === "light";

    document.documentElement.setAttribute(
      "data-theme",
      isLight ? "light" : "dark",
    );

    button.querySelector(".theme-toggle-icon").textContent = isLight
      ? "☾"
      : "☀";

    button.querySelector(".theme-toggle-label").textContent = isLight
      ? "Modo noche"
      : "Modo día";

    button.setAttribute(
      "aria-label",
      isLight ? "Activar modo noche" : "Activar modo día",
    );

    button.setAttribute(
      "title",
      isLight ? "Cambiar a modo oscuro" : "Cambiar a modo claro",
    );

    button.setAttribute("aria-pressed", String(isLight));
  }

  // Aplicar preferencia inicial.
  applyTheme(savedTheme);

  // Alternar al presionar el botón.
  button.addEventListener("click", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme");

    const nextTheme = currentTheme === "light" ? "dark" : "light";

    applyTheme(nextTheme);

    try {
      localStorage.setItem(STORAGE_KEY, nextTheme);
    } catch (error) {
      console.warn("No se pudo guardar la preferencia visual.");
    }
  });
}

// Inicialización del selector visual.
setupThemeToggle();

function dashboard() {
  const orders = state.db.Ordenes_Trabajo || [];
  const opened = orders.filter(
    (order) => !["Entregada", "Cancelada"].includes(order.Estado),
  );
  const ready = orders.filter((order) => order.Estado === "Lista para retirar");
  const awaiting = orders.filter(
    (order) => order.Estado === "Esperando repuestos",
  );
  const indicators = [
    {
      icon: "🏍",
      label: "Trabajos abiertos",
      number: opened.length,
      filter: "open",
    },
    {
      icon: "✓",
      label: "Listas para retirar",
      number: ready.length,
      filter: "ready",
    },
    {
      icon: "◷",
      label: "Esperando repuestos",
      number: awaiting.length,
      filter: "parts",
    },
    {
      icon: "♙",
      label: "Clientes registrados",
      number: state.db.Clientes.length,
      filter: "clients",
    },
  ];
  $("#content").innerHTML = `
    <div class="toolbar dashboard-header">
      <div><h2>Panel del taller</h2><p class="muted">Tocá un indicador para ver sus registros.</p></div>
      <div class="intake-dashboard-actions">
        <button data-quick-new>+ INGRESAR MOTO Y TRABAJO</button>
        ${loadIntakeDraft() ? '<button class="ghost" data-intake="draft">Continuar borrador anterior</button>' : ""}
      </div>
    </div>
    <div class="stats dashboard-stats">${indicators
      .map(
        (item) => `
      <button type="button" class="stat stat-action" data-indicator="${item.filter}">
        <span class="stat-icon" aria-hidden="true">${item.icon}</span>
        <b>${item.number}</b><small>${item.label}</small><span class="stat-open">Ver registros →</span>
      </button>`,
      )
      .join("")}</div>
    `;
  wire();
}

function cashDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  // Fechas YYYY-MM-DD: interpretar como fecha local,
  // evitando el desplazamiento por UTC.
  if (typeof value === "string") {
    const texto = value.trim();

    const match = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);

      const date = new Date(year, month - 1, day);

      // Rechazar fechas inválidas, como 2026-02-30.
      if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
      ) {
        return null;
      }

      return date;
    }
  }

  // Conservar el comportamiento anterior para fechas
  // con hora, timestamps y otros formatos existentes.
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function cashRange(filter) {
  const now = new Date(),
    start = new Date(now),
    end = new Date(now);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  if (filter.period === "week") {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  } else if (filter.period === "month") start.setDate(1);
  else if (filter.period === "custom") {
    if (filter.start) {
      const date = cashDate(`${filter.start}T00:00:00`);
      if (date) start.setTime(date.getTime());
    } else start.setTime(0);
    if (filter.end) {
      const date = cashDate(`${filter.end}T23:59:59.999`);
      if (date) end.setTime(date.getTime());
    } else end.setTime(8640000000000000);
  }
  return { start, end };
}
function cashRecords(filter = state.cashFilter) {
  const { start, end } = cashRange(filter);
  const ordersById = new Map(
    (state.db.Ordenes_Trabajo || []).map((order) => [order.IDOrden, order]),
  );
  const bikesById = new Map(
    (state.db.Motos || []).map((bike) => [bike.IDMoto, bike]),
  );
  const clientsById = new Map(
    (state.db.Clientes || []).map((client) => [client.IDCliente, client]),
  );
  const relatedOrder = (orderId) => {
    const order = ordersById.get(orderId);
    const bike = order ? bikesById.get(order.IDMoto) : null;
    const client = bike ? clientsById.get(bike.IDCliente) : null;
    return { order, bike, client };
  };
  const payments = (state.db.Pagos || []).map((payment) => ({
    key: `payment:${payment.IDPago}`,
    source: "payment",
    ...payment,
    Fecha: payment.Fecha,
    Tipo: "Ingreso",
    Categoria: "Cobro de orden",
    Descripcion: `Cobro de orden ${payment.IDOrden || ""}`.trim(),
    Importe: Number(payment.Importe || 0),
    Medio: payment.Medio || "Sin medio",
    Responsable: "",
    ...relatedOrder(payment.IDOrden),
  }));
  const manual = (state.db.Movimientos_Caja || []).map((movement) => ({
    key: `movement:${movement.IDMovimiento}`,
    source: "manual",
    ...movement,
    Importe: Number(movement.Importe || 0),
    ...relatedOrder(movement.IDOrden),
  }));
  const unique = new Map();
  [...payments, ...manual].forEach((record) => unique.set(record.key, record));
  return [...unique.values()]
    .filter((record) => Number.isFinite(record.Importe) && record.Importe > 0)
    .filter((record) => {
      const date = cashDate(record.Fecha);
      return date && date >= start && date <= end;
    })
    .sort((a, b) => cashDate(b.Fecha) - cashDate(a.Fecha));
}
function cashSummary(records) {
  const summary = { payment: 0, manualIncome: 0, expense: 0, byMedium: {} };
  records.forEach((record) => {
    const signed = record.Tipo === "Egreso" ? -record.Importe : record.Importe;
    summary.byMedium[record.Medio] =
      (summary.byMedium[record.Medio] || 0) + signed;
    if (record.source === "payment") summary.payment += record.Importe;
    else if (record.Tipo === "Ingreso") summary.manualIncome += record.Importe;
    else summary.expense += record.Importe;
  });
  summary.income = summary.payment + summary.manualIncome;
  summary.net = summary.income - summary.expense;
  return summary;
}
function cashDateLabel(value) {
  const date = cashDate(value);
  return date
    ? date.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })
    : "Fecha inválida";
}
function cashRecordCard(record) {
  const isExpense = record.Tipo === "Egreso";
  const order = record.order;
  const bike = record.bike;
  const client = record.client;
  const title =
    record.source === "payment"
      ? "Cobro de orden"
      : isExpense
        ? `Egreso${record.Categoria ? ` · ${record.Categoria}` : ""}`
        : record.Categoria || "Ingreso";
  const detailLines = [];
  if (order) {
    if (client?.Nombre) detailLines.push(["Cliente", client.Nombre]);
    const bikeName = [bike?.Marca, bike?.Modelo].filter(Boolean).join(" ");
    if (bikeName) detailLines.push(["Moto", bikeName]);
    if (bike?.Patente) detailLines.push(["Patente", bike.Patente]);
    detailLines.push(["Orden", order.IDOrden]);
    if (order.Problema) detailLines.push(["Trabajo", order.Problema]);
    if (order.Estado) detailLines.push(["Estado", order.Estado]);
  } else {
    if (record.Categoria) detailLines.push(["Concepto", record.Categoria]);
    if (record.Descripcion) detailLines.push(["Descripción", record.Descripcion]);
    const counterparty =
      record.Proveedor || record.Destinatario || record.Responsable || "";
    if (counterparty) detailLines.push(["Responsable", counterparty]);
    if (record.Referencia || record.Comprobante)
      detailLines.push(["Referencia", record.Referencia || record.Comprobante]);
  }
  const observation = record.Observaciones || record.Observacion || "";
  return `<article class="cash-row ${isExpense ? "is-expense" : "is-income"}"><div class="cash-row-main"><div><span class="badge cash-badge ${record.source === "payment" ? "cash-payment" : ""}">${esc(record.source === "payment" ? "Cobro de orden" : record.Tipo)}</span><strong>${esc(title)}</strong></div><b class="${isExpense ? "negative" : "positive"}">${isExpense ? "−" : "+"}${money(record.Importe)}</b></div>${detailLines.length ? `<dl class="cash-row-info">${detailLines.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>` : ""}${observation ? `<p class="cash-row-note">${esc(observation)}</p>` : ""}<div class="cash-row-meta"><span>${esc(cashDateLabel(record.Fecha))}</span><span>${esc(record.Medio || "Sin medio")}</span></div>${order ? `<div class="cash-row-actions"><button class="ghost" type="button" data-cash-order="${esc(order.IDOrden)}">Ver orden</button></div>` : ""}</article>`;
}
function cashDashboard() {
  const records = cashRecords(),
    summary = cashSummary(records),
    filter = state.cashFilter;
  const mediums = Object.entries(summary.byMedium).sort(([a], [b]) =>
    a.localeCompare(b, "es"),
  );
  $("#content").innerHTML =
    `<div class="toolbar cash-toolbar"><div><h2>Caja simple</h2><p class="muted">Cobros de órdenes y movimientos manuales. El resultado no representa ganancia contable.</p></div><div class="cash-actions"><button data-cash-add="Ingreso">+ Registrar ingreso</button><button class="ghost" data-cash-add="Egreso">− Registrar egreso</button></div></div><section class="cash-filters panel"><label>Período<select id="cashPeriod"><option value="today" ${filter.period === "today" ? "selected" : ""}>Hoy</option><option value="week" ${filter.period === "week" ? "selected" : ""}>Esta semana</option><option value="month" ${filter.period === "month" ? "selected" : ""}>Este mes</option><option value="custom" ${filter.period === "custom" ? "selected" : ""}>Rango personalizado</option></select></label><label class="cash-custom" ${filter.period === "custom" ? "" : "hidden"}>Desde<input id="cashStart" type="date" value="${esc(filter.start)}"></label><label class="cash-custom" ${filter.period === "custom" ? "" : "hidden"}>Hasta<input id="cashEnd" type="date" value="${esc(filter.end)}"></label></section><section class="cash-stats"><article class="cash-stat income"><small>Ingresos del período</small><b>${money(summary.income)}</b><span>${money(summary.payment)} cobros · ${money(summary.manualIncome)} manuales</span></article><article class="cash-stat expense"><small>Egresos del período</small><b>${money(summary.expense)}</b><span>Gastos y retiros manuales</span></article><article class="cash-stat net"><small>Resultado neto</small><b>${money(summary.net)}</b><span>Ingresos menos egresos</span></article></section><section class="panel cash-mediums"><div class="toolbar"><h2>Flujo neto por medio</h2><small class="muted">Efectivo registrado, sin saldo de apertura.</small></div><div class="cash-medium-list">${mediums.map(([medium, amount]) => `<div><span>${esc(medium)}</span><b class="${amount < 0 ? "negative" : ""}">${money(amount)}</b></div>`).join("") || '<p class="muted">No hay movimientos para este período.</p>'}</div></section><section class="toolbar"><div><h2>Movimientos</h2><p class="muted">${records.length} movimiento${records.length === 1 ? "" : "s"} en el período.</p></div></section><section class="cash-list">${records.map(cashRecordCard).join("") || '<div class="empty">No hay cobros ni movimientos en el período seleccionado.</div>'}</section>`;
  const updateFilter = () => {
    state.cashFilter.period = $("#cashPeriod").value;
    state.cashFilter.start = $("#cashStart")?.value || "";
    state.cashFilter.end = $("#cashEnd")?.value || "";
    cashDashboard();
  };
  $("#cashPeriod").onchange = updateFilter;
  $("#cashStart")?.addEventListener("change", updateFilter);
  $("#cashEnd")?.addEventListener("change", updateFilter);
  document.querySelectorAll("[data-cash-add]").forEach((button) => {
    button.onclick = () => cashForm(button.dataset.cashAdd);
  });
  document.querySelectorAll("[data-cash-order]").forEach((button) => {
    button.onclick = () => orderDetail(button.dataset.cashOrder);
  });
}
function cashAmount(value) {
  const raw = String(value || "")
    .trim()
    .replace(/\s/g, "");
  let normalized;
  if (/^\d{1,3}(?:\.\d{3})*,\d+$/.test(raw))
    normalized = raw.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(?:,\d{3})*\.\d+$/.test(raw))
    normalized = raw.replace(/,/g, "");
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(raw))
    normalized = raw.replace(/\./g, "");
  else if (/^\d+,\d+$/.test(raw)) normalized = raw.replace(",", ".");
  else if (/^\d+(?:\.\d+)?$/.test(raw)) normalized = raw;
  else return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
function cashForm(type) {
  state.activeOrderId = "";
  state.galleryRequest += 1;
  const categories =
    type === "Ingreso"
      ? ["Aporte", "Otros ingresos"]
      : [
          "Insumos",
          "Servicios",
          "Herramientas",
          "Alquiler",
          "Impuestos",
          "Retiro",
          "Otros gastos",
        ];
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  $("#content").innerHTML =
    `<div class="toolbar"><div><h2>Registrar ${type.toLowerCase()}</h2><p class="muted">Movimiento manual. Los cobros de órdenes se registran automáticamente desde Pagos.</p></div><button class="ghost" id="back">Volver a Caja</button></div><form id="cashForm" class="panel"><div class="fields"><label>Tipo<input name="Tipo" value="${type}" readonly></label><label>Categoría<select name="Categoria" required><option value="">Seleccionar…</option>${categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join("")}</select></label><label>Descripción<input name="Descripcion" required maxlength="250"></label><label>Importe<input name="Importe" type="text" inputmode="decimal" placeholder="0,00" required></label><label>Medio<select name="Medio" required><option value="">Seleccionar…</option>${["Efectivo", "Transferencia", "Débito", "Crédito", "QR"].map((medium) => `<option value="${esc(medium)}">${esc(medium)}</option>`).join("")}</select></label><label>Responsable<input name="Responsable" required maxlength="120"></label><label>Fecha y hora<input name="Fecha" type="datetime-local" value="${date}" required></label></div><button id="cashSubmit" type="submit">Guardar ${type.toLowerCase()}</button></form>`;
  $("#back").onclick = () => {
    state.view = "Caja";
    render();
  };
  $("#cashForm").onsubmit = async (event) => {
    event.preventDefault();
    const record = Object.fromEntries(new FormData(event.target));
    record.Categoria = record.Categoria.trim();
    record.Descripcion = record.Descripcion.trim();
    record.Responsable = record.Responsable.trim();
    record.Importe = cashAmount(record.Importe);
    const selectedDate = new Date(record.Fecha);
    if (
      !record.Categoria ||
      !record.Descripcion ||
      !record.Responsable ||
      !record.Importe ||
      !["Efectivo", "Transferencia", "Débito", "Crédito", "QR"].includes(
        record.Medio,
      ) ||
      Number.isNaN(selectedDate.getTime())
    ) {
      toast("Revisá los datos del movimiento antes de guardar.");
      return;
    }
    record.Fecha = selectedDate.toISOString();
    const submit = $("#cashSubmit");
    submit.disabled = true;
    await withSession(async () => {
      await api("save", { table: "Movimientos_Caja", record });
      toast("Movimiento de caja guardado correctamente");
      state.view = "Caja";
      await load();
    });
    submit.disabled = false;
  };
}
const INTAKE_DRAFT_KEY = "motomania.intake.draft.v1";
const INTAKE_AUTOSAVE_DELAY = 350;
const MAX_INTAKE_PHOTOS = 8;
const MAX_INTAKE_PHOTO_BYTES = 12 * 1024 * 1024;
let intakeAutosaveTimer = 0;
function intakeBlank() {
  return {
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`,
    step: 1,
    clientMode: "existing",
    clientId: "",
    client: {},
    motoMode: "existing",
    motoId: "",
    moto: {},
    reception: {
      FechaIngreso: localToday(),
      Estado: "Recibida",
      Kilometraje: "",
      Problema: "",
      Observaciones: "",
      FechaPrometida: "",
      Descuento: "",
    },
    photos: [],
    jobs: [],
    advance: {
      Importe: "",
      Medio: "Efectivo",
      Fecha: localToday(),
      Observaciones: "",
    },
    confirmed: {},
    updatedAt: "",
  };
}
function loadIntakeDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(INTAKE_DRAFT_KEY) || "null");
    return draft && draft.id && !draft.completed ? draft : null;
  } catch (_) {
    return null;
  }
}
function persistIntake() {
  if (!state.intake) return;
  state.intake.updatedAt = new Date().toISOString();
  const { files, photos, ...draft } = state.intake;
  draft.photos = [];
  draft.photoReselectRequired = Boolean(
    files?.length || state.intake.photoReselectRequired,
  );
  try {
    localStorage.setItem(INTAKE_DRAFT_KEY, JSON.stringify(draft));
  } catch (_) {
    toast("No se pudo guardar el borrador local.");
  }
}
function queueIntakePersist(capture = true) {
  if (!state.intake) return;
  if (capture) captureIntake();
  clearTimeout(intakeAutosaveTimer);
  intakeAutosaveTimer = setTimeout(
    () => persistIntake(),
    INTAKE_AUTOSAVE_DELAY,
  );
}
function revokeIntakeFiles(intake) {
  (intake?.files || []).forEach((item) => {
    if (item.url) URL.revokeObjectURL(item.url);
  });
}
function discardIntake() {
  clearTimeout(intakeAutosaveTimer);
  revokeIntakeFiles(state.intake);
  localStorage.removeItem(INTAKE_DRAFT_KEY);
  state.intake = null;
}
function startIntake(draft = null) {
  clearTimeout(intakeAutosaveTimer);
  state.view = "intake";
  state.intake = draft
    ? {
        ...draft,
        files: [],
        photos: [],
        photoReselectRequired: Boolean(draft.photoReselectRequired),
      }
    : { ...intakeBlank(), files: [] };
  renderIntake(false);
  if (state.intake.photoReselectRequired)
    toast(
      "El borrador fue recuperado. Por seguridad, las fotografías deben seleccionarse nuevamente.",
    );
}
function intakeClient() {
  return state.intake.clientId
    ? (state.db.Clientes || []).find(
        (x) => x.IDCliente === state.intake.clientId,
      )
    : state.intake.client;
}
function intakeMoto() {
  return state.intake.motoId
    ? (state.db.Motos || []).find((x) => x.IDMoto === state.intake.motoId)
    : state.intake.moto;
}
function intakeControls() {
  const i = state.intake;
  return `<div class="intake-controls"><button class="ghost" id="intakeCancel">Cancelar</button><button class="ghost" id="intakeDraft">Guardar borrador</button>${i.step > 1 ? '<button class="ghost" id="intakePrev">Anterior</button>' : ""}${i.step < 7 ? '<button id="intakeNext">Siguiente</button>' : '<button id="intakeConfirm">CONFIRMAR INGRESO</button>'}</div>`;
}
function intakeCatalog() {
  const available = (row) =>
    !["false", "0", "no", "inactivo"].includes(
      String(row?.Activo ?? "")
        .trim()
        .toLowerCase(),
    );
  return [
    ...(state.db.Servicios || [])
      .filter((row) => available(row) && String(row.Nombre || "").trim())
      .map((row) => ({
        type: "Servicio",
        name: String(row.Nombre).trim(),
        price: row.PrecioSugerido,
      })),
    ...(state.db.Repuestos || [])
      .filter((row) => available(row) && String(row.Descripcion || "").trim())
      .map((row) => ({
        type: "Repuesto",
        name: String(row.Descripcion).trim(),
        price: row.PrecioVenta,
      })),
  ];
}
function renderIntake(capture = true) {
  if (capture) captureIntake();
  queueIntakePersist(false);
  const catalogTables = ["Servicios", "Repuestos"];
  const catalogStates = catalogTables.map((table) => ({
    table,
    status: state.tableStatus?.[table]?.status || "unloaded",
    error: state.tableStatus?.[table]?.error,
  }));
  const catalogErrors = catalogStates.filter(
    (catalog) => catalog.status === "error",
  );

  if (catalogErrors.length) {
    $("#content").innerHTML = `
      <div class="intake-head">
        <div>
          <h2>NUEVO INGRESO</h2>
          <p class="error">No se pudieron cargar los catálogos: ${catalogErrors.map((catalog) => `${catalog.table}${catalog.error ? ` (${esc(catalog.error)})` : ""}`).join(", ")}.</p>
          <button type="button" id="retryIntakeCatalogs">Reintentar carga</button>
        </div>
      </div>
    `;
    $("#retryIntakeCatalogs").onclick = async (event) => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = "Reintentando carga...";
      try {
        await ensureTablesLoaded(["Servicios", "Repuestos"], { retry: true });
        if (state.view === "intake" && state.intake) render();
      } catch (_) {
        if (state.view === "intake" && state.intake) render();
      }
    };
    return;
  }

  if (catalogStates.some((catalog) => catalog.status === "unloaded")) {
    $("#content").innerHTML = `
      <div class="intake-head">
        <div>
          <h2>NUEVO INGRESO</h2>
          <p class="muted">Cargando servicios y repuestos...</p>
        </div>
      </div>
    `;
    ensureTablesLoaded(["Servicios", "Repuestos"])
      .then(() => {
        if (state.view === "intake" && state.intake) render();
      })
      .catch(() => {
        if (state.view === "intake" && state.intake) render();
      });
    return;
  }

  if (catalogStates.some((catalog) => catalog.status === "loading")) {
    $("#content").innerHTML = `
      <div class="intake-head">
        <div>
          <h2>NUEVO INGRESO</h2>
          <p class="muted">Cargando servicios y repuestos...</p>
        </div>
      </div>
    `;
    return;
  }

  const i = state.intake,
    client = intakeClient(),
    bike = intakeMoto();
  const steps = [
    "Cliente",
    "Moto",
    "Recepción",
    "Fotografías",
    "Presupuesto",
    "Anticipo",
    "Confirmación",
  ];
  const progress = `<div class="intake-progress">${steps.map((name, index) => `<button class="${index + 1 === i.step ? "active" : index + 1 < i.step ? "done" : ""}" data-intake-step="${index + 1}" type="button"><span>${index + 1}</span>${name}</button>`).join("")}</div>`;
  let body = "";
  if (i.step === 1) {
    const q = (i.clientQuery || "").toLowerCase();
    const matches = (state.db.Clientes || [])
      .filter((x) =>
        [x.Nombre, x.DNI, x.Telefono].join(" ").toLowerCase().includes(q),
      )
      .slice(0, 8);
    body = `<div class="fields"><label>Buscar cliente<input id="intakeClientSearch" value="${esc(i.clientQuery || "")}" placeholder="Nombre, DNI o teléfono"></label><label>Opción<select id="intakeClientMode"><option value="existing" ${i.clientMode === "existing" ? "selected" : ""}>Cliente existente</option><option value="new" ${i.clientMode === "new" ? "selected" : ""}>Nuevo cliente</option></select></label></div>${i.clientMode === "existing" ? `<div class="intake-options">${matches.map((x) => `<button type="button" class="${i.clientId === x.IDCliente ? "selected" : ""}" data-intake-client="${esc(x.IDCliente)}"><b>${esc(x.Nombre)}</b><small>${esc(x.Telefono || x.DNI || "Sin contacto")}</small></button>`).join("") || '<p class="muted">Buscá o registrá un cliente nuevo.</p>'}</div>` : `<div class="fields"><label>Nombre<input data-intake-client-field="Nombre" value="${esc(i.client.Nombre || "")}" required></label><label>WhatsApp *<input data-intake-client-field="WhatsApp" value="${esc(i.client.WhatsApp || "")}" required></label><label>DNI<input data-intake-client-field="DNI" value="${esc(i.client.DNI || "")}"></label><label>Domicilio<input data-intake-client-field="Domicilio" value="${esc(i.client.Domicilio || "")}"></label><label>Observaciones<textarea data-intake-client-field="Observaciones">${esc(i.client.Observaciones || "")}</textarea></label></div>`}`;
  } else if (i.step === 2) {
    const bikes = client?.IDCliente
      ? (state.db.Motos || []).filter((x) => x.IDCliente === client.IDCliente)
      : [];
    body = `<p class="muted">Cliente: <b>${esc(client?.Nombre || "Sin seleccionar")}</b></p><div class="fields"><label>Opción<select id="intakeMotoMode"><option value="existing" ${i.motoMode === "existing" ? "selected" : ""}>Moto existente</option><option value="new" ${i.motoMode === "new" ? "selected" : ""}>Nueva moto</option></select></label></div>${i.motoMode === "existing" ? `<div class="intake-options">${bikes.map((x) => `<button type="button" class="${i.motoId === x.IDMoto ? "selected" : ""}" data-intake-moto="${esc(x.IDMoto)}"><b>${esc([x.Patente, x.Marca, x.Modelo].filter(Boolean).join(" · "))}</b></button>`).join("") || '<p class="muted">No hay motos para este cliente. Registrá una nueva.</p>'}</div>` : `<div class="fields">${["Patente", "Marca", "Modelo", "Cilindrada", "Anio", "Color", "Chasis", "Observaciones"].map((field) => `<label>${field}<input data-intake-moto-field="${field}" value="${esc(i.moto[field] || "")}" ${["Patente", "Marca", "Modelo"].includes(field) ? "required" : ""}></label>`).join("")}</div>`}`;
  } else if (i.step === 3) {
    body = `<div class="fields"><label>Fecha de ingreso<input data-intake-reception="FechaIngreso" type="date" value="${esc(i.reception.FechaIngreso)}" required></label><label>Kilometraje<input data-intake-reception="Kilometraje" type="number" min="0" value="${esc(i.reception.Kilometraje)}"></label><label>Estado<input value="Recibida" readonly></label><label>Fecha prometida<input data-intake-reception="FechaPrometida" type="date" value="${esc(i.reception.FechaPrometida)}"></label><label class="intake-wide">Problema informado<textarea data-intake-reception="Problema" required>${esc(i.reception.Problema)}</textarea></label><label class="intake-wide">Observaciones<textarea data-intake-reception="Observaciones">${esc(i.reception.Observaciones)}</textarea></label></div>`;
  } else if (i.step === 4) {
    body = `<p class="muted">Las fotos se subirán sólo después de crear la orden. Los borradores no conservan archivos seleccionados.</p><div class="intake-photo-actions photo-source-actions"><label class="photo-source-button photo-source-camera"><span class="photo-source-icon" aria-hidden="true">📷</span><span><strong>Sacar foto</strong><small>Abre la cámara del dispositivo</small></span><input id="intakeCamera" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple hidden></label><label class="photo-source-button photo-source-file"><span class="photo-source-icon" aria-hidden="true">🖼️</span><span><strong>Subir archivo</strong><small>Elegí una imagen existente</small></span><input id="intakeFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden></label></div><div id="intakePreviews" class="intake-previews"></div>`;
  } else if (i.step === 5) {
    const catalog = intakeCatalog();
    const conceptControl = catalog.length
      ? `<div class="fields"><label>Concepto<select id="intakeJobCatalog"><option value="">Seleccionar…</option>${catalog.map((item, index) => `<option value="${index}" data-type="${esc(item.type)}" data-name="${esc(item.name)}" data-price="${esc(item.price || "")}">${esc(item.type)} · ${esc(item.name)}</option>`).join("")}</select></label><label>Cantidad<input id="intakeJobQty" type="number" min="1" value="1"></label><label>Precio<input id="intakeJobPrice" type="number" min="0" step="any"></label><div><button type="button" id="intakeAddJob">Agregar concepto</button></div></div>`
      : '<div class="empty">No hay conceptos disponibles. Cargá un servicio o repuesto activo para armar el presupuesto.</div>';
    body = `${conceptControl}<div class="intake-jobs">${i.jobs.map((job, index) => `<div><span>${esc(job.Tipo)} · ${esc(job.Descripcion)} × ${esc(job.Cantidad)}</span><b>${money(Number(job.Cantidad) * Number(job.PrecioUnitario))}</b><button type="button" data-intake-remove-job="${index}">Quitar</button></div>`).join("") || '<p class="muted">Opcional: podés continuar sin presupuesto.</p>'}</div><label>Descuento<input data-intake-reception="Descuento" type="number" min="0" step="any" value="${esc(i.reception.Descuento)}"></label>`;
  } else if (i.step === 6) {
    body = `<p class="muted">Opcional. Se registrará sólo en Pagos y aparecerá en Caja como cobro de orden.</p><div class="fields"><label>Importe<input data-intake-advance="Importe" type="number" min="0" step="any" value="${esc(i.advance.Importe)}"></label><label>Medio<select data-intake-advance="Medio">${["Efectivo", "Transferencia", "Débito", "Crédito", "QR"].map((x) => `<option ${i.advance.Medio === x ? "selected" : ""}>${x}</option>`).join("")}</select></label><label>Fecha<input data-intake-advance="Fecha" type="date" value="${esc(i.advance.Fecha)}"></label><label>Observaciones<input data-intake-advance="Observaciones" value="${esc(i.advance.Observaciones)}"></label></div>`;
  } else {
    const total =
      i.jobs.reduce(
        (sum, x) => sum + Number(x.Cantidad) * Number(x.PrecioUnitario),
        0,
      ) - Number(i.reception.Descuento || 0);
    body = `<div class="intake-summary"><p><b>Cliente:</b> ${esc(client?.Nombre || "Nuevo cliente")}</p><p><b>Moto:</b> ${esc([bike?.Patente, bike?.Marca, bike?.Modelo].filter(Boolean).join(" · ") || "Nueva moto")}</p><p><b>Problema:</b> ${esc(i.reception.Problema)}</p><p><b>Fotos:</b> ${(i.files || []).length} seleccionada(s)</p><p><b>Presupuesto:</b> ${money(Math.max(0, total))}</p><p><b>Anticipo:</b> ${i.advance.Importe ? money(Number(i.advance.Importe)) : "Sin anticipo"}</p></div>`;
  }
  $("#content").innerHTML =
    `<div class="intake-head"><div><h2>NUEVO INGRESO</h2><p class="muted">Recepción guiada de motocicletas.</p></div></div>${progress}<section class="panel intake-panel"><h3>${steps[i.step - 1]}</h3>${body}</section>${intakeControls()}`;
  if (i.step === 4) refreshIntakePreviews();
  if (i.step === 7 && (i.files || []).length) {
    const stateText = i.files
      .map(
        (file) =>
          `${file.file.name}: ${file.status === "saved" ? "guardada" : file.status === "error" ? "pendiente por error" : file.status === "uploading" ? "subiendo" : "seleccionada"}`,
      )
      .join(" · ");
    const status = document.createElement("p");
    status.className = "muted intake-photo-status";
    status.textContent = `Estado de fotografías: ${stateText}`;
    $(".intake-panel").append(status);
  }
  wireIntake();
}
function refreshIntakePreviews() {
  const root = $("#intakePreviews"),
    intake = state.intake;
  if (!root || !intake) return;
  root.replaceChildren();
  if (!(intake.files || []).length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No se seleccionaron fotografías.";
    root.append(empty);
    return;
  }
  intake.files.forEach((item, index) => {
    const card = document.createElement("div");
    const image = document.createElement("img");
    const status = document.createElement("small");
    const remove = document.createElement("button");
    image.src = item.url;
    image.alt = "Previsualización";
    status.textContent =
      item.status === "uploading"
        ? "Subiendo…"
        : item.status === "saved"
          ? "Guardada"
          : item.status === "error"
            ? `Error: ${item.error || "pendiente"}`
            : "Seleccionada";
    remove.type = "button";
    remove.textContent = "Quitar";
    remove.disabled = item.status === "uploading";
    remove.onclick = () => {
      const removed = intake.files.splice(index, 1)[0];
      if (removed?.url) URL.revokeObjectURL(removed.url);
      intake.photos = intake.files.map((file) => ({
        name: file.file.name,
        type: file.file.type,
        status: file.status || "selected",
      }));
      intake.photoReselectRequired = false;
      queueIntakePersist(false);
      refreshIntakePreviews();
    };
    card.append(image, status, remove);
    root.append(card);
  });
}
function captureIntake() {
  if (!state.intake) return;
  const i = state.intake;
  document.querySelectorAll("[data-intake-client-field]").forEach((el) => {
    i.client[el.dataset.intakeClientField] = el.value;
  });
  document.querySelectorAll("[data-intake-moto-field]").forEach((el) => {
    i.moto[el.dataset.intakeMotoField] = el.value;
  });
  document.querySelectorAll("[data-intake-reception]").forEach((el) => {
    i.reception[el.dataset.intakeReception] = el.value;
  });
  document.querySelectorAll("[data-intake-advance]").forEach((el) => {
    i.advance[el.dataset.intakeAdvance] = el.value;
  });
}
function validIntakeStep() {
  const i = state.intake;
  captureIntake();
  if (
    i.step === 1 &&
    (i.clientMode === "existing"
      ? !i.clientId
      : !i.client.Nombre.trim() || !i.client.WhatsApp?.trim())
  )
    return "Seleccioná o completá un cliente.";
  if (
    i.step === 2 &&
    (i.motoMode === "existing"
      ? !i.motoId
      : !i.moto.Patente.trim() || !i.moto.Marca.trim() || !i.moto.Modelo.trim())
  )
    return "Seleccioná o completá una moto.";
  if (
    i.step === 3 &&
    (!i.reception.FechaIngreso || !i.reception.Problema.trim())
  )
    return "Completá fecha y problema informado.";
  if (
    i.step === 6 &&
    i.advance.Importe &&
    (!Number.isFinite(Number(i.advance.Importe)) ||
      Number(i.advance.Importe) <= 0)
  )
    return "El anticipo debe ser mayor que cero.";
  return "";
}
function wireIntake() {
  const i = state.intake;
  document.querySelectorAll("[data-intake-step]").forEach((button) => {
    button.onclick = () => {
      const target = Number(button.dataset.intakeStep);
      if (target > i.step + 1)
        return toast("Completá las etapas anteriores antes de avanzar.");
      const error = target > i.step ? validIntakeStep() : "";
      if (error) return toast(error);
      i.step = target;
      renderIntake();
    };
  });
  $("#intakeCancel").onclick = async () => {
    const shouldLeave = await confirmModal({
      title: "¿Salir del nuevo ingreso?",
      message:
        "Si salís ahora, los cambios que no hayas guardado como borrador se perderán.",
      cancelText: "Seguir cargando",
      confirmText: "Salir del ingreso",
      danger: true,
    });
    if (!shouldLeave) return;
    state.intake = null;
    state.view = "dashboard";
    render();
  };
  $("#intakeDraft").onclick = () => {
    captureIntake();
    persistIntake();
    toast(
      "Borrador guardado. Las fotos deberán seleccionarse nuevamente al recuperarlo.",
    );
  };
  $("#intakePrev")?.addEventListener("click", () => {
    captureIntake();
    i.step -= 1;
    renderIntake();
  });
  $("#intakeNext")?.addEventListener("click", () => {
    const error = validIntakeStep();
    if (error) return toast(error);
    i.step += 1;
    renderIntake();
  });
  $("#intakeConfirm")?.addEventListener("click", confirmIntake);
  $("#intakeClientSearch")?.addEventListener("input", (event) => {
    i.clientQuery = event.target.value;
    renderIntake();
  });
  $("#intakeClientMode")?.addEventListener("change", (event) => {
    i.clientMode = event.target.value;
    i.clientId = "";
    i.motoId = "";
    renderIntake();
  });
  document.querySelectorAll("[data-intake-client]").forEach((button) => {
    button.onclick = () => {
      i.clientId = button.dataset.intakeClient;
      i.motoId = "";
      renderIntake();
    };
  });
  $("#intakeMotoMode")?.addEventListener("change", (event) => {
    i.motoMode = event.target.value;
    i.motoId = "";
    renderIntake();
  });
  document.querySelectorAll("[data-intake-moto]").forEach((button) => {
    button.onclick = () => {
      i.motoId = button.dataset.intakeMoto;
      renderIntake();
    };
  });
  const addFiles = (files) => {
    const selected = [...files];
    const typeAccepted = selected.filter(isSupportedPhotoFile);
    const oversized = typeAccepted.filter(
      (file) => file.size > MAX_INTAKE_PHOTO_BYTES,
    );
    const available = Math.max(0, MAX_INTAKE_PHOTOS - i.files.length);
    const accepted = typeAccepted
      .filter((file) => file.size <= MAX_INTAKE_PHOTO_BYTES)
      .slice(0, available);
    const rejected = selected.length - typeAccepted.length;
    i.photos = i.files.map((item) => ({
      name: item.file.name,
      type: item.file.type,
      status: item.status || "selected",
    }));
    if (rejected) toast("Solo se admiten fotografías JPG, PNG o WEBP.");
    if (oversized.length)
      toast(
        `Cada fotografía debe pesar como máximo ${Math.round(MAX_INTAKE_PHOTO_BYTES / 1024 / 1024)} MB antes de procesarse.`,
      );
    if (
      typeAccepted.filter((file) => file.size <= MAX_INTAKE_PHOTO_BYTES)
        .length > available
    )
      toast(
        `Podés seleccionar hasta ${MAX_INTAKE_PHOTOS} fotografías por ingreso.`,
      );
    accepted.forEach((file) =>
      i.files.push({
        file,
        url: URL.createObjectURL(file),
        status: "selected",
        uploadKey: uploadKey(`intake_${i.id}_${i.files.length}`),
      }),
    );
    i.photos = i.files.map((item) => ({
      name: item.file.name,
      type: item.file.type,
      status: item.status || "selected",
    }));
    if (accepted.length) {
      i.photoReselectRequired = false;
      queueIntakePersist(false);
      refreshIntakePreviews();
    }
  };
  $("#intakeCamera")?.addEventListener("change", (event) =>
    addFiles(event.target.files),
  );
  $("#intakeFiles")?.addEventListener("change", (event) =>
    addFiles(event.target.files),
  );
  $("#intakeJobCatalog")?.addEventListener("change", (event) => {
    const option = event.target.selectedOptions[0];
    if (option?.value) $("#intakeJobPrice").value = option.dataset.price || "";
  });
  $("#intakeAddJob")?.addEventListener("click", () => {
    const option = $("#intakeJobCatalog").selectedOptions[0],
      qty = Number($("#intakeJobQty").value),
      price = Number($("#intakeJobPrice").value);
    if (
      !option?.value ||
      !Number.isFinite(qty) ||
      qty <= 0 ||
      !Number.isFinite(price) ||
      price < 0
    )
      return toast("Seleccioná un concepto, cantidad y precio válidos.");
    captureIntake();
    i.jobs.push({
      Tipo: option.dataset.type,
      Descripcion:
        option.dataset.name ||
        option.textContent.split(" · ").slice(1).join(" · "),
      Cantidad: qty,
      PrecioUnitario: price,
    });
    queueIntakePersist(false);
    renderIntake(false);
  });
  document.querySelectorAll("[data-intake-remove-job]").forEach((button) => {
    button.onclick = () => {
      captureIntake();
      i.jobs.splice(Number(button.dataset.intakeRemoveJob), 1);
      queueIntakePersist(false);
      renderIntake(false);
    };
  });
  document
    .querySelectorAll(
      "[data-intake-client-field],[data-intake-moto-field],[data-intake-reception],[data-intake-advance]",
    )
    .forEach((element) => {
      element.addEventListener("input", () => queueIntakePersist());
      element.addEventListener("change", () => queueIntakePersist());
    });
}
function applyIntakeResult(result) {
  const upsert = (table, row, key) => {
    if (!row) return;
    const rows = state.db[table] || (state.db[table] = []);
    const index = rows.findIndex((item) => item[key] === row[key]);
    if (index < 0) rows.push(row);
    else rows[index] = row;
  };
  upsert("Clientes", result.client, "IDCliente");
  upsert("Motos", result.moto, "IDMoto");
  upsert("Ordenes_Trabajo", result.order, "IDOrden");
  (result.details || []).forEach((row) =>
    upsert("Detalle_Trabajo", row, "IDDetalle"),
  );
  upsert("Pagos", result.payment, "IDPago");
  $("#summary").textContent =
    `${state.db.Clientes.length} clientes · ${state.db.Motos.filter(motoIsActive).length} motos activas · ${state.db.Ordenes_Trabajo.length} órdenes`;
}
function uploadKey(prefix = "photo") {
  const unique = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${unique}`.replace(/[^A-Za-z0-9_-]/g, "_");
}
function confirmUploadedPhoto(photo, orderId) {
  if (
    !photo ||
    photo.IDOrden !== orderId ||
    !photo.IDFoto ||
    !photo.DriveFileId ||
    !photo.NombreArchivo
  )
    throw Error("El servidor no confirmó el almacenamiento de la fotografía.");
  return photo;
}
async function uploadIntakePhotos(intake, orderId, setProgress) {
  const pending = (intake.files || [])
    .map((file, index) => ({ file, index }))
    .filter(({ index }) => !intake.files[index].confirmed);
  if (!pending.length) return [];
  let startedUploads = 0;
  const results = await Promise.allSettled(
    pending.map(async ({ file, index }) => {
      startedUploads += 1;
      setProgress(
        `Subiendo fotografías (${startedUploads}/${pending.length})…`,
      );
      file.status = "uploading";
      try {
        const base64 = await shrink(file.file);
        const saved = confirmUploadedPhoto(
          await api("uploadPhoto", {
            IDOrden: orderId,
            Tipo: "Ingreso",
            base64,
            uploadKey:
              file.uploadKey ||
              (file.uploadKey = uploadKey(`intake_${intake.id}_${index}`)),
          }),
          orderId,
        );
        intake.files[index].confirmed = true;
        intake.files[index].status = "saved";
        intake.files[index].error = "";
        intake.photos = intake.files.map((item) => ({
          name: item.file.name,
          type: item.file.type,
          status: item.status || "selected",
        }));
        persistIntake();
        const existing = (state.db.Fotos || []).findIndex(
          (photo) => photo.IDFoto === saved.IDFoto,
        );
        if (existing < 0) state.db.Fotos.push(saved);
        else state.db.Fotos[existing] = saved;
        return saved;
      } catch (error) {
        intake.files[index].status = "error";
        intake.files[index].error =
          error.message || "No se pudo subir la fotografía.";
        intake.photos = intake.files.map((item) => ({
          name: item.file.name,
          type: item.file.type,
          status: item.status || "selected",
        }));
        persistIntake();
        throw error;
      }
    }),
  );
  return results;
}
async function confirmIntake() {
  captureIntake();
  const intake = state.intake,
    client = intakeClient(),
    bike = intakeMoto();
  if (
    !client ||
    !bike ||
    !intake.reception.FechaIngreso ||
    !intake.reception.Problema.trim()
  )
    return toast("Completá cliente, moto y recepción antes de confirmar.");
  const submit = $("#intakeConfirm");
  if (!submit || submit.disabled) return;
  const started = performance.now();
  const setProgress = (message) => {
    if ($("#intakeConfirm")) $("#intakeConfirm").textContent = message;
  };
  submit.disabled = true;
  try {
    let orderId = intake.confirmed.orderId;
    if (!orderId) {
      setProgress("Guardando datos del ingreso…");
      const result = await api("saveIntake", {
        intakeId: intake.id,
        clientId: intake.clientId || "",
        client: intake.clientId
          ? null
          : {
              ...intake.client,
              Telefono:
                intake.client.WhatsApp?.trim() ||
                intake.client.Telefono?.trim() ||
                "",
            },
        motoId: intake.motoId || "",
        moto: intake.motoId ? null : intake.moto,
        order: { ...intake.reception, Estado: "Recibida" },
        details: intake.jobs.map(
          ({ Tipo, Descripcion, Cantidad, PrecioUnitario }) => ({
            Tipo,
            Descripcion,
            Cantidad,
            PrecioUnitario,
          }),
        ),
        advance: intake.advance.Importe
          ? {
              Fecha: intake.advance.Fecha,
              Importe: Number(intake.advance.Importe),
              Medio: intake.advance.Medio,
              Observaciones: intake.advance.Observaciones,
            }
          : null,
      });
      applyIntakeResult(result);
      orderId = result.order.IDOrden;
      intake.confirmed = {
        ...intake.confirmed,
        clientId: result.client?.IDCliente || intake.clientId,
        motoId: result.moto?.IDMoto || intake.motoId,
        orderId,
        details: true,
        advance: Boolean(result.payment || !intake.advance.Importe),
      };
      intake.jobs.forEach((job) => {
        job.confirmed = true;
      });
      persistIntake();
    }
    const photoResults = await uploadIntakePhotos(intake, orderId, setProgress);
    const failedPhotos = photoResults.filter(
      (result) => result.status === "rejected",
    );
    if (failedPhotos.length) {
      persistIntake();
      const sessionFailure = failedPhotos.find(
        (result) => result.reason instanceof SessionExpiredError,
      );
      if (sessionFailure) {
        showLogin(sessionFailure.reason.message);
        return;
      }
      renderIntake();
      toast(
        `Los datos se guardaron. ${failedPhotos.length} fotografía${failedPhotos.length === 1 ? " quedó" : "s quedaron"} pendiente${failedPhotos.length === 1 ? "" : "s"}; reintentá confirmar.`,
      );
      return;
    }
    discardIntake();
    toast("Ingreso confirmado correctamente.");
    console.info(
      `[MOTOMANÍA] nuevo ingreso: ${(performance.now() - started).toFixed(0)} ms`,
    );
    state.view = "Ordenes_Trabajo";
    orderDetail(orderId);
  } catch (err) {
    persistIntake();
    if (err instanceof SessionExpiredError) showLogin(err.message);
    else
      toast(
        `No se pudo completar el ingreso. El borrador se conserva. ${err.message}`,
      );
  } finally {
    if ($("#intakeConfirm")) {
      $("#intakeConfirm").disabled = false;
      $("#intakeConfirm").textContent = "CONFIRMAR INGRESO";
    }
  }
}
function updateDbRecord(table, record, key) {
  if (!record) return;
  const rows = state.db[table] || (state.db[table] = []);
  const index = rows.findIndex((row) => row[key] === record[key]);
  if (index >= 0) rows[index] = { ...rows[index], ...record };
  else rows.push(record);
}
async function synchronizeAfterSave() {
  try {
    await load();
  } catch (error) {
    console.error(
      "[MOTOMANÍA] Registro guardado, error de sincronización",
      error,
    );
    toast(
      "El registro SE GUARDÓ, pero falló la actualización de pantalla. Revisá la conexión; no vuelvas a guardarlo.",
    );
  }
}

// ================================================================
// INGRESO RÁPIDO: cliente + moto + orden + conceptos, sin búsquedas
// intermedias. Utiliza saveIntake existente y su protección por intakeId.
// ================================================================
function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function recordBike(id) {
  return (state.db.Motos || []).find(
    (row) => String(row.IDMoto) === String(id),
  );
}
function activeClientBikes(clientId) {
  return (state.db.Motos || []).filter(
    (bike) => String(bike.IDCliente) === String(clientId) && motoIsActive(bike),
  );
}
function safeQuickId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `ingreso_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}
function openQuickIntake({ clientId = "", motoId = "" } = {}) {
  const bike = motoId ? recordBike(motoId) : null;
  if (bike && !motoIsActive(bike))
    return toast(
      "Esta moto está dada de baja. Reactivala antes de registrar otro trabajo.",
    );
  const selectedClientId = bike?.IDCliente || clientId;
  state.quick = {
    id: safeQuickId(),
    clientId: selectedClientId,
    clientMode: selectedClientId ? "existing" : "existing",
    clientQuery: selectedClientId ? cliente(selectedClientId) : "",
    client: {
      Nombre: "",
      WhatsApp: "",
      DNI: "",
      Domicilio: "",
      Observaciones: "",
    },
    motoId: motoId || "",
    motoMode: motoId
      ? "existing"
      : selectedClientId && !activeClientBikes(selectedClientId).length
        ? "new"
        : "existing",
    moto: {
      Patente: "",
      Marca: "",
      Modelo: "",
      Cilindrada: "",
      Anio: "",
      Color: "",
      Chasis: "",
      Observaciones: "",
    },
    order: {
      FechaIngreso: localToday(),
      Kilometraje: "",
      Problema: "",
      Diagnostico: "",
      FechaPrometida: "",
      Observaciones: "",
      Descuento: "",
    },
    jobs: [],
    saving: false,
  };
  state.view = "quickIntake";
  render();
}
function quickCapture() {
  const q = state.quick;
  if (!q) return;
  document.querySelectorAll("[data-quick-client-field]").forEach((el) => {
    q.client[el.dataset.quickClientField] = el.value;
  });
  document.querySelectorAll("[data-quick-moto-field]").forEach((el) => {
    q.moto[el.dataset.quickMotoField] = el.value;
  });
  document.querySelectorAll("[data-quick-order-field]").forEach((el) => {
    q.order[el.dataset.quickOrderField] = el.value;
  });
  if ($("#quickClientSearch")) q.clientQuery = $("#quickClientSearch").value;
}
function quickClientSuggestions() {
  const q = state.quick;
  const normalized = normalizeSearch(q.clientQuery);
  const customers = (state.db.Clientes || [])
    .filter(
      (client) =>
        !normalized ||
        searchableRecord("Clientes", client).includes(normalized),
    )
    .slice(0, 12);
  return (
    customers
      .map(
        (client) =>
          `<button type="button" class="quick-choice ${q.clientId === client.IDCliente ? "selected" : ""}" data-quick-client="${esc(client.IDCliente)}"><b>${esc(client.Nombre)}</b><small>${esc(client.WhatsApp || client.Telefono || "Sin WhatsApp")} · ${activeClientBikes(client.IDCliente).length} motos activas</small></button>`,
      )
      .join("") ||
    '<p class="muted">No se encontró el cliente. Podés elegir «Nuevo cliente».</p>'
  );
}
function quickMotoChoices() {
  const q = state.quick;
  const bikes = activeClientBikes(q.clientId);
  return (
    bikes
      .map(
        (bike) =>
          `<button type="button" class="quick-choice ${q.motoId === bike.IDMoto ? "selected" : ""}" data-quick-moto="${esc(bike.IDMoto)}"><b>${esc([bike.Patente, bike.Marca, bike.Modelo].filter(Boolean).join(" · "))}</b></button>`,
      )
      .join("") ||
    '<p class="muted">Este cliente no tiene motos activas. Elegí «Nueva moto».</p>'
  );
}
function renderQuickIntake(capture = true) {
  if (capture) quickCapture();
  const q = state.quick;
  if (!q) return dashboard();
  const capturePendingJob = () => {
    const type = $("#quickJobType");
    const description = $("#quickJobDescription");
    const quantity = $("#quickJobQty");
    const price = $("#quickJobPrice");
    if (!type && !description && !quantity && !price) return;
    q.pendingJobDraft = {
      Tipo: type?.value || "Servicio",
      Descripcion: description?.value || "",
      Cantidad: quantity?.value || "",
      PrecioUnitario: price?.value || "",
    };
  };
  const catalogTables = ["Servicios", "Repuestos"];
  const catalogStates = catalogTables.map((table) => ({
    table,
    status: state.tableStatus?.[table]?.status || "unloaded",
    error: state.tableStatus?.[table]?.error,
  }));
  const catalogErrors = catalogStates.filter(
    (catalog) => catalog.status === "error",
  );

  if (catalogErrors.length) {
    if (!capture) quickCapture();
    capturePendingJob();
    $("#content").innerHTML = `
      <div class="toolbar">
        <div>
          <h2>Ingreso rápido</h2>
          <p class="error">No se pudieron cargar los catálogos: ${catalogErrors.map((catalog) => `${catalog.table}${catalog.error ? ` (${esc(catalog.error)})` : ""}`).join(", ")}.</p>
          <button type="button" id="retryQuickCatalogs">Reintentar carga</button>
        </div>
      </div>
    `;
    $("#retryQuickCatalogs").onclick = async (event) => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = "Reintentando carga...";
      try {
        await ensureTablesLoaded(["Servicios", "Repuestos"], { retry: true });
        if (state.view === "quickIntake" && state.quick) render();
      } catch (_) {
        if (state.view === "quickIntake" && state.quick) render();
      }
    };
    return;
  }

  if (catalogStates.some((catalog) => catalog.status === "unloaded")) {
    if (!capture) quickCapture();
    capturePendingJob();
    $("#content").innerHTML = `
      <div class="toolbar">
        <div>
          <h2>Ingreso rápido</h2>
          <p class="muted">Cargando servicios y repuestos...</p>
        </div>
      </div>
    `;
    ensureTablesLoaded(["Servicios", "Repuestos"])
      .then(() => {
        if (state.view === "quickIntake" && state.quick) render();
      })
      .catch(() => {
        if (state.view === "quickIntake" && state.quick) render();
      });
    return;
  }

  if (catalogStates.some((catalog) => catalog.status === "loading")) {
    if (!capture) quickCapture();
    capturePendingJob();
    $("#content").innerHTML = `
      <div class="toolbar">
        <div>
          <h2>Ingreso rápido</h2>
          <p class="muted">Cargando servicios y repuestos...</p>
        </div>
      </div>
    `;
    return;
  }

  const customer = (state.db.Clientes || []).find(
    (c) => c.IDCliente === q.clientId,
  );
  const bike = recordBike(q.motoId);
  const catalog = intakeCatalog();
  const pendingJob = q.pendingJobDraft || {};
  const total = Math.max(
    0,
    q.jobs.reduce(
      (sum, job) => sum + Number(job.Cantidad) * Number(job.PrecioUnitario),
      0,
    ) - Number(q.order.Descuento || 0),
  );
  $("#content").innerHTML = `
    <div class="toolbar"><div><h2>🏍 Ingreso rápido</h2><p class="muted">Cliente → Moto → Trabajo y precio. Todo desde acá.</p></div><button id="quickBack" class="ghost" type="button">← Salir</button></div>
    <section class="panel quick-section"><div class="quick-section-head"><span class="quick-step">1</span><div><h2>Cliente</h2><p class="muted">Buscá uno existente o registrá uno nuevo.</p></div></div>
      <div class="quick-tabs"><button type="button" data-quick-client-mode="existing" class="${q.clientMode === "existing" ? "selected" : "ghost"}">Cliente existente</button><button type="button" data-quick-client-mode="new" class="${q.clientMode === "new" ? "selected" : "ghost"}">+ Nuevo cliente</button></div>
      ${q.clientMode === "existing" ? `<label>Buscar por nombre, WhatsApp o patente<input id="quickClientSearch" placeholder="Ej.: Eduardo, 3424, ABC123" value="${esc(q.clientQuery)}" autocomplete="off"></label><div id="quickClientOptions" class="quick-options">${quickClientSuggestions()}</div>${customer ? `<p class="quick-selected">✓ Cliente seleccionado: <b>${esc(customer.Nombre)}</b></p>` : ""}` : `<div class="fields"><label>Nombre *<input data-quick-client-field="Nombre" value="${esc(q.client.Nombre)}" autocomplete="name"></label><label>WhatsApp *<input data-quick-client-field="WhatsApp" type="tel" value="${esc(q.client.WhatsApp)}" inputmode="tel" placeholder="3424..."></label><label>DNI<input data-quick-client-field="DNI" value="${esc(q.client.DNI)}"></label><label>Domicilio<input data-quick-client-field="Domicilio" value="${esc(q.client.Domicilio)}"></label><label>Observaciones<textarea data-quick-client-field="Observaciones">${esc(q.client.Observaciones)}</textarea></label></div>`}
    </section>
    <section class="panel quick-section"><div class="quick-section-head"><span class="quick-step">2</span><div><h2>Moto</h2><p class="muted">Queda asociada automáticamente al cliente seleccionado.</p></div></div>
      ${
        q.clientMode === "existing" && !q.clientId
          ? '<p class="muted">Seleccioná primero un cliente en el punto 1.</p>'
          : `<div class="quick-tabs"><button type="button" data-quick-moto-mode="existing" class="${q.motoMode === "existing" ? "selected" : "ghost"}" ${q.clientMode === "new" ? "disabled" : ""}>Moto existente</button><button type="button" data-quick-moto-mode="new" class="${q.motoMode === "new" ? "selected" : "ghost"}">+ Nueva moto</button></div>
      ${q.motoMode === "existing" && q.clientMode === "existing" ? `<div class="quick-options">${quickMotoChoices()}</div>${bike ? `<p class="quick-selected">✓ Moto seleccionada: <b>${esc([bike.Patente, bike.Marca, bike.Modelo].join(" · "))}</b></p>` : ""}` : `<div class="fields">${["Patente", "Marca", "Modelo", "Cilindrada", "Anio", "Color", "Chasis", "Observaciones"].map((field) => `<label>${field}${["Patente", "Marca", "Modelo"].includes(field) ? " *" : ""}<input data-quick-moto-field="${field}" value="${esc(q.moto[field])}" ${["Cilindrada", "Anio"].includes(field) ? 'type="number" min="0"' : 'type="text"'}></label>`).join("")}</div>`}`
      }
    </section>
    <section class="panel quick-section"><div class="quick-section-head"><span class="quick-step">3</span><div><h2>Trabajo y presupuesto</h2><p class="muted">Cargá el problema, servicios, repuestos y precios antes de guardar.</p></div></div>
      <div class="fields quick-order-fields"><label>Fecha de ingreso<input type="date" data-quick-order-field="FechaIngreso" value="${esc(q.order.FechaIngreso)}"></label><label>Kilometraje<input type="number" min="0" data-quick-order-field="Kilometraje" value="${esc(q.order.Kilometraje)}"></label><label>Problema informado *<textarea data-quick-order-field="Problema">${esc(q.order.Problema)}</textarea></label><label>Diagnóstico (opcional)<textarea data-quick-order-field="Diagnostico">${esc(q.order.Diagnostico)}</textarea></label><label>Fecha prometida (opcional)<input type="date" data-quick-order-field="FechaPrometida" value="${esc(q.order.FechaPrometida)}"></label><label>Observaciones<textarea data-quick-order-field="Observaciones">${esc(q.order.Observaciones)}</textarea></label></div>
      <h3>Servicios y repuestos</h3>
      <div class="quick-concept-editor"><label>Tipo<select id="quickJobType"><option ${pendingJob.Tipo === "Servicio" ? "selected" : ""}>Servicio</option><option ${pendingJob.Tipo === "Repuesto" ? "selected" : ""}>Repuesto</option></select></label><label>Descripción<input id="quickJobDescription" value="${esc(pendingJob.Descripcion || "")}" placeholder="Ej.: cambio de aceite"></label><label>Cantidad<input id="quickJobQty" type="number" min="0.01" step="any" value="${esc(pendingJob.Cantidad ?? "1")}"></label><label>Precio unitario ($)<input id="quickJobPrice" type="number" min="0" step="any" value="${esc(pendingJob.PrecioUnitario || "")}" placeholder="0"></label><button id="quickAddJob" type="button">+ Agregar concepto</button></div>
      ${catalog.length ? `<label class="quick-catalog-label">Cargar desde servicios y repuestos<select id="quickCatalog"><option value="">Opcional: elegir un concepto habitual…</option>${catalog.map((c, i) => `<option value="${i}">${esc(c.type)} · ${esc(c.name)} — ${money(Number(c.price || 0))}</option>`).join("")}</select></label>` : ""}
      <div class="quick-jobs">${q.jobs.map((job, index) => `<div class="quick-job"><span>${esc(job.Tipo)} · <b>${esc(job.Descripcion)}</b> · ${esc(job.Cantidad)} × ${money(Number(job.PrecioUnitario))}</span><strong>${money(Number(job.Cantidad) * Number(job.PrecioUnitario))}</strong><button class="ghost" type="button" data-quick-remove="${index}">Quitar</button></div>`).join("") || '<p class="muted">Sin conceptos todavía. Podés agregarlos ahora o después desde la orden.</p>'}</div>
      <div class="quick-total"><label>Descuento ($)<input type="number" step="any" min="0" data-quick-order-field="Descuento" value="${esc(q.order.Descuento)}"></label><div><small>Total presupuestado</small><b id="quickTotal">${money(total)}</b></div></div>
    </section>
    <div class="quick-footer"><p>Al guardar, la orden se abre automáticamente para continuar el trabajo y las fotos. Los cobros los revisaremos en la próxima etapa.</p><button id="quickSubmit" type="button" ${q.saving ? "disabled" : ""}>${q.saving ? "Guardando..." : "GUARDAR TODO Y ABRIR TRABAJO"}</button></div>`;
  $("#quickBack").onclick = async () => {
    if (q.saving) return;
    quickCapture();
    const leave = await confirmModal({
      title: "¿Salir del ingreso?",
      message: "Los datos del ingreso rápido que no guardaste se perderán.",
      confirmText: "Salir sin guardar",
      cancelText: "Seguir cargando",
      danger: true,
    });
    if (!leave) return;
    state.quick = null;
    state.view = "dashboard";
    render();
  };
  document.querySelectorAll("[data-quick-client-mode]").forEach((button) => {
    button.onclick = () => {
      quickCapture();
      capturePendingJob();
      q.clientMode = button.dataset.quickClientMode;
      q.clientId = "";
      q.motoId = "";
      q.motoMode = q.clientMode === "new" ? "new" : "existing";
      renderQuickIntake(false);
    };
  });
  document.querySelectorAll("[data-quick-client]").forEach((button) => {
    button.onclick = () => {
      quickCapture();
      capturePendingJob();
      q.clientId = button.dataset.quickClient;
      q.motoId = "";
      q.motoMode = activeClientBikes(q.clientId).length ? "existing" : "new";
      renderQuickIntake(false);
    };
  });
  $("#quickClientSearch")?.addEventListener("input", (event) => {
    q.clientQuery = event.target.value;
    if (
      q.clientId &&
      normalizeSearch(q.clientQuery) !== normalizeSearch(cliente(q.clientId))
    ) {
      q.clientId = "";
      q.motoId = "";
      $(".quick-selected")?.remove();
    }
    $("#quickClientOptions").innerHTML = quickClientSuggestions();
    document.querySelectorAll("[data-quick-client]").forEach((button) => {
      button.onclick = () => {
        quickCapture();
        capturePendingJob();
        q.clientId = button.dataset.quickClient;
        q.motoId = "";
        q.motoMode = activeClientBikes(q.clientId).length ? "existing" : "new";
        renderQuickIntake(false);
      };
    });
  });
  document.querySelectorAll("[data-quick-moto-mode]").forEach((button) => {
    button.onclick = () => {
      quickCapture();
      capturePendingJob();
      q.motoMode = button.dataset.quickMotoMode;
      q.motoId = "";
      renderQuickIntake(false);
    };
  });
  document.querySelectorAll("[data-quick-moto]").forEach((button) => {
    button.onclick = () => {
      quickCapture();
      capturePendingJob();
      q.motoId = button.dataset.quickMoto;
      renderQuickIntake(false);
    };
  });
  $("#quickCatalog")?.addEventListener("change", (event) => {
    const item = catalog[Number(event.target.value)];
    if (!item || event.target.value === "") return;
    $("#quickJobType").value = item.type;
    $("#quickJobDescription").value = item.name;
    $("#quickJobPrice").value = item.price ?? "";
  });
  $("#quickAddJob").onclick = () => {
    const description = $("#quickJobDescription").value.trim();
    const quantity = Number($("#quickJobQty").value);
    const priceText = $("#quickJobPrice").value;
    const price = Number(priceText);
    if (
      !description ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      priceText === "" ||
      !Number.isFinite(price) ||
      price < 0
    )
      return toast("Completá descripción, cantidad y precio del concepto.");
    quickCapture();
    q.jobs.push({
      Tipo: $("#quickJobType").value,
      Descripcion: description,
      Cantidad: quantity,
      PrecioUnitario: price,
    });
    delete q.pendingJobDraft;
    renderQuickIntake(false);
  };
  document.querySelectorAll("[data-quick-remove]").forEach((button) => {
    button.onclick = () => {
      quickCapture();
      capturePendingJob();
      q.jobs.splice(Number(button.dataset.quickRemove), 1);
      renderQuickIntake(false);
    };
  });
  $("#quickSubmit").onclick = saveQuickIntake;
  document
    .querySelector("[data-quick-order-field='Descuento']")
    ?.addEventListener("input", (event) => {
      q.order.Descuento = event.target.value;
      const amount = Math.max(
        0,
        q.jobs.reduce(
          (sum, job) => sum + Number(job.Cantidad) * Number(job.PrecioUnitario),
          0,
        ) - Number(q.order.Descuento || 0),
      );
      $("#quickTotal").textContent = money(amount);
    });
}
async function saveQuickIntake() {
  const q = state.quick;
  if (!q || q.saving) return;
  quickCapture();
  const existingClient = q.clientMode === "existing";
  if (existingClient && !q.clientId)
    return toast("Seleccioná un cliente o registrá uno nuevo.");
  if (!existingClient && (!q.client.Nombre.trim() || !q.client.WhatsApp.trim()))
    return toast("Completá nombre y WhatsApp del nuevo cliente.");
  const existingBike = existingClient && q.motoMode === "existing";
  if (
    existingBike &&
    (!q.motoId || !recordBike(q.motoId) || !motoIsActive(recordBike(q.motoId)))
  )
    return toast("Seleccioná una moto activa o registrá una nueva.");
  if (
    !existingBike &&
    !["Patente", "Marca", "Modelo"].every((field) =>
      String(q.moto[field]).trim(),
    )
  )
    return toast("Completá patente, marca y modelo de la moto.");
  if (!q.order.FechaIngreso || !q.order.Problema.trim())
    return toast("Completá fecha y problema informado.");
  if (Number(q.order.Descuento || 0) < 0)
    return toast("El descuento no puede ser negativo.");
  if (existingBike && recordBike(q.motoId)?.IDCliente !== q.clientId)
    return toast("La moto no pertenece al cliente seleccionado.");
  if (!existingBike && existingClient) {
    const duplicate = activeClientBikes(q.clientId).find(
      (bike) =>
        normalizeSearch(bike.Patente) === normalizeSearch(q.moto.Patente),
    );
    if (duplicate)
      return toast(
        "Esa patente ya pertenece a una moto activa del cliente. Seleccionala para no duplicarla.",
      );
  }
  q.saving = true;
  const btn = $("#quickSubmit");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Guardando cliente, moto y trabajo…";
  }
  try {
    const result = await api("saveIntake", {
      intakeId: q.id,
      clientId: existingClient ? q.clientId : "",
      client: existingClient
        ? null
        : {
            ...q.client,
            Telefono: q.client.WhatsApp.trim(),
            WhatsApp: q.client.WhatsApp.trim(),
            Activo: true,
          },
      motoId: existingBike ? q.motoId : "",
      moto: existingBike ? null : { ...q.moto, Activo: true },
      order: {
        ...q.order,
        Estado: "Recibida",
        Descuento: Number(q.order.Descuento || 0),
      },
      details: q.jobs,
      advance: null,
    });
    if (!result?.order?.IDOrden)
      throw Error("El servidor no confirmó la orden.");
    const orderId = result.order.IDOrden;

    applyIntakeResult(result);
    state.quick = null;
    state.view = "Ordenes_Trabajo";
    state.orderFilter = "";

    // Los registros ya fueron confirmados por el servidor
    // y actualizados en memoria mediante applyIntakeResult().
    toast("Ingreso completo guardado. Ya podés continuar el trabajo.");
    orderDetail(orderId);
  } catch (error) {
    if (error instanceof SessionExpiredError) showLogin(error.message);
    else
      toast(
        `No se pudo completar el ingreso: ${error.message}. Podés reintentar sin generar otro ingreso.`,
      );
  } finally {
    q.saving = false;
    const button = $("#quickSubmit");
    if (button && state.quick === q) {
      button.disabled = false;
      button.textContent = "GUARDAR TODO Y ABRIR TRABAJO";
    }
  }
}

function orderCard(o) {
  const t = totals(o.IDOrden),
    m = (state.db.Motos || []).find((x) => x.IDMoto === o.IDMoto),
    title = m ? `${m.Patente} · ${m.Marca} ${m.Modelo}` : moto(o.IDMoto),
    date = o.FechaIngreso ? argentinaDate(o.FechaIngreso) : "Sin fecha";
  return `<article class="item order-card"><div class="itemhead"><div><strong>${esc(title)}</strong><div class="order-meta"><span>Ingreso: ${esc(date)}</span><span>${esc(o.Problema || "Sin detalle")}</span></div></div><span class="badge" data-state="${esc(o.Estado)}">${esc(o.Estado || "Sin estado")}</span></div><p class="amounts"><span>Total <b>${money(t.total)}</b></span><span>Cobrado <b>${money(t.paid)}</b></span><span>Saldo <b class="due">${money(t.due)}</b></span></p><button data-open="${esc(o.IDOrden)}">Abrir orden</button><button class="ghost" data-edit="Ordenes_Trabajo:${esc(o.IDOrden)}">Editar</button></article>`;
}

function orderCardView(order) {
  const t = totals(order.IDOrden);

  const bike = recordBike(order.IDMoto);

  const owner =
    bike &&
    (state.db.Clientes || []).find((x) => x.IDCliente === bike.IDCliente);

  const title = [
    owner?.Nombre || "Cliente no encontrado",
    bike?.Patente,
    bike?.Marca,
    bike?.Modelo,
  ]
    .filter(Boolean)
    .join(" · ");

  const open = !["Entregada", "Cancelada"].includes(order.Estado);

  return `
    <article class="item order-row">

      <div class="order-row-main">
        <strong>
          ${esc(title || "Moto no encontrada")}
        </strong>

        <div class="order-meta">
          <span>
            ${esc(argentinaDate(order.FechaIngreso))}
          </span>

          <span>
            ${esc(order.Problema || "Sin problema informado")}
          </span>
        </div>
      </div>

      <div class="order-row-status">
        <span
          class="badge"
          data-state="${esc(order.Estado)}"
        >
          ${esc(orderStageLabel(order.Estado))}
        </span>
      </div>

      <div class="order-row-money">
        <span>
          Presupuesto <b>${money(t.total)}</b>
        </span>

        <span>
          Saldo <b class="due">${money(t.due)}</b>
        </span>
      </div>

      <div class="order-row-actions">

        <button
          type="button"
          data-open="${esc(order.IDOrden)}"
        >
          Abrir trabajo
        </button>

        <button
          type="button"
          class="ghost"
          data-order-whatsapp="${esc(order.IDOrden)}"
        >
          WhatsApp
        </button>

        ${
          open
            ? `
              <button
                type="button"
                class="ghost"
                data-deliver="${esc(order.IDOrden)}"
              >
                💰 Registrar pago y entregar
              </button>
            `
            : ""
        }

      </div>

    </article>
  `;
}

function argentinaDate(value) {
  const text = String(value || ""),
    plainDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (plainDate) return `${plainDate[3]}/${plainDate[2]}/${plainDate[1]}`;
  const date = new Date(text);
  return Number.isNaN(date.getTime())
    ? "Sin fecha"
    : date.toLocaleDateString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
      });
}
function normalizeWhatsApp(value, fallback = false) {
  const original = String(value || "").trim();
  if (!original) return "";
  const international = /^(?:\+|00)/.test(original);
  let digits = original.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("549") && digits.length === 13) return digits;
  if (digits.startsWith("54") && digits.length === 12)
    return `549${digits.slice(2)}`;
  if (!fallback && digits.length === 10) return `549${digits}`;
  if (!fallback && digits.startsWith("9") && digits.length === 11)
    return `54${digits}`;
  if (international && digits.length >= 8 && digits.length <= 15) return digits;
  return "";
}
const whatsappIcon =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a9.8 9.8 0 0 0-8.4 14.8L2.5 21.5l4.8-1.1A9.8 9.8 0 1 0 12 2Zm0 17.8a8 8 0 0 1-4.1-1.1l-.3-.2-2.8.7.8-2.7-.2-.3A8 8 0 1 1 12 19.8Zm4.4-6c-.2-.1-1.4-.7-1.6-.7s-.3-.1-.5.2-.6.7-.7.8-.3.2-.5.1a6.5 6.5 0 0 1-1.9-1.2 7 7 0 0 1-1.3-1.7c-.1-.2 0-.4.1-.5l.4-.4c.1-.1.2-.3.2-.4s0-.3-.1-.4l-.7-1.5c-.2-.4-.4-.3-.5-.3h-.4c-.2 0-.4.1-.6.3s-.8.8-.8 2 .8 2.3.9 2.5a9.2 9.2 0 0 0 3.5 3.1c.5.2 1 .4 1.3.5.5.2 1 .2 1.4.1.4-.1 1.4-.6 1.6-1.2.2-.6.2-1.1.1-1.2s-.2-.2-.4-.3Z"/></svg>';

/* =========================================================
   MOTOMANIA - FICHA INDIVIDUAL DEL CLIENTE
   Incluye WhatsApp con presupuesto o mensaje libre
   ========================================================= */

function customerDetail(id, remember = true) {
  const customer = (state.db.Clientes || []).find(
    (row) => String(row.IDCliente) === String(id),
  );

  if (!customer) {
    toast("No se encontró el cliente.");
    return;
  }
  if (remember) rememberScreen({ kind: "customer", id });

  state.galleryAbortController?.abort();
  state.activeOrderId = "";
  state.galleryRequest += 1;

  // MOTOS DEL CLIENTE
  const bikes = (state.db.Motos || []).filter(
    (row) => String(row.IDCliente) === String(id),
  );

  const active = bikes.filter(motoIsActive);

  const inactive = bikes.filter((bike) => !motoIsActive(bike));

  // DATOS DE CONTACTO
  const phone = String(customer.WhatsApp || customer.Telefono || "").trim();

  const whatsapp =
    normalizeWhatsApp(customer.WhatsApp) ||
    normalizeWhatsApp(customer.Telefono, true);

  // BOTONES DE CONTACTO
  const actions = [
    phone
      ? `
        <a
          class="contact-link"
          href="tel:${esc(phone.replace(/[^+\d]/g, ""))}"
        >
          📞 Llamar
        </a>
      `
      : "",

    whatsapp
      ? `
        <button
          type="button"
          class="contact-link contact-whatsapp"
          id="customerWhatsAppButton"
        >
          ${whatsappIcon}
          WhatsApp
        </button>
      `
      : "",
  ]
    .filter(Boolean)
    .join("");

  // INFORMACION DEL CLIENTE
  const details = [
    ["WhatsApp", customer.WhatsApp || customer.Telefono],
    ["DNI", customer.DNI],
    ["Domicilio", customer.Domicilio],
    ["Observaciones", customer.Observaciones],
  ]
    .filter(([, value]) => String(value || "").trim())

    .map(
      ([label, value]) => `
      <div class="contact-field">
        <small>${esc(label)}</small>
        <strong>${esc(value)}</strong>
      </div>
    `,
    )

    .join("");

  // PANTALLA COMPLETA
  $("#content").innerHTML = `

    <div class="toolbar">

      <div>
        <h2>Ficha del cliente</h2>
        <p class="muted">
          Motos y trabajos asociados.
        </p>
      </div>

      <button
        type="button"
        class="ghost"
        id="back"
      >
        ← Volver a clientes
      </button>

    </div>

    <section class="panel contact-profile">

      <div class="contact-profile-head">

        <div class="contact-avatar">
          ${esc((customer.Nombre || "C").trim().charAt(0).toUpperCase())}
        </div>

        <div>

          <h2>
            ${esc(customer.Nombre || "Sin nombre")}
          </h2>

          <p class="muted">
            ${active.length}
            moto${active.length === 1 ? "" : "s"}
            activa${active.length === 1 ? "" : "s"}
          </p>

        </div>

      </div>

      <div class="contact-actions">

        ${actions}

        <button
          type="button"
          class="ghost"
          data-edit="Clientes:${esc(id)}"
        >
          Editar cliente
        </button>

        <button
          type="button"
          data-add-client-moto="${esc(id)}"
        >
          + AGREGAR MOTO
        </button>

        <button
          type="button"
          class="ghost"
          data-quick-client="${esc(id)}"
        >
          + NUEVO TRABAJO
        </button>

      </div>

      <div class="contact-fields">

        ${details || '<p class="muted">Sin datos adicionales.</p>'}

      </div>

    </section>

    <div class="toolbar">
      <h2>Motos activas (${active.length})</h2>
    </div>

    <div class="list">

      ${
        active.map(motoCard).join("") ||
        '<div class="empty">Sin motos activas. Podés agregar una ahora.</div>'
      }

    </div>

    ${
      inactive.length
        ? `
          <details class="inactive-section">

            <summary>
              Motos dadas de baja (${inactive.length})
            </summary>

            <div class="list">
              ${inactive.map(motoCard).join("")}
            </div>

          </details>
        `
        : ""
    }

  `;

  // VOLVER A CLIENTES
  $("#back").onclick = () => goBack({ kind: "view", view: "Clientes" });

  // CONECTAR BOTONES EXISTENTES
  wire();

  // WHATSAPP CON LAS DOS OPCIONES
  const whatsappButton = $("#customerWhatsAppButton");

  if (whatsappButton) {
    whatsappButton.onclick = () => {
      openContactWhatsApp(customer.IDCliente);
    };
  }
}

function customerCard(client) {
  const whatsapp = String(client.WhatsApp || client.Telefono || "").trim();
  const waNumber =
    normalizeWhatsApp(client.WhatsApp) ||
    normalizeWhatsApp(client.Telefono, true);
  const bikesCount = activeClientBikes(client.IDCliente).length;
  return `<article class="item customer-card"><div class="itemhead"><div><strong>${esc(client.Nombre || "Cliente sin nombre")}</strong>${whatsapp ? `<small>WhatsApp: ${esc(whatsapp)}</small>` : ""}</div><div class="customer-actions">${waNumber ? `<a class="whatsapp-button" href="https://wa.me/${waNumber}" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp de ${esc(client.Nombre)}">${whatsappIcon} WhatsApp</a>` : ""}<button data-open-client="${esc(client.IDCliente)}">Ver ficha · ${bikesCount} motos</button><button class="ghost" data-add-client-moto="${esc(client.IDCliente)}">+ Moto</button><button class="ghost" data-quick-client="${esc(client.IDCliente)}">+ Trabajo</button></div></div>${client.Domicilio ? `<small>${esc(client.Domicilio)}</small>` : ""}</article>`;
}

function motoIsActive(bike) {
  return !["false", "0", "no", "inactivo", "baja"].includes(
    String(bike?.Activo ?? "")
      .trim()
      .toLowerCase(),
  );
}

async function setMotoActive(id, active) {
  const bike = (state.db.Motos || []).find((row) => row.IDMoto === id);
  if (!bike) return toast("No se encontró la moto.");
  if (motoIsActive(bike) === active) return;
  const accepted = await confirmModal({
    title: active ? "¿Reactivar esta moto?" : "¿Dar de baja esta moto?",
    message: active
      ? "Volverá a aparecer entre las motos activas. Todo su historial se conserva."
      : "La moto quedará oculta del listado habitual. No se borrarán sus trabajos, fotos ni cobros.",
    confirmText: active ? "Reactivar moto" : "Dar de baja",
    cancelText: "Cancelar",
    danger: !active,
  });
  if (!accepted) return;
  await withSession(async () => {
    await api("save", {
      table: "Motos",
      record: { IDMoto: id, Activo: active },
    });
    toast(
      active
        ? "Moto reactivada correctamente."
        : "Moto dada de baja correctamente.",
    );
    await load();
    if (state.view === "Motos") motoDetail(id);
    else if (state.view === "Clientes" && bike.IDCliente)
      customerDetail(bike.IDCliente);
  });
}

function motoCard(bike) {
  const owner = (state.db.Clientes || []).find(
    (row) => row.IDCliente === bike.IDCliente,
  );
  const historyCount = (state.db.Ordenes_Trabajo || []).filter(
    (row) => row.IDMoto === bike.IDMoto,
  ).length;
  const title =
    [bike.Patente, bike.Marca, bike.Modelo].filter(Boolean).join(" · ") ||
    "Moto sin identificar";
  const active = motoIsActive(bike);
  return `<article class="item moto-card"><div class="itemhead"><div><strong>${esc(title)}</strong><small>Cliente: ${esc(owner?.Nombre || "Sin cliente")} · ${historyCount} trabajos</small></div><div class="customer-actions"><button data-open-moto="${esc(bike.IDMoto)}">Ver historial</button>${active ? `<button data-quick-moto="${esc(bike.IDMoto)}">+ Trabajo</button>` : '<span class="muted">Moto dada de baja</span>'}<button class="ghost" data-edit="Motos:${esc(bike.IDMoto)}">Editar</button><button class="ghost" data-moto-active="${esc(bike.IDMoto)}" data-active="${active ? "false" : "true"}">${active ? "Dar de baja" : "Reactivar"}</button></div></div></article>`;
}

function paymentCard(payment) {
  const order = (state.db.Ordenes_Trabajo || []).find(
      (row) => row.IDOrden === payment.IDOrden,
    ),
    bike =
      order &&
      (state.db.Motos || []).find((row) => row.IDMoto === order.IDMoto),
    client =
      bike &&
      (state.db.Clientes || []).find((row) => row.IDCliente === bike.IDCliente),
    bikeName = bike
      ? [bike.Patente, bike.Marca, bike.Modelo].filter(Boolean).join(" · ")
      : "";
  return `<article class="item payment-card"><div class="itemhead"><div><span class="badge payment-method">${esc(payment.Medio || "Sin medio")}</span><strong>${money(Number(payment.Importe) || 0)}</strong></div><button class="ghost" data-edit="Pagos:${esc(payment.IDPago)}">Editar</button></div><div class="payment-details"><span>Fecha <b>${esc(argentinaDate(payment.Fecha))}</b></span>${payment.IDOrden ? `<span>Orden <b>${esc(payment.IDOrden)}</b></span>` : ""}${client ? `<span>Cliente <b>${esc(client.Nombre)}</b></span>` : ""}${bikeName ? `<span>Moto <b>${esc(bikeName)}</b></span>` : ""}</div>${payment.Observaciones ? `<p class="payment-note">${esc(payment.Observaciones)}</p>` : ""}</article>`;
}
function isDuplicatedPaymentHeader(row) {
  return (
    String(row?.IDPago || "").trim() === "IDPago" &&
    String(row?.IDOrden || "").trim() === "IDOrden"
  );
}
// Búsqueda cruzada: clientes <-> motos, sin modificar el backend.
function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
function searchableRecord(table, record) {
  const related = [];
  if (table === "Clientes") {
    related.push(
      ...(state.db.Motos || []).filter(
        (bike) => String(bike.IDCliente) === String(record.IDCliente),
      ),
    );
  } else if (table === "Ordenes_Trabajo") {
    const bike = recordBike(record.IDMoto);
    if (bike) {
      related.push(bike);
      const owner = (state.db.Clientes || []).find(
        (c) => c.IDCliente === bike.IDCliente,
      );
      if (owner) related.push(owner);
    }
  } else if (table === "Motos") {
    const owner = (state.db.Clientes || []).find(
      (client) => String(client.IDCliente) === String(record.IDCliente),
    );
    if (owner) related.push(owner);
  }
  return [record, ...related]
    .flatMap((row) => Object.values(row || {}))
    .map(normalizeSearch)
    .join(" ");
}

// =====================================================
// MOTOMANIA - LISTADO DE CLIENTES EN FORMATO TABLA
// Ordenamiento por fecha de alta o nombre alfabetico
// =====================================================

/* =========================================================
   MOTOMANIA - TABLA DE CLIENTES
   Orden por fecha / alfabetico
   Busqueda por cliente, telefono o patente
   Acciones: ficha, moto, trabajo y WhatsApp
   ========================================================= */

function renderClientsTable() {
  const clientes = [...(state.db.Clientes || [])];

  let ordenActual = "fecha";

  $("#content").innerHTML = `
    <div class="toolbar">
      <div>
        <h2>Clientes</h2>
        <p class="muted">${clientes.length} clientes registrados</p>
      </div>

      <button type="button" data-add="Clientes">
        + Nuevo cliente
      </button>
    </div>

    <div class="clients-table-tools">

      <input
        id="search"
        type="search"
        placeholder="Buscar cliente, WhatsApp o patente..."
        autocomplete="off"
      >

      <div class="clients-sort-actions">

        <button
          type="button"
          id="sortClientsByDate"
          class="ghost clients-sort-button is-active"
        >
          ↓ Más recientes primero
        </button>

        <button
          type="button"
          id="sortClientsByName"
          class="ghost clients-sort-button"
        >
          A–Z Orden alfabético
        </button>

      </div>

    </div>

    <div class="clients-table-wrap">

      <table class="clients-table">

        <thead>
          <tr>
            <th>Cliente</th>
            <th>WhatsApp</th>
            <th>Motos activas</th>
            <th>Fecha de alta</th>
            <th>Acciones</th>
          </tr>
        </thead>

        <tbody id="clientsRows"></tbody>

      </table>

    </div>

    <p id="clientsCount" class="muted"></p>
  `;

  // -------------------------------------------------------
  // ACTUALIZAR TABLA
  // -------------------------------------------------------

  function actualizarTabla() {
    const busqueda = $("#search").value.trim();

    const terminos = busqueda.split(/\s+/).filter(Boolean).map(normalizeSearch);

    let resultado = clientes
      .map((cliente, indice) => ({
        cliente,
        indice,
      }))
      .filter(({ cliente }) => {
        const contenido = searchableRecord("Clientes", cliente);

        return terminos.every((termino) => contenido.includes(termino));
      });

    // -----------------------------------------------------
    // ORDENAMIENTO
    // -----------------------------------------------------

    if (ordenActual === "nombre") {
      resultado.sort((a, b) =>
        String(a.cliente.Nombre || "").localeCompare(
          String(b.cliente.Nombre || ""),
          "es",
          { sensitivity: "base" },
        ),
      );
    } else {
      resultado.sort((a, b) => {
        const fechaA = Date.parse(a.cliente.FechaAlta || "");

        const fechaB = Date.parse(b.cliente.FechaAlta || "");

        const valorA = Number.isFinite(fechaA) ? fechaA : 0;

        const valorB = Number.isFinite(fechaB) ? fechaB : 0;

        return valorB - valorA || b.indice - a.indice;
      });
    }

    // -----------------------------------------------------
    // GENERAR RENGLONES
    // -----------------------------------------------------

    $("#clientsRows").innerHTML =
      resultado
        .map(({ cliente }) => {
          const nombre = cliente.Nombre || "Sin nombre";

          const whatsapp = cliente.WhatsApp || cliente.Telefono || "";

          const numero =
            normalizeWhatsApp(cliente.WhatsApp) ||
            normalizeWhatsApp(cliente.Telefono, true);

          const cantidadMotos = (state.db.Motos || []).filter(
            (moto) =>
              String(moto.IDCliente) === String(cliente.IDCliente) &&
              motoIsActive(moto),
          ).length;

          const fecha = cliente.FechaAlta
            ? argentinaDate(cliente.FechaAlta)
            : "—";

          return `
        <tr>

          <td class="clients-name">
            ${esc(nombre)}
          </td>

          <td>
            ${esc(whatsapp || "—")}
          </td>

          <td class="clients-number">
            ${cantidadMotos}
          </td>

          <td class="clients-date">
            ${esc(fecha)}
          </td>

          <td>

            <div class="clients-row-actions">

              <button
                type="button"
                data-open-client="${esc(cliente.IDCliente)}"
              >
                Ver ficha
              </button>

              <button
                type="button"
                class="ghost"
                data-add-client-moto="${esc(cliente.IDCliente)}"
              >
                + Moto
              </button>

              <button
                type="button"
                class="ghost"
                data-quick-client="${esc(cliente.IDCliente)}"
              >
                + Trabajo
              </button>

              <button
                type="button"
                class="ghost"
                data-contact-whatsapp="${esc(cliente.IDCliente)}"
                ${numero ? "" : "disabled"}
              >
                WhatsApp
              </button>

            </div>

          </td>

        </tr>
      `;
        })
        .join("") ||
      `
      <tr>
        <td colspan="5" class="clients-empty">
          No se encontraron clientes.
        </td>
      </tr>
    `;

    $("#clientsCount").textContent = `${resultado.length} cliente(s) mostrados`;

    // Reconectar las acciones existentes.
    wire();

    // Conectar los botones WhatsApp de esta tabla.
    document.querySelectorAll("[data-contact-whatsapp]").forEach((button) => {
      button.onclick = () => {
        const clientId = button.dataset.contactWhatsapp;

        openContactWhatsApp(clientId);
      };
    });
  }

  // -------------------------------------------------------
  // BUSCADOR
  // -------------------------------------------------------

  $("#search").addEventListener("input", actualizarTabla);

  // -------------------------------------------------------
  // ORDENAMIENTO POR FECHA
  // -------------------------------------------------------

  $("#sortClientsByDate").onclick = () => {
    ordenActual = "fecha";

    $("#sortClientsByDate").classList.add("is-active");

    $("#sortClientsByName").classList.remove("is-active");

    actualizarTabla();
  };

  // -------------------------------------------------------
  // ORDENAMIENTO ALFABETICO
  // -------------------------------------------------------

  $("#sortClientsByName").onclick = () => {
    ordenActual = "nombre";

    $("#sortClientsByName").classList.add("is-active");

    $("#sortClientsByDate").classList.remove("is-active");

    actualizarTabla();
  };

  // -------------------------------------------------------
  // PRIMERA CARGA
  // -------------------------------------------------------

  actualizarTabla();
}

/* =========================================================
   MOTOMANIA - TABLA COMPACTA DE MOTOS
   Ordenar por patente, moto o dueño.
   ========================================================= */

/* =========================================================
   MOTOMANIA - TABLA COMPACTA DE MOTOS
   Ordenar por patente, moto o dueño
   Acciones: historial, trabajo, editar, baja y WhatsApp
   ========================================================= */

function renderMotosTable() {
  const motos = [...(state.db.Motos || [])];

  const clientes = new Map(
    (state.db.Clientes || []).map((c) => [String(c.IDCliente), c]),
  );

  let orden = "patente";

  const nombreDueno = (bike) =>
    clientes.get(String(bike.IDCliente))?.Nombre || "Sin dueño";

  const nombreMoto = (bike) =>
    [bike.Marca, bike.Modelo].filter(Boolean).join(" ") || "Sin identificar";

  const comparar = (a, b) =>
    String(a || "").localeCompare(String(b || ""), "es", {
      sensitivity: "base",
      numeric: true,
    });

  // -------------------------------------------------------
  // ESTRUCTURA DE LA PANTALLA
  // -------------------------------------------------------

  $("#content").innerHTML = `
    <div class="toolbar">

      <div>
        <h2>Motos</h2>
        <p class="muted" id="motosCount"></p>
      </div>

      <button type="button" data-add="Motos">
        + Nueva moto
      </button>

    </div>

    <div class="motos-table-tools">

      <input
        id="search"
        type="search"
        placeholder="Buscar patente, marca, modelo o dueño..."
        autocomplete="off"
      >

      <div class="motos-sort-actions">

        <button
          type="button"
          class="ghost is-active"
          data-motos-sort="patente"
        >
          Por patente
        </button>

        <button
          type="button"
          class="ghost"
          data-motos-sort="moto"
        >
          Por moto
        </button>

        <button
          type="button"
          class="ghost"
          data-motos-sort="dueno"
        >
          Por dueño
        </button>

      </div>

    </div>

    <label class="motos-inactive-filter">

      <input
        type="checkbox"
        id="showInactiveMotos"
      >

      Mostrar motos dadas de baja

    </label>

    <div class="motos-table-wrap">

      <table class="motos-table">

        <thead>
          <tr>
            <th>Patente</th>
            <th>Moto</th>
            <th>Dueño</th>
            <th>Trabajos</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>

        <tbody id="motosRows"></tbody>

      </table>

    </div>
  `;

  // -------------------------------------------------------
  // ACTUALIZAR TABLA
  // -------------------------------------------------------

  function actualizarTabla() {
    const terminos = ($("#search").value || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(normalizeSearch);

    const mostrarInactivas = $("#showInactiveMotos").checked;

    const resultado = motos

      .filter((bike) => mostrarInactivas || motoIsActive(bike))

      .filter((bike) => {
        const texto = searchableRecord("Motos", bike);

        return terminos.every((t) => texto.includes(t));
      });

    // -----------------------------------------------------
    // ORDENAMIENTO
    // -----------------------------------------------------

    resultado.sort((a, b) => {
      let diferencia = 0;

      if (orden === "patente") {
        diferencia = comparar(a.Patente, b.Patente);
      }

      if (orden === "moto") {
        diferencia = comparar(nombreMoto(a), nombreMoto(b));
      }

      if (orden === "dueno") {
        diferencia = comparar(nombreDueno(a), nombreDueno(b));
      }

      return diferencia || comparar(a.Patente, b.Patente);
    });

    $("#motosCount").textContent = `${resultado.length} motos mostradas`;

    // -----------------------------------------------------
    // GENERAR RENGLONES DE LA TABLA
    // -----------------------------------------------------

    $("#motosRows").innerHTML =
      resultado
        .map((bike) => {
          const activa = motoIsActive(bike);

          const owner = clientes.get(String(bike.IDCliente));

          const trabajos = (state.db.Ordenes_Trabajo || []).filter(
            (o) => String(o.IDMoto) === String(bike.IDMoto),
          ).length;

          const telefonoWhatsApp = owner
            ? normalizeWhatsApp(owner.WhatsApp) ||
              normalizeWhatsApp(owner.Telefono, true)
            : "";

          return `
        <tr class="${activa ? "" : "moto-inactiva"}">

          <td class="motos-patente">
            ${esc(bike.Patente || "Sin patente")}
          </td>

          <td>
            ${esc(nombreMoto(bike))}
          </td>

          <td>
            ${
              owner
                ? `
                  <button
                    type="button"
                    class="motos-owner-link"
                    data-open-client="${esc(owner.IDCliente)}"
                  >
                    ${esc(owner.Nombre)}
                  </button>
                `
                : "Sin dueño"
            }
          </td>

          <td class="motos-number">
            ${trabajos}
          </td>

          <td>
            <span class="motos-status ${activa ? "activo" : "baja"}">
              ${activa ? "Activa" : "Baja"}
            </span>
          </td>

          <td>

            <div class="motos-row-actions">

              <button
                type="button"
                data-open-moto="${esc(bike.IDMoto)}"
              >
                Historial
              </button>

              ${
                activa
                  ? `
                    <button
                      type="button"
                      data-quick-moto="${esc(bike.IDMoto)}"
                    >
                      + Trabajo
                    </button>
                  `
                  : ""
              }

              <button
                type="button"
                class="ghost"
                data-edit="Motos:${esc(bike.IDMoto)}"
              >
                Editar
              </button>

              <button
                type="button"
                class="ghost"
                data-moto-active="${esc(bike.IDMoto)}"
                data-active="${activa ? "false" : "true"}"
              >
                ${activa ? "Dar de baja" : "Reactivar"}
              </button>

              <button
                type="button"
                class="ghost"
                data-moto-whatsapp="${esc(bike.IDMoto)}"
                ${telefonoWhatsApp ? "" : "disabled"}
              >
                WhatsApp
              </button>

            </div>

          </td>

        </tr>
      `;
        })
        .join("") ||
      `
      <tr>
        <td colspan="6" class="motos-empty">
          No se encontraron motos.
        </td>
      </tr>
    `;

    // -----------------------------------------------------
    // CONECTAR BOTONES EXISTENTES
    // -----------------------------------------------------

    wire();

    // -----------------------------------------------------
    // CONECTAR WHATSAPP
    // -----------------------------------------------------

    document.querySelectorAll("[data-moto-whatsapp]").forEach((button) => {
      button.onclick = () => {
        const motoId = button.dataset.motoWhatsapp;

        const bike = (state.db.Motos || []).find(
          (m) => String(m.IDMoto) === String(motoId),
        );

        if (!bike) {
          toast("No se encontró la moto.");
          return;
        }

        // Abre las opciones de WhatsApp del dueño,
        // filtrando presupuestos por la moto elegida.
        openContactWhatsApp(bike.IDCliente, bike.IDMoto);
      };
    });
  }

  // -------------------------------------------------------
  // BUSCADOR
  // -------------------------------------------------------

  $("#search").addEventListener("input", actualizarTabla);

  // -------------------------------------------------------
  // MOSTRAR MOTOS DADAS DE BAJA
  // -------------------------------------------------------

  $("#showInactiveMotos").addEventListener("change", actualizarTabla);

  // -------------------------------------------------------
  // BOTONES DE ORDENAMIENTO
  // -------------------------------------------------------

  document.querySelectorAll("[data-motos-sort]").forEach((button) => {
    button.onclick = () => {
      orden = button.dataset.motosSort;

      document.querySelectorAll("[data-motos-sort]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.motosSort === orden);
      });

      actualizarTabla();
    };
  });

  // -------------------------------------------------------
  // PRIMERA CARGA
  // -------------------------------------------------------

  actualizarTabla();
}

/* ==========================================================
   MOTOMANÍA - TABLA COMPACTA DE SERVICIOS
   Orden alfabético y por precio
   Búsqueda y edición rápida
   ========================================================== */

/* ==========================================================
   MOTOMANÍA — TABLA DE SERVICIOS
   Búsqueda, orden alfabético y orden por precio
   ========================================================== */

function servicesView() {
  const servicesStatus = state.tableStatus?.Servicios?.status || "unloaded";
  const servicesError = state.tableStatus?.Servicios?.error;

  if (servicesStatus === "unloaded") {
    $("#content").innerHTML = `
      <div class="toolbar">
        <div>
          <h2>Servicios</h2>
          <p class="muted">Cargando servicios...</p>
        </div>
      </div>
    `;
    ensureTablesLoaded(["Servicios"])
      .then(() => {
        if (state.view === "Servicios") render();
      })
      .catch(() => {
        if (state.view === "Servicios") render();
      });
    return;
  }

  if (servicesStatus === "loading") {
    $("#content").innerHTML = `
      <div class="toolbar">
        <div>
          <h2>Servicios</h2>
          <p class="muted">Cargando servicios...</p>
        </div>
      </div>
    `;
    return;
  }

  if (servicesStatus === "error") {
    $("#content").innerHTML = `
      <div class="toolbar">
        <div>
          <h2>Servicios</h2>
          <p class="error">No se pudieron cargar los servicios${servicesError ? `: ${esc(servicesError)}` : "."}</p>
        </div>
      </div>
    `;
    return;
  }

  const servicios = [...(state.db.Servicios || [])];

  const estaActivo = (servicio) => {
    return !["false", "0", "no", "inactivo", "baja"].includes(
      String(servicio.Activo ?? "")
        .trim()
        .toLowerCase(),
    );
  };

  const precioNumerico = (valor) => {
    if (valor === "" || valor == null) return null;

    let texto = String(valor).trim().replace(/[$\s]/g, "");

    if (texto.includes(",") && texto.includes(".")) {
      texto = texto.replace(/\./g, "").replace(",", ".");
    } else if (texto.includes(",")) {
      texto = texto.replace(",", ".");
    } else if (/^\d{1,3}(\.\d{3})+$/.test(texto)) {
      texto = texto.replace(/\./g, "");
    }

    const numero = Number(texto);

    return Number.isFinite(numero) && numero >= 0 ? numero : null;
  };

  const compararNombres = (a, b) =>
    String(a.Nombre || "").localeCompare(String(b.Nombre || ""), "es", {
      sensitivity: "base",
      numeric: true,
    });

  $("#content").innerHTML = `
    <div class="toolbar">
      <div>
        <h2>Servicios</h2>
        <p class="muted">
          ${servicios.length} servicios registrados
        </p>
      </div>

      <button type="button" data-add="Servicios">
        + Nuevo servicio
      </button>
    </div>

    <div class="services-table-tools">

      <input
        id="serviceSearch"
        type="search"
        placeholder="Buscar servicio..."
        autocomplete="off"
        value="${esc(state.serviceQuery || "")}"
      >

      <div class="services-sort-actions">

        <button
          type="button"
          id="sortServicesAlpha"
          class="ghost services-sort-button"
        >
          A–Z Orden alfabético
        </button>

        <button
          type="button"
          id="sortServicesPrice"
          class="ghost services-sort-button"
        >
          $ Orden por precio
        </button>

      </div>
    </div>

    <div class="services-table-wrap">
      <table class="services-table">

        <thead>
          <tr>
            <th>Servicio</th>
            <th>Precio sugerido</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>

        <tbody id="servicesRows"></tbody>

      </table>
    </div>

    <p id="servicesCount" class="muted"></p>
  `;

  function actualizarTabla() {
    const terminos = String(state.serviceQuery || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(normalizeSearch);

    const resultado = servicios.filter((servicio) => {
      const texto = normalizeSearch(
        [servicio.Nombre, servicio.IDServicio, servicio.PrecioSugerido].join(
          " ",
        ),
      );

      return terminos.every((termino) => texto.includes(termino));
    });

    resultado.sort((a, b) => {
      if (state.serviceSort === "price") {
        const precioA = precioNumerico(a.PrecioSugerido);
        const precioB = precioNumerico(b.PrecioSugerido);

        if (precioA === null && precioB !== null) return 1;
        if (precioB === null && precioA !== null) return -1;

        if (precioA !== null && precioB !== null) {
          if (precioA !== precioB) return precioA - precioB;
        }
      }

      return compararNombres(a, b);
    });

    $("#servicesRows").innerHTML =
      resultado
        .map((servicio) => {
          const activo = estaActivo(servicio);
          const precio = precioNumerico(servicio.PrecioSugerido);

          return `
        <tr class="${activo ? "" : "service-inactive"}">

          <td class="services-name">
            ${esc(servicio.Nombre || "Sin nombre")}
          </td>

          <td class="services-price">
            ${
              precio === null
                ? '<span class="muted">Sin precio</span>'
                : money(precio)
            }
          </td>

          <td>
            <span class="services-status ${activo ? "activo" : "inactivo"}">
              ${activo ? "Activo" : "Inactivo"}
            </span>
          </td>

          <td>
            <button
              type="button"
              class="ghost"
              data-edit="Servicios:${esc(servicio.IDServicio)}"
            >
              Editar
            </button>
          </td>

        </tr>
      `;
        })
        .join("") ||
      `
      <tr>
        <td colspan="4" class="services-empty">
          No se encontraron servicios.
        </td>
      </tr>
    `;

    // Contador corregido
    $("#servicesCount").textContent =
      `${resultado.length} servicio(s) mostrados`;

    $("#sortServicesAlpha").classList.toggle(
      "is-active",
      state.serviceSort !== "price",
    );

    $("#sortServicesPrice").classList.toggle(
      "is-active",
      state.serviceSort === "price",
    );

    // Reconectar botones de edición y alta
    wire();
  }

  $("#serviceSearch").addEventListener("input", (event) => {
    state.serviceQuery = event.target.value;
    actualizarTabla();
  });

  $("#sortServicesAlpha").onclick = () => {
    state.serviceSort = "alpha";
    actualizarTabla();
  };

  $("#sortServicesPrice").onclick = () => {
    state.serviceSort = "price";
    actualizarTabla();
  };

  actualizarTabla();
}

function list(table) {
  if (!defs[table]) return;

  if (table === "Repuestos") {
    const partsStatus = state.tableStatus?.Repuestos?.status || "unloaded";
    const partsError = state.tableStatus?.Repuestos?.error;

    if (partsStatus === "unloaded") {
      $("#content").innerHTML = `
        <div class="toolbar">
          <div>
            <h2>Repuestos</h2>
            <p class="muted">Cargando repuestos...</p>
          </div>
        </div>
      `;
      ensureTablesLoaded(["Repuestos"])
        .then(() => {
          if (state.view === "Repuestos") render();
        })
        .catch(() => {
          if (state.view === "Repuestos") render();
        });
      return;
    }

    if (partsStatus === "loading") {
      $("#content").innerHTML = `
        <div class="toolbar">
          <div>
            <h2>Repuestos</h2>
            <p class="muted">Cargando repuestos...</p>
          </div>
        </div>
      `;
      return;
    }

    if (partsStatus === "error") {
      $("#content").innerHTML = `
        <div class="toolbar">
          <div>
            <h2>Repuestos</h2>
            <p class="error">No se pudieron cargar los repuestos${partsError ? `: ${esc(partsError)}` : "."}</p>
          </div>
        </div>
      `;
      return;
    }
  }

  if (table === "Motos") {
    renderMotosTable();
    return;
  }

  // Clientes usa su tabla compacta en lugar de tarjetas.
  if (table === "Clientes") {
    renderClientsTable();
    return;
  }
  const original =
    table === "Pagos"
      ? (state.db[table] || []).filter((row) => !isDuplicatedPaymentHeader(row))
      : [...(state.db[table] || [])];
  const rows =
    table === "Ordenes_Trabajo"
      ? original
          .map((record, index) => ({ record, index }))
          .sort((a, b) => {
            const byDate = String(b.record.FechaIngreso || "").localeCompare(
              String(a.record.FechaIngreso || ""),
            );
            return byDate || b.index - a.index;
          })
          .map((entry) => entry.record)
      : original;
  const orderFilter = state.orderFilter;
  const activeFiltered = rows.filter((row) => {
    if (table === "Motos") return motoIsActive(row);
    if (table !== "Ordenes_Trabajo") return true;
    if (orderFilter === "open")
      return !["Entregada", "Cancelada"].includes(row.Estado);
    if (orderFilter === "ready") return row.Estado === "Lista para retirar";
    if (orderFilter === "parts") return row.Estado === "Esperando repuestos";
    return true;
  });
  const heading =
    table === "Ordenes_Trabajo" && orderFilter
      ? {
          open: "Trabajos abiertos",
          ready: "Listas para retirar",
          parts: "Esperando repuestos",
        }[orderFilter]
      : defs[table].title;
  $("#content").innerHTML =
    `<div class="toolbar"><div><h2>${heading}</h2><p class="muted">${activeFiltered.length} registro${activeFiltered.length === 1 ? "" : "s"}${table === "Ordenes_Trabajo" ? " · más recientes primero" : ""}</p></div><div class="toolbar-actions">${table === "Ordenes_Trabajo" && orderFilter ? '<button type="button" class="ghost" id="clearOrderFilter">Ver todos los trabajos</button>' : ""}<button data-add="${table}">+ ${table === "Ordenes_Trabajo" ? "NUEVO INGRESO" : "Nuevo"}</button></div></div>
  ${table === "Motos" ? '<label class="show-inactive"><input type="checkbox" id="showInactiveMotos"> Mostrar motos dadas de baja</label>' : ""}
  <input id="search" placeholder="${table === "Ordenes_Trabajo" ? "Buscar cliente, patente, marca o problema…" : "Buscar nombre, patente o descripción…"}" aria-label="Buscar en ${defs[table].title}"><div class="list ${table === "Ordenes_Trabajo" ? "order-list" : ""}" id="results"></div>`;
  $("#clearOrderFilter")?.addEventListener("click", () => {
    state.orderFilter = "";
    list(table);
  });
  const display = () => {
    const filtered = rows.filter((row) => {
      if (
        table === "Motos" &&
        !motoIsActive(row) &&
        !$("#showInactiveMotos")?.checked
      )
        return false;
      if (table === "Ordenes_Trabajo") {
        if (
          orderFilter === "open" &&
          ["Entregada", "Cancelada"].includes(row.Estado)
        )
          return false;
        if (orderFilter === "ready" && row.Estado !== "Lista para retirar")
          return false;
        if (orderFilter === "parts" && row.Estado !== "Esperando repuestos")
          return false;
      }
      const words = $("#search").value.trim().split(/\s+/).filter(Boolean);
      return words.every((word) =>
        searchableRecord(table, row).includes(normalizeSearch(word)),
      );
    });
    $("#results").innerHTML =
      filtered
        .map((row) =>
          table === "Clientes"
            ? customerCard(row)
            : table === "Motos"
              ? motoCard(row)
              : table === "Pagos"
                ? paymentCard(row)
                : table === "Ordenes_Trabajo"
                  ? orderCardView(row)
                  : `<div class="item"><strong>${esc(row.Nombre || row.Descripcion || row.IDServicio || row.IDRepuesto || row.IDDetalle)}</strong><button class="ghost" data-edit="${esc(table)}:${esc(row[{ Servicios: "IDServicio", Repuestos: "IDRepuesto", Detalle_Trabajo: "IDDetalle" }[table]])}">Editar</button></div>`,
        )
        .join("") || '<div class="empty">No se encontraron registros.</div>';
    wire();
  };
  $("#search").oninput = display;
  $("#showInactiveMotos")?.addEventListener("change", display);
  display();
}

function selectOpts(field, selectedValue = "") {
  let arr = [];
  if (field === "IDCliente")
    arr = state.db.Clientes.map((x) => [x.IDCliente, x.Nombre]);
  if (field === "IDMoto")
    arr = state.db.Motos.filter(
      (bike) =>
        motoIsActive(bike) || String(bike.IDMoto) === String(selectedValue),
    ).map((x) => [x.IDMoto, `${cliente(x.IDCliente)} · ${moto(x.IDMoto)}`]);
  if (field === "IDOrden")
    arr = state.db.Ordenes_Trabajo.map((x) => [
      x.IDOrden,
      `${cliente(recordBike(x.IDMoto)?.IDCliente)} · ${moto(x.IDMoto)} · ${orderStageLabel(x.Estado)}`,
    ]);
  if (field === "Estado") arr = ORDER_STAGES;
  if (field === "Tipo") arr = ["Servicio", "Repuesto"].map((x) => [x, x]);
  if (field === "Medio")
    arr = ["Efectivo", "Transferencia", "Débito", "Crédito", "QR", "Otro"].map(
      (x) => [x, x],
    );
  return arr;
}

function form(table, id = "", preset = {}, remember = true, orderId = "") {
  if (table === "Ordenes_Trabajo" && !id) {
    openQuickIntake({ motoId: preset.IDMoto || "" });
    return;
  }
  const isOrderEdit = Boolean(orderId && id && ["Clientes", "Motos", "Ordenes_Trabajo"].includes(table));
  if (remember) rememberScreen({ kind: "form", table, id, preset, orderId: isOrderEdit ? orderId : "" });
  const paymentOrderId =
    table === "Pagos" && !id ? state.paymentOrderContextId : "";
  const paymentOrder = paymentOrderId
    ? (state.db.Ordenes_Trabajo || []).find(
        (order) => order.IDOrden === paymentOrderId,
      )
    : null;
  const paymentContext = paymentOrder ? orderContext(paymentOrderId) : null;
  if (!paymentContext) state.paymentOrderContextId = "";
  state.activeOrderId = "";
  state.galleryRequest += 1;
  const def = defs[table];
  const pk = {
    Clientes: "IDCliente",
    Motos: "IDMoto",
    Ordenes_Trabajo: "IDOrden",
    Detalle_Trabajo: "IDDetalle",
    Pagos: "IDPago",
    Servicios: "IDServicio",
    Repuestos: "IDRepuesto",
  }[table];
  const existing = (state.db[table] || []).find((row) => row[pk] === id) || {};
  const row = { ...existing, ...preset };
  const formFields = isOrderEdit ? orderEditFields(table) : def.fields;
  const fields = formFields
    .map((field) => {
      const value = row[field] ?? "";
      const opts = selectOpts(field, value);
      const required = def.required.includes(field) ? "required" : "";
      const label =
        {
          IDCliente: "Cliente",
          IDMoto: "Moto (cliente · patente)",
          Telefono: "Teléfono",
          Anio: "Año",
          Cilindrada: "Cilindrada (cc)",
          FechaPrometida: "Fecha prometida",
          FechaEntrega: "Fecha de entrega",
          Problema: "Problema informado",
          PrecioUnitario: "Precio unitario",
        }[field] || field;
      const input = opts.length
        ? `<select name="${field}" ${required} ${paymentContext && field === "IDOrden" ? "disabled" : ""}><option value="">Seleccionar…</option>${opts.map(([v, text]) => `<option value="${esc(v)}" ${String(value) === String(v) ? "selected" : ""}>${esc(text)}</option>`).join("")}</select>${paymentContext && field === "IDOrden" ? `<input type="hidden" name="IDOrden" value="${esc(value)}">` : ""}`
        : ["Observaciones", "Problema", "Diagnostico"].includes(field)
          ? `<textarea name="${field}" ${required}>${esc(value)}</textarea>`
          : `<input name="${field}" value="${esc(field.startsWith("Fecha") ? String(value).slice(0, 10) : value)}" ${required} ${["Importe", "Cantidad", "PrecioUnitario", "PrecioSugerido", "Costo", "PrecioVenta", "Descuento", "Kilometraje", "Cilindrada", "Anio"].includes(field) ? `type="number" step="any" min="${table === "Pagos" && field === "Importe" ? "0.01" : "0"}"` : field.startsWith("Fecha") ? 'type="date"' : 'type="text"'}>`;
      return `<label>${esc(label)}${input}</label>`;
    })
    .join("");
  const clientNew = table === "Clientes" && !id;
  const bikeNew = table === "Motos" && !id;
  const extraButton = clientNew
    ? '<button type="submit" data-next="moto">GUARDAR Y AGREGAR MOTO →</button>'
    : bikeNew
      ? '<button type="submit" data-next="work">GUARDAR Y CREAR TRABAJO →</button>'
      : "";
  const paymentSummary = paymentContext
    ? `<section class="payment-order-summary panel"><p class="eyebrow">Resumen del trabajo</p><div class="payment-order-heading"><div><h2>${esc(paymentContext.client?.Nombre || "Cliente sin identificar")}</h2><p>${esc([paymentContext.bike?.Marca, paymentContext.bike?.Modelo, paymentContext.bike?.Patente].filter(Boolean).join(" · ") || "Moto sin identificar")}</p></div><span class="badge">Orden ${esc(paymentOrderId)}</span></div><div class="payment-summary-values"><div><span>Total del trabajo</span><b>${money(paymentContext.totals.total)}</b></div><div><span>Cobrado anteriormente</span><b>${money(paymentContext.totals.paid)}</b></div><div class="payment-due"><span>Saldo pendiente</span><b>${money(paymentContext.totals.due)}</b></div></div></section>`
    : "";
  const orderEditTitle = { Clientes: "Editar cliente", Motos: "Editar moto", Ordenes_Trabajo: "Editar trabajo" }[table];
  $("#content").innerHTML =
    `<div class="toolbar"><div><h2>${isOrderEdit ? orderEditTitle : paymentContext ? "Registrar nuevo cobro" : `${id ? "Editar" : "Nuevo"} · ${def.title}`}</h2><p class="muted">${isOrderEdit ? "Los cambios se aplicarán a este registro y volverás a la misma orden." : paymentContext ? "El cobro quedará vinculado a esta orden." : clientNew ? "Registrá el cliente y seguí directamente con su moto." : bikeNew ? "La moto queda asociada al cliente y podés abrir el trabajo inmediatamente." : ""}</p></div><button class="ghost" id="back">← Volver</button></div>${paymentSummary}<form id="editForm" class="panel order-context-form"><div class="fields">${fields}</div><div class="form-save-actions"><button type="submit" data-next="default">${paymentContext ? "Guardar cobro" : `Guardar${id ? " cambios" : ""}`}</button>${extraButton}</div></form>`;
  $("#back").onclick = () => {
    if (isOrderEdit) return goBack({ kind: "order", id: orderId });
    goBack({ kind: "view", view: table });
  };
  $("#editForm").onsubmit = async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    if (formEl.dataset.saving === "true") return;
    const next = event.submitter?.dataset.next || "default";
    const record = Object.fromEntries(new FormData(formEl));
    if (id) record[pk] = id;
    if (table === "Pagos") {
      const amount = Number(record.Importe);
      if (!Number.isFinite(amount) || amount <= 0)
        return toast("El importe debe ser mayor que cero.");
      record.Importe = amount;
    }
    if (table === "Clientes") {
      if (!id) record.Telefono = record.WhatsApp?.trim() || "";
      else if (record.WhatsApp?.trim() && !existing.Telefono)
        record.Telefono = record.WhatsApp.trim();
    }
    if (table === "Motos" && !id) {
      const duplicate = activeClientBikes(record.IDCliente).find(
        (bike) =>
          normalizeSearch(bike.Patente) === normalizeSearch(record.Patente),
      );
      if (duplicate)
        return toast(
          "Esta patente ya está registrada para este cliente. Abrí la moto existente.",
        );
      record.Activo = true;
    }
    if (
      table === "Ordenes_Trabajo" &&
      record.Estado === "Entregada" &&
      !record.FechaEntrega
    )
      record.FechaEntrega = localToday();
    formEl.dataset.saving = "true";
    formEl.querySelectorAll('button[type="submit"]').forEach((button) => {
      button.disabled = true;
      button.dataset.originalText = button.textContent;
      button.textContent = "Guardando...";
    });
    try {
      const saved = await api("save", { table, record });
      if (!saved?.[pk])
        throw Error("El servidor no confirmó el registro guardado.");
      updateDbRecord(table, saved, pk);
      toast(paymentContext ? "Cobro registrado correctamente." : "Guardado correctamente.");
      if (clientNew && next === "moto") {
        await synchronizeAfterSave();
        state.view = "Motos";
        form("Motos", "", { IDCliente: saved.IDCliente });
      } else if (bikeNew && next === "work") {
        await synchronizeAfterSave();
        openQuickIntake({ clientId: saved.IDCliente, motoId: saved.IDMoto });
      } else {
        if (isOrderEdit) {
          state.view = "Ordenes_Trabajo";
          const previousScreen = state.navStack[state.navStack.length - 1];
          if (previousScreen?.kind === "order" && previousScreen.id === orderId)
            state.navStack.pop();
          state.currentScreen = { kind: "order", id: orderId };
          await synchronizeAfterSave();
          orderDetail(orderId, false);
          return;
        }
        if (paymentContext) {
          state.paymentOrderContextId = "";
          state.currentScreen = { kind: "order", id: paymentOrderId };
          orderDetail(paymentOrderId, false);
          return;
        }
        state.view = table === "Ordenes_Trabajo" ? "Ordenes_Trabajo" : table;
        await synchronizeAfterSave();
        if (table === "Clientes") customerDetail(saved.IDCliente);
        else if (table === "Motos") motoDetail(saved.IDMoto);
        else if (table === "Ordenes_Trabajo") orderDetail(saved.IDOrden);
        else if (table === "Detalle_Trabajo") {
          state.currentScreen = { kind: "order", id: saved.IDOrden };
          orderDetail(saved.IDOrden, false);
        }
      }
    } catch (error) {
      if (error instanceof SessionExpiredError) showLogin(error.message);
      else toast(`No se pudo guardar: ${error.message}`);
    } finally {
      formEl.dataset.saving = "false";
      formEl.querySelectorAll('button[type="submit"]').forEach((button) => {
        button.disabled = false;
        button.textContent = button.dataset.originalText || "Guardar";
      });
    }
  };
}

function ensurePhotoGalleryStyles() {
  if (document.getElementById("motomania-photo-gallery-styles")) return;
  const style = document.createElement("style");
  style.id = "motomania-photo-gallery-styles";
  style.textContent =
    ".photo-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:14px 0}.photo-card{overflow:hidden;background:#14151a;border:1px solid #3b3d46;border-radius:11px;min-height:176px}.photo-thumb{display:block;width:100%;aspect-ratio:4/3;border:0;border-bottom:1px solid #3b3d46;background:#24262e;cursor:pointer;padding:0}.photo-thumb img{display:block;width:100%;height:100%;object-fit:cover}.photo-thumb:hover{filter:brightness(1.12);transform:none}.photo-caption{padding:9px 10px;color:#c7c8cd;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.photo-caption b{display:block;color:#fff;margin-bottom:3px}.photo-loading,.photo-error{display:grid;place-items:center;min-height:132px;padding:12px;text-align:center;color:#aeb0ba;font-size:12px}.photo-error{color:#ffafb3}.photo-empty{padding:22px;text-align:center;color:#aeb0ba;border:1px dashed #464852;border-radius:10px}.photo-modal{position:fixed;z-index:50;inset:0;padding:20px;background:#000d;display:grid;place-items:center}.photo-modal-box{position:relative;max-width:min(920px,100%);max-height:100%;padding:40px 0 0}.photo-modal img{display:block;max-width:100%;max-height:calc(100vh - 90px);border-radius:10px}.photo-modal-close{position:absolute;right:0;top:0;min-height:32px;padding:5px 10px}@media(max-width:540px){.photo-gallery{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.photo-modal{padding:12px}}";
  document.head.append(style);
}
function openPhotoModal(src, title) {
  const modal = document.createElement("div"),
    box = document.createElement("div"),
    close = document.createElement("button"),
    image = document.createElement("img");
  modal.className = "photo-modal";
  box.className = "photo-modal-box";
  close.className = "photo-modal-close";
  close.type = "button";
  close.textContent = "Cerrar";
  image.src = src;
  image.alt = title;
  box.append(close, image);
  modal.append(box);
  const dismiss = () => {
    document.removeEventListener("keydown", onKey);
    modal.remove();
  };
  const onKey = (event) => {
    if (event.key === "Escape") dismiss();
  };
  close.onclick = dismiss;
  modal.onclick = (event) => {
    if (event.target === modal) dismiss();
  };
  document.addEventListener("keydown", onKey);
  document.body.append(modal);
  close.focus();
}
function isCurrentGallery(request, orderId) {
  return (
    state.galleryRequest === request &&
    state.activeOrderId === orderId &&
    document.getElementById("photoGallery")
  );
}

function rememberPhotoSource(fileId, source) {
  state.photoSources.delete(fileId);
  state.photoSources.set(fileId, source);
  while (state.photoSources.size > PHOTO_SOURCE_CACHE_LIMIT) {
    state.photoSources.delete(state.photoSources.keys().next().value);
  }
}

async function getPhotoSource(fileId, signal) {
  const cached = state.photoSources.get(fileId);
  if (cached) return cached;

  const pending = state.photoRequests.get(fileId);
  if (pending?.signal === signal) return pending.promise;

  const request = (async () => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await api(
          "getPhoto",
          { DriveFileId: fileId },
          {
            signal,
            background: true,
          },
        );
      } catch (error) {
        if (
          error?.name === "AbortError" ||
          error instanceof SessionExpiredError
        )
          throw error;
        lastError = error;
        if (!error?.retriable || attempt === 1) break;
        if (attempt === 0) {
          console.warn("[MOTOMANÍA] Reintentando carga de fotografía", fileId);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
    }
    throw lastError;
  })();
  state.photoRequests.set(fileId, { promise: request, signal });
  try {
    return await request;
  } finally {
    if (state.photoRequests.get(fileId)?.promise === request)
      state.photoRequests.delete(fileId);
  }
}

async function loadPhotoThumbnail(photo, index, request, orderId, signal) {
  const gallery = document.getElementById("photoGallery");

  if (!gallery) return;

  const card = gallery.querySelector(`[data-photo-index="${index}"]`);

  if (!card) return;

  try {
    const data = await getPhotoSource(photo.DriveFileId, signal);

    const mimeType = String(data?.mimeType || "").toLowerCase();
    const base64 = String(data?.base64 || "").replace(/\s/g, "");

    if (
      !["image/jpeg", "image/png", "image/webp"].includes(mimeType) ||
      !base64
    ) {
      throw new Error("El servidor no devolvió una imagen válida.");
    }

    if (!isCurrentGallery(request, orderId)) return;

    rememberPhotoSource(photo.DriveFileId, {
      mimeType,
      base64,
    });

    const src = `data:${mimeType};base64,${base64}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "photo-thumb";
    button.setAttribute("aria-label", "Ampliar fotografía");

    const img = document.createElement("img");
    img.src = src;
    img.alt = photo.NombreArchivo || "Fotografía del trabajo";
    img.loading = "lazy";

    button.appendChild(img);

    button.onclick = () => {
      openPhotoModal(src, img.alt);
    };

    const caption = document.createElement("div");
    caption.className = "photo-caption";

    const tipo = document.createElement("b");
    tipo.textContent = photo.Tipo || "Fotografía";

    const nombre = document.createElement("span");
    nombre.textContent = photo.NombreArchivo || "Sin nombre";

    caption.append(tipo, nombre);

    card.replaceChildren(button, caption);
  } catch (error) {
    if (error?.name === "AbortError" || !isCurrentGallery(request, orderId))
      return;
    console.error(
      "[MOTOMANÍA] Error cargando fotografía:",
      photo.DriveFileId,
      error,
    );

    if (error instanceof SessionExpiredError) {
      showLogin(error.message);
      return;
    }

    card.classList.add("photo-error");
    card.textContent = "No se pudo cargar la fotografía: " + error.message;
  }
}

function loadPhotoGallery(photos, request, orderId, signal) {
  let nextIndex = 0;
  const worker = async () => {
    while (!signal.aborted && isCurrentGallery(request, orderId)) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= photos.length) return;
      await loadPhotoThumbnail(photos[index], index, request, orderId, signal);
    }
  };
  return Promise.all(
    Array.from(
      { length: Math.min(PHOTO_GALLERY_CONCURRENCY, photos.length) },
      worker,
    ),
  );
}

function photoQueueFor(orderId) {
  if (!state.photoQueues.has(orderId)) state.photoQueues.set(orderId, []);
  return state.photoQueues.get(orderId);
}
function addQueuedPhotos(orderId, files, type) {
  const queue = photoQueueFor(orderId);
  [...files].forEach((file) => {
    if (!isSupportedPhotoFile(file)) return toast("Solo se admiten fotografías JPG, PNG o WEBP.");
    const duplicate = queue.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
    if (!duplicate) queue.push({ id: uploadKey("queued"), file, type, url: URL.createObjectURL(file), status: "pending", error: "" });
  });
  renderPhotoQueue(orderId);
}
function renderPhotoQueue(orderId) {
  const root = $("#photoQueue"), queue = photoQueueFor(orderId);
  const upload = $("#uploadAllPhotos"), retry = $("#retryFailedPhotos");
  if (!root || state.activeOrderId !== orderId) return;
  root.replaceChildren(...queue.map((item) => {
    const card = document.createElement("article"); card.className = `queued-photo is-${item.status}`;
    const image = document.createElement("img"); image.src = item.url; image.alt = item.file.name;
    const text = document.createElement("span"); text.textContent = item.status === "failed" ? `Falló: ${item.error}` : item.status === "uploading" ? "Subiendo…" : item.status === "saved" ? "Guardada" : "Pendiente";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ghost"; remove.textContent = "Quitar"; remove.disabled = item.status === "uploading" || item.status === "saved";
    remove.onclick = () => { const index = queue.indexOf(item); if (index >= 0) { URL.revokeObjectURL(item.url); queue.splice(index, 1); renderPhotoQueue(orderId); } };
    image.onclick = () => openPhotoModal(item.url, item.file.name); card.append(image, text, remove); return card;
  }));
  const ready = queue.filter((item) => item.status === "pending" || item.status === "failed").length;
  const failed = queue.filter((item) => item.status === "failed").length;
  upload.textContent = `☁️ Subir todas (${ready})`; upload.disabled = !ready;
  retry.hidden = !failed;
}
async function uploadQueuedPhotos(orderId, failedOnly = false) {
  const queue = photoQueueFor(orderId);
  const selected = queue.filter((item) => (failedOnly ? item.status === "failed" : item.status === "pending" || item.status === "failed"));
  if (!selected.length) return;
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const item = selected[next++]; item.status = "uploading"; item.error = ""; renderPhotoQueue(orderId);
      try {
        const saved = confirmUploadedPhoto(await api("uploadPhoto", { IDOrden: orderId, Tipo: item.type, base64: await shrink(item.file), uploadKey: item.id }), orderId);
        updateDbRecord("Fotos", saved, "IDFoto"); item.status = "saved";
      } catch (error) { item.status = "failed"; item.error = error.message || "No se pudo subir"; if (error instanceof SessionExpiredError) showLogin(error.message); }
      renderPhotoQueue(orderId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PHOTO_UPLOAD_CONCURRENCY, selected.length) }, worker));
  if (state.activeOrderId === orderId) { toast("Subida de fotografías finalizada."); orderDetail(orderId, false); }
}

function orderDetail(id, remember = true) {
  const o = state.db.Ordenes_Trabajo.find((x) => x.IDOrden === id);
  if (!o) return;
  const retainedQueue = state.photoQueues.get(id);
  if (retainedQueue) state.photoQueues.set(id, retainedQueue.filter((item) => {
    if (item.status !== "saved") return true;
    URL.revokeObjectURL(item.url);
    return false;
  }));
  if (remember) rememberScreen({ kind: "order", id });
  const d = state.db.Detalle_Trabajo.filter((x) => x.IDOrden === id),
    p = state.db.Pagos.filter((x) => x.IDOrden === id),
    photos = state.db.Fotos.filter((x) => x.IDOrden === id),
    t = totals(id);
  state.galleryAbortController?.abort();
  const galleryAbortController = new AbortController();
  state.galleryAbortController = galleryAbortController;
  state.activeOrderId = id;
  const galleryRequest = ++state.galleryRequest;
  ensurePhotoGalleryStyles();

  const gallery = photos.length
    ? `
    <div id="photoGallery" class="photo-gallery" aria-live="polite">
      ${photos
        .map(
          (foto, index) => `
        <article
          class="photo-card"
          data-photo-index="${index}"
        >
          <div class="photo-loading">
            Cargando fotografía…
          </div>
        </article>
      `,
        )
        .join("")}
    </div>
  `
    : `
    <div id="photoGallery" class="photo-empty">
      Esta orden todavía no tiene fotografías.
    </div>
  `;

  const context = orderContext(id);
  const bike = context.bike;
  const client = context.client;
  $("#content").innerHTML = `
    <button class="ghost" id="back">← Volver</button>

    <section class="panel order-identity-panel">
      <div class="order-identity-heading">
        <div><p class="eyebrow">Cliente y motocicleta</p><h2>${esc(client?.Nombre || "Cliente no encontrado")}</h2><p>${esc([bike?.Marca, bike?.Modelo].filter(Boolean).join(" ") || "Moto no encontrada")}${bike?.Patente ? ` · ${esc(bike.Patente)}` : ""}</p></div>
        <div class="order-context-actions">${client ? `<button class="ghost" type="button" data-order-edit="Clientes:${esc(client.IDCliente)}">✏️ Editar cliente</button>` : ""}${bike ? `<button class="ghost" type="button" data-order-edit="Motos:${esc(bike.IDMoto)}">✏️ Editar moto</button>` : ""}</div>
      </div>
    </section>

    <div class="panel order-work-panel">
      <div class="order-work-heading"><div><p class="eyebrow">Información del trabajo</p><b>${esc(o.Estado)}</b></div><div class="order-context-actions"><button type="button" data-order-edit="Ordenes_Trabajo:${esc(id)}">✏️ Editar trabajo</button>${!["Entregada", "Cancelada"].includes(o.Estado) ? `<button data-deliver="${esc(id)}">💰 Registrar pago y entregar</button>` : ""}</div></div>
      <p>Problema: ${esc(o.Problema)}</p>
      <p>Diagnóstico: ${esc(o.Diagnostico)}</p>
      <p>Kilometraje: ${esc(o.Kilometraje)}</p>
    </div>

    <h2>Servicios y repuestos</h2>

    <p class="muted">
      Agregá los conceptos acá mismo, sin salir de la orden.
    </p>

    <div class="list order-concepts">
      ${d
        .map(
          (x) => `
        <div class="item concept-row">
          <div><strong>${esc(x.Tipo)} · ${esc(x.Descripcion)}</strong><small>${esc(x.Cantidad)} × ${money(Number(x.PrecioUnitario))} = ${money(Number(x.Subtotal))}</small></div>
          <div class="concept-actions"><button class="ghost" type="button" data-edit-concept="${esc(x.IDDetalle)}">✏️ Editar</button><button class="danger-button" type="button" data-delete-concept="${esc(x.IDDetalle)}">🗑️ Borrar</button></div>
        </div>
      `,
        )
        .join("")}
    </div>

    <form id="inlineConceptForm" class="panel inline-concept-form">
      <h3>+ Agregar servicio o repuesto</h3>

      <div class="quick-concept-editor">
        <label>
          Tipo
          <select name="Tipo">
            <option>Servicio</option>
            <option>Repuesto</option>
          </select>
        </label>

        <label>
          Descripción
          <input name="Descripcion" required placeholder="Ej.: cambio de aceite">
        </label>

        <label>
          Cantidad
          <input name="Cantidad" type="number" min="0.01" step="any" value="1" required>
        </label>

        <label>
          Precio unitario ($)
          <input name="PrecioUnitario" type="number" min="0" step="any" required>
        </label>

        <button id="inlineConceptSubmit" type="submit">
          Guardar concepto
        </button>
      </div>
    </form>

    <h2>Pagos</h2>

    <div class="panel">
      <p>
        Total: ${money(t.total)} · Cobrado: ${money(t.paid)}
      </p>

      <h2 class="${t.due > 0 ? "danger" : "success"}">
        Saldo: ${money(t.due)}
      </h2>

      ${p
        .map(
          (x) => `
        <p>${esc(x.Medio)} · ${money(Number(x.Importe))}</p>
      `,
        )
        .join("")}

      <button data-pay="${id}">+ Registrar cobro</button>

      ${
        !["Entregada", "Cancelada"].includes(o.Estado)
          ? `
            <div
              class="delivery-section"
              style="margin-top:20px;padding-top:15px;border-top:1px solid #777"
            >
              <h3>Entrega de la moto</h3>

              <label for="deliveryDate">
                Fecha de entrega
              </label>

              <input
                type="date"
                id="deliveryDate"
                value="${localToday()}"
                style="display:block;margin-top:8px;margin-bottom:12px"
              >

              <p class="muted">
                Podés registrar la entrega aunque quede un saldo pendiente.
              </p>

              <button
                type="button"
                id="confirmDelivery"
                data-confirm-delivery="${esc(id)}"
              >
                ✓ Confirmar entrega
              </button>



              
            </div>
          `
          : ""
      }
    </div>

    <h2>Fotografías</h2>

    <div class="panel">
      ${gallery}

      <form id="photoForm">
        <div class="fields">
          <label>
            Tipo
            <select name="Tipo">
              <option>Ingreso</option>
              <option>Diagnóstico</option>
              <option>Reparación</option>
              <option>Entrega</option>
              <option>General</option>
            </select>
          </label>

          <label>
            Foto
            <input
              type="file"
              name="foto"
              accept="image/*"
              capture="environment"
            >
          </label>
        </div>

        <div id="photoQueue" class="photo-queue" aria-live="polite"></div>
        <div class="photo-queue-actions"><button id="uploadAllPhotos" type="button">☁️ Subir todas (0)</button><button id="retryFailedPhotos" class="ghost" type="button" hidden>Reintentar fallidas</button></div>
      </form>

      <small>
        Las fotos se almacenan de forma privada en Google Drive.
      </small>
    </div>

    <button id="print" class="ghost">
      Imprimir comprobante / Guardar PDF
    </button>
  `;

  const photoForm = $("#photoForm");
  const photoCamera = photoForm.querySelector('input[name="foto"]');
  const photoFields = photoForm.querySelector(".fields");
  const cameraLabel = photoCamera.closest("label");
  photoCamera.name = "photoCamera";
  photoCamera.id = "orderPhotoCamera";
  photoCamera.accept = "image/jpeg,image/png,image/webp";
  photoCamera.required = false;
  photoCamera.hidden = true;
  cameraLabel.className = "photo-source-button photo-source-camera";
  cameraLabel.innerHTML =
    '<span class="photo-source-icon" aria-hidden="true">📷</span><span><strong>Sacar foto</strong><small>Abre la cámara del dispositivo</small></span>';
  cameraLabel.append(photoCamera);
  const photoFile = document.createElement("input");
  photoFile.type = "file";
  photoFile.name = "photoFile";
  photoFile.id = "orderPhotoFile";
  photoFile.accept = "image/jpeg,image/png,image/webp";
  photoFile.hidden = true;
  const fileLabel = document.createElement("label");
  fileLabel.className = "photo-source-button photo-source-file";
  fileLabel.innerHTML =
    '<span class="photo-source-icon" aria-hidden="true">🖼️</span><span><strong>Subir archivo</strong><small>Elegí una imagen existente</small></span>';
  fileLabel.append(photoFile);
  photoFields.classList.add("photo-upload-fields");
  photoFields.append(fileLabel);
  const photoPreview = document.createElement("div");
  photoPreview.id = "orderPhotoPreview";
  photoPreview.className = "photo-upload-preview muted";
  photoPreview.textContent = "Todavía no seleccionaste una foto.";
  const photoUploadStatus = document.createElement("p");
  photoUploadStatus.id = "orderPhotoUploadStatus";
  photoUploadStatus.className = "photo-upload-status muted";
  photoFields.after(photoPreview, photoUploadStatus);
  const previewSelectedPhoto = (file, otherInput) => {
    if (!file) return;
    otherInput.value = "";
    const image = document.createElement("img");
    const url = URL.createObjectURL(file);
    image.src = url;
    image.alt = "Previsualización de la fotografía seleccionada";
    image.onload = () => URL.revokeObjectURL(url);
    const description = document.createElement("span");
    description.textContent = file.name;
    photoPreview.classList.remove("muted");
    photoPreview.replaceChildren(image, description);
  };
  photoCamera.addEventListener("change", () =>
    previewSelectedPhoto(photoCamera.files[0], photoFile),
  );
  photoFile.addEventListener("change", () =>
    previewSelectedPhoto(photoFile.files[0], photoCamera),
  );
  $("#back").onclick = () => goBack({ kind: "view", view: "Ordenes_Trabajo" });
  $("#print").onclick = () => printOrder(id);
  $("#inlineConceptForm").onsubmit = async (event) => {
    event.preventDefault();
    const frm = event.currentTarget;
    if (frm.dataset.saving === "true") return;
    frm.dataset.saving = "true";
    const button = $("#inlineConceptSubmit");
    button.disabled = true;
    button.textContent = "Guardando...";
    const record = { ...Object.fromEntries(new FormData(frm)), IDOrden: id };
    try {
      const saved = await api("save", { table: "Detalle_Trabajo", record });
      updateDbRecord("Detalle_Trabajo", saved, "IDDetalle");
      const scroll = window.scrollY;
      await synchronizeAfterSave();
      orderDetail(id);
      window.scrollTo(0, scroll);
      toast("Concepto agregado al trabajo.");
    } catch (error) {
      if (error instanceof SessionExpiredError) showLogin(error.message);
      else toast(`No se pudo guardar el concepto: ${error.message}`);
    } finally {
      frm.dataset.saving = "false";
      button.disabled = false;
      button.textContent = "Guardar concepto";
    }
  };
  photoForm.onsubmit = async (e) => {
    e.preventDefault();
    const file = photoCamera.files[0] || photoFile.files[0];
    if (!file) {
      photoUploadStatus.classList.add("is-error");
      photoUploadStatus.textContent = "Seleccioná una foto antes de subirla.";
      return;
    }
    if (!isSupportedPhotoFile(file)) {
      photoUploadStatus.classList.add("is-error");
      photoUploadStatus.textContent =
        "Solo se admiten fotografías JPG, PNG o WEBP.";
      return toast("Solo se admiten fotografías JPG, PNG o WEBP.");
    }
    const submit = e.target.querySelector(
      "button[type=submit], button:not([type])",
    );
    if (submit?.disabled) return;
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Subiendo fotografía…";
    }
    photoForm.querySelectorAll('input[type="file"]').forEach((input) => {
      input.disabled = true;
    });
    photoUploadStatus.classList.remove("is-error");
    photoUploadStatus.textContent = "Procesando y subiendo fotografía…";
    try {
      const base64 = await shrink(file);
      const saved = confirmUploadedPhoto(
        await api("uploadPhoto", {
          IDOrden: id,
          Tipo: e.target.Tipo.value,
          base64,
          uploadKey:
            e.target.dataset.uploadKey ||
            (e.target.dataset.uploadKey = uploadKey(`order_${id}`)),
        }),
        id,
      );
      const existing = (state.db.Fotos || []).findIndex(
        (photo) => photo.IDFoto === saved.IDFoto,
      );
      if (existing < 0) state.db.Fotos.push(saved);
      else state.db.Fotos[existing] = saved;
      photoUploadStatus.classList.remove("is-error");
      photoUploadStatus.textContent = "Fotografía guardada correctamente.";
      toast("Fotografía guardada correctamente.");
      orderDetail(id);
    } catch (error) {
      if (error instanceof SessionExpiredError) showLogin(error.message);
      else {
        photoUploadStatus.classList.add("is-error");
        photoUploadStatus.textContent = `No se pudo guardar la fotografía. ${error.message}`;
        toast(`No se pudo guardar la fotografía. ${error.message}`);
      }
    } finally {
      if (photoForm.isConnected) {
        photoForm.querySelectorAll('input[type="file"]').forEach((input) => {
          input.disabled = false;
        });
        if (submit) {
          submit.disabled = false;
          submit.textContent = "Subir foto";
        }
      }
    }
  };
  // La cola permanece en memoria por orden aunque el usuario cambie de pantalla.
  photoFile.multiple = true;
  photoCamera.addEventListener("change", () => {
    addQueuedPhotos(id, photoCamera.files, photoForm.Tipo.value);
    photoCamera.value = "";
  });
  photoFile.addEventListener("change", () => {
    addQueuedPhotos(id, photoFile.files, photoForm.Tipo.value);
    photoFile.value = "";
  });
  photoForm.onsubmit = (event) => event.preventDefault();
  $("#uploadAllPhotos").onclick = () => void uploadQueuedPhotos(id);
  $("#retryFailedPhotos").onclick = () => void uploadQueuedPhotos(id, true);
  renderPhotoQueue(id);
  document.querySelectorAll("[data-edit-concept]").forEach((button) => {
    button.onclick = () => form("Detalle_Trabajo", button.dataset.editConcept);
  });
  document.querySelectorAll("[data-delete-concept]").forEach((button) => {
    button.onclick = async () => {
      const item = d.find((row) => row.IDDetalle === button.dataset.deleteConcept);
      if (!item) return;
      const accepted = await confirmModal({ title: "¿Eliminar este concepto?", message: `${item.Descripcion} · ${money(Number(item.Subtotal))}`, cancelText: "Cancelar", confirmText: "Eliminar concepto", danger: true });
      if (!accepted) return;
      button.disabled = true;
      try {
        const result = await api("deleteDetail", { table: "Detalle_Trabajo", IDDetalle: item.IDDetalle });
        if (!result?.deleted || result.IDDetalle !== item.IDDetalle) throw Error("El servidor no confirmó la eliminación.");
        state.db.Detalle_Trabajo = state.db.Detalle_Trabajo.filter((row) => row.IDDetalle !== item.IDDetalle);
        orderDetail(id, false); toast("Concepto eliminado correctamente.");
      } catch (error) { button.disabled = false; toast(`No se pudo eliminar el concepto: ${error.message}`); }
    };
  });
  void loadPhotoGallery(
    photos,
    galleryRequest,
    id,
    galleryAbortController.signal,
  );
  addOrderEnhancements(id);
  wire();
}
function addOrderEnhancements(id) {
  const {
    order,
    bike,
    client,
    items,
    payments,
    totals: summary,
  } = orderContext(id);
  if (!order) return;
  const panel = document.createElement("section");
  panel.className = "panel order-workflow no-print";
  panel.innerHTML = `<div class="itemhead"><div><h2>Seguimiento de la orden</h2><p class="muted">Actualizá la etapa manualmente; esto no genera cobros ni movimientos de Caja.</p></div><span class="badge" data-state="${esc(order.Estado)}">${esc(orderStageLabel(order.Estado))}</span></div><div class="order-workflow-actions"><label>Estado<select id="orderStageSelect">${ORDER_STAGES.map(([value, label]) => `<option value="${esc(value)}" ${value === order.Estado ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label><button id="orderStageSave">Actualizar estado</button><button class="ghost" data-order-budget="${esc(id)}">Enviar presupuesto por WhatsApp</button></div>`;
  const firstPanel = $("#content .panel");
  firstPanel?.after(panel);
  $("#orderStageSave").onclick = () =>
    changeOrderStage(id, $("#orderStageSelect").value);

  const services = items.filter((item) => item.Tipo === "Servicio");
  const parts = items.filter((item) => item.Tipo === "Repuesto");
  const lineList = (rows) =>
    rows.length
      ? `<ul>${rows.map((item) => `<li>${esc(item.Descripcion || "Concepto")} · ${esc(item.Cantidad || 0)} × ${money(Number(item.PrecioUnitario) || 0)} = ${money(Number(item.Subtotal) || 0)}</li>`).join("")}</ul>`
      : "<p>Sin registros.</p>";
  const printable = document.createElement("article");
  printable.className = "print-document";
  printable.innerHTML = `<header><h1>MOTOMANÍA</h1><p>Comprobante de orden de trabajo</p></header><div class="print-grid"><p><b>Fecha:</b> ${esc(argentinaDate(new Date().toISOString()))}</p><p><b>Orden:</b> ${esc(order.IDOrden)}</p><p><b>Estado:</b> ${esc(orderStageLabel(order.Estado))}</p><p><b>Cliente:</b> ${esc(client?.Nombre || "Sin cliente")}</p><p><b>Moto:</b> ${esc([bike?.Marca, bike?.Modelo].filter(Boolean).join(" ") || "Sin moto")}</p><p><b>Patente:</b> ${esc(bike?.Patente || "Sin patente")}</p><p><b>Kilometraje:</b> ${esc(order.Kilometraje || "No informado")}</p></div><p><b>Problema informado:</b> ${esc(order.Problema || "No informado")}</p>${order.Observaciones ? `<p><b>Observaciones:</b> ${esc(order.Observaciones)}</p>` : ""}<h2>Servicios realizados</h2>${lineList(services)}<h2>Repuestos utilizados</h2>${lineList(parts)}<h2>Pagos registrados</h2>${payments.length ? `<ul>${payments.map((payment) => `<li>${esc(argentinaDate(payment.Fecha))} · ${esc(payment.Medio || "Sin medio")} · ${money(Number(payment.Importe) || 0)}</li>`).join("")}</ul>` : "<p>Sin pagos registrados.</p>"}<div class="print-totals"><p>Presupuesto total: <b>${money(summary.total)}</b></p><p>Total cobrado: <b>${money(summary.paid)}</b></p><p>Saldo pendiente: <b>${money(summary.due)}</b></p></div></article>`;
  $("#content").append(printable);
}
function motoDetail(id, remember = true) {
  const bike = (state.db.Motos || []).find((row) => row.IDMoto === id);
  if (!bike) return;
  if (remember) rememberScreen({ kind: "moto", id });
  state.activeOrderId = "";
  state.galleryRequest += 1;
  const owner = (state.db.Clientes || []).find(
    (row) => row.IDCliente === bike.IDCliente,
  );
  const orders = (state.db.Ordenes_Trabajo || [])
    .filter((row) => row.IDMoto === id)
    .sort((a, b) =>
      String(b.FechaIngreso || "").localeCompare(String(a.FechaIngreso || "")),
    );
  const title = [bike.Patente, bike.Marca, bike.Modelo]
    .filter(Boolean)
    .join(" · ");
  const history =
    orders
      .map((order) => {
        const items = (state.db.Detalle_Trabajo || []).filter(
          (row) => row.IDOrden === order.IDOrden,
        );
        const serviceText =
          items
            .map((item) => `${item.Tipo}: ${item.Descripcion}`)
            .join(" · ") || "Sin trabajos cargados";
        const photoCount = (state.db.Fotos || []).filter(
          (row) => row.IDOrden === order.IDOrden,
        ).length;
        const summary = totals(order.IDOrden);
        return `<article class="item history-card"><div class="itemhead"><div><strong>${esc(argentinaDate(order.FechaIngreso))} · ${esc(order.IDOrden)}</strong><small>${esc(order.Problema || "Sin motivo informado")}</small></div><span class="badge" data-state="${esc(order.Estado)}">${esc(orderStageLabel(order.Estado))}</span></div><p class="history-work">${esc(serviceText)}</p><div class="order-meta"><span>Kilometraje: ${esc(order.Kilometraje || "No informado")}</span><span>Importe: ${money(summary.total)}</span><span>${photoCount} fotografía${photoCount === 1 ? "" : "s"}</span></div><button data-open="${esc(order.IDOrden)}">Abrir orden</button></article>`;
      })
      .join("") ||
    '<div class="empty">Esta moto todavía no tiene órdenes registradas.</div>';
  $("#content").innerHTML =
    `<div class="toolbar"><div><h2>${esc(title || "Moto")}</h2><p class="muted">Cliente: ${esc(owner?.Nombre || "Sin cliente")}</p></div><div>${owner ? `<button class="ghost" data-open-client="${esc(owner.IDCliente)}">Ver ficha del cliente</button>` : ""}<button class="ghost" id="back">Volver a motos</button><button data-edit="Motos:${esc(id)}">Editar moto</button>${motoIsActive(bike) ? `<button data-quick-moto="${esc(id)}">+ NUEVO TRABAJO</button>` : ""}<button class="ghost" data-moto-active="${esc(id)}" data-active="${motoIsActive(bike) ? "false" : "true"}">${motoIsActive(bike) ? "Dar de baja" : "Reactivar"}</button></div></div>${!motoIsActive(bike) ? '<p class="muted"><b>● Moto dada de baja</b></p>' : ""}<section class="panel"><h2>Historial de servicios</h2><p class="muted">Órdenes vinculadas a esta moto, desde el ingreso más reciente.</p><div class="list">${history}</div></section>`;
  $("#back").onclick = () => goBack({ kind: "view", view: "Motos" });
  wire();
}
function isSupportedPhotoFile(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return (
    ["image/jpeg", "image/png", "image/webp"].includes(type) ||
    /\.(jpe?g|png|webp)$/.test(name)
  );
}
async function sourceImage(file) {
  if (typeof createImageBitmap === "function") {
    const image = await createImageBitmap(file);
    return { image, close: () => image.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(new Error("No se pudo procesar la imagen seleccionada."));
      element.src = url;
    });
    return { image, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
async function shrink(file) {
  const source = await sourceImage(file);
  const img = source.image;
  const canvas = document.createElement("canvas");
  try {
    const ratio = Math.min(1, 1500 / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * ratio);
    canvas.height = Math.round(img.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No se pudo preparar la imagen para subir.");
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
  } finally {
    source.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
function resumeIntake() {
  if (state.intake) {
    state.view = "intake";
    renderIntake(false);
    return;
  }
  startIntake(loadIntakeDraft());
}
async function deliverOrder(id, fechaEntrega) {
  const order = (state.db.Ordenes_Trabajo || []).find(
    (row) => row.IDOrden === id,
  );

  if (!order || ["Entregada", "Cancelada"].includes(order.Estado)) {
    return;
  }

  if (!fechaEntrega || !/^\d{4}-\d{2}-\d{2}$/.test(fechaEntrega)) {
    toast("Seleccioná una fecha de entrega válida.");
    return;
  }

  const ok = await confirmModal({
    title: "¿Confirmar entrega de la moto?",
    message: `Se registrará la entrega el ${argentinaDate(fechaEntrega)}. Si existe un saldo pendiente, continuará registrado.`,
    cancelText: "Cancelar",
    confirmText: "Confirmar entrega",
  });

  if (!ok) return;

  await withSession(async () => {
    const wasDetail = state.activeOrderId === id;

    const saved = await api("save", {
      table: "Ordenes_Trabajo",
      record: {
        IDOrden: id,
        Estado: "Entregada",
        FechaEntrega: fechaEntrega,
      },
    });

    updateDbRecord("Ordenes_Trabajo", saved, "IDOrden");

    if (wasDetail) {
      orderDetail(id);
    } else {
      render();
    }

    toast("Entrega registrada correctamente.");
  });
}

function wire() {
  // WhatsApp desde el listado de trabajos
  document.querySelectorAll("[data-order-whatsapp]").forEach((button) => {
    button.onclick = () => {
      openOrderWhatsApp(button.dataset.orderWhatsapp);
    };
  });

  document.querySelectorAll("[data-quick-new]").forEach((button) => {
    button.onclick = () => openQuickIntake();
  });
  document.querySelectorAll("[data-quick-client]").forEach((button) => {
    button.onclick = () =>
      openQuickIntake({ clientId: button.dataset.quickClient });
  });
  document.querySelectorAll("[data-quick-moto]").forEach((button) => {
    button.onclick = () =>
      openQuickIntake({ motoId: button.dataset.quickMoto });
  });

  document.querySelectorAll("[data-confirm-delivery]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.confirmDelivery;
      const fecha = document.querySelector("#deliveryDate")?.value;

      deliverOrder(id, fecha);
    };
  });

  document.querySelectorAll("[data-deliver]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.deliver;

      const order = (state.db.Ordenes_Trabajo || []).find(
        (row) => row.IDOrden === id,
      );

      if (!order || ["Entregada", "Cancelada"].includes(order.Estado)) {
        return;
      }

      orderDetail(id);

      const pagos = document.querySelector("[data-pay]");
      if (pagos) {
        pagos.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
  });

  document.querySelectorAll("[data-indicator]").forEach((button) => {
    button.onclick = () => {
      const value = button.dataset.indicator;
      state.orderFilter = value === "clients" ? "" : value;
      state.view = value === "clients" ? "Clientes" : "Ordenes_Trabajo";
      render();
    };
  });
  document.querySelectorAll("[data-moto-active]").forEach((button) => {
    button.onclick = () =>
      setMotoActive(
        button.dataset.motoActive,
        button.dataset.active === "true",
      );
  });
  document
    .querySelectorAll("[data-intake]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          button.dataset.intake === "draft" ? resumeIntake() : startIntake()),
    );
  document.querySelectorAll("[data-intake-discard]").forEach(
    (button) =>
      (button.onclick = async () => {
        const accepted = await confirmModal({
          title: "¿Descartar borrador?",
          message:
            "Se eliminarán los datos guardados localmente de este ingreso.",
          cancelText: "Conservar",
          confirmText: "Descartar",
          danger: true,
        });
        if (!accepted) return;
        discardIntake();
        state.view = "dashboard";
        render();
      }),
  );
  document
    .querySelectorAll("[data-add]")
    .forEach((b) => (b.onclick = () => form(b.dataset.add)));
  document.querySelectorAll("[data-edit]").forEach(
    (b) =>
      (b.onclick = () => {
        const [table, id] = b.dataset.edit.split(":");
        form(table, id);
      }),
  );
  document.querySelectorAll("[data-order-edit]").forEach((button) => {
    button.onclick = () => {
      const [table, id] = button.dataset.orderEdit.split(":");
      openOrderEditForm(table, id, state.activeOrderId);
    };
  });
  document
    .querySelectorAll("[data-open]")
    .forEach((b) => (b.onclick = () => orderDetail(b.dataset.open)));
  document
    .querySelectorAll("[data-open-client]")
    .forEach(
      (button) =>
        (button.onclick = () => customerDetail(button.dataset.openClient)),
    );
  document.querySelectorAll("[data-add-client-moto]").forEach(
    (button) =>
      (button.onclick = () => {
        state.view = "Motos";
        form("Motos", "", { IDCliente: button.dataset.addClientMoto });
      }),
  );
  document
    .querySelectorAll("[data-open-moto]")
    .forEach((b) => (b.onclick = () => motoDetail(b.dataset.openMoto)));
  document
    .querySelectorAll("[data-order-stage]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          changeOrderStage(b.dataset.orderStage, b.dataset.nextStage)),
    );
  document
    .querySelectorAll("[data-order-budget]")
    .forEach((b) => (b.onclick = () => budgetWhatsApp(b.dataset.orderBudget)));
  document.querySelectorAll("[data-concept]").forEach(
    (b) =>
      (b.onclick = () =>
        form("Detalle_Trabajo", "", {
          IDOrden: b.dataset.concept,
          Tipo: "Servicio",
          Cantidad: 1,
        })),
  );
  document.querySelectorAll("[data-pay]").forEach(
    (b) =>
      (b.onclick = () => {
        const orderId = b.dataset.pay;
        state.paymentOrderContextId = orderId;
        form("Pagos", "", {
          IDOrden: orderId,
          Fecha: localToday(),
          Medio: "Efectivo",
          Importe: Math.max(0, totals(orderId).due),
        });
      }),
  );
}
