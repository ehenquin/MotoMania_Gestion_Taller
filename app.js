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
  photoSources: new Map(),
  photoRequests: new Map(),
  galleryAbortController: null,
  cashFilter: { period: "month", start: "", end: "" },
};
const PHOTO_GALLERY_CONCURRENCY = 3;
const PHOTO_SOURCE_CACHE_LIMIT = 24;
const defs = {
  Clientes: {
    title: "Clientes",
    fields: [
      "Nombre",
      "Telefono",
      "WhatsApp",
      "DNI",
      "Domicilio",
      "Observaciones",
    ],
    required: ["Nombre", "Telefono"],
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
  state.loading = true;
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
    $("#summary").textContent =
      `${state.db.Clientes.length} clientes · ${state.db.Motos.length} motos · ${state.db.Ordenes_Trabajo.length} órdenes`;
    render();
    const elapsed = performance.now() - started;
    $("#loadMetric").textContent =
      `Sincronizado en ${(elapsed / 1000).toFixed(1)} s`;
    console.info(`[MOTOMANÍA] bootstrap + render: ${elapsed.toFixed(0)} ms`);
  } finally {
    state.loading = false;
  }
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
    state.view = b.dataset.view;
    document.querySelector(".nav-more")?.removeAttribute("open");
    render();
  }
};
window.addEventListener("beforeunload", (event) => {
  if (state.view === "intake" && state.intake) {
    captureIntake();
    persistIntake();
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
      record.FechaEntrega = new Date().toISOString().slice(0, 10);
    await api("save", { table: "Ordenes_Trabajo", record });
    toast("Estado actualizado correctamente.");
    await load();
    orderDetail(id);
  });
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
  state.galleryAbortController?.abort();
  state.galleryAbortController = null;
  state.activeOrderId = "";
  state.galleryRequest += 1;
  document
    .querySelectorAll("#nav button")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.view === state.view),
    );
  if (state.view === "dashboard") return dashboard();
  if (state.view === "intake" && state.intake) return renderIntake();
  if (state.view === "Caja") return cashDashboard();
  list(state.view);
}
function dashboard() {
  const os = state.db.Ordenes_Trabajo || [];
  const open = os.filter((o) => !["Entregada", "Cancelada"].includes(o.Estado));
  $("#content").innerHTML =
    `<div class="stats"><div class="stat"><span class="stat-icon">🏍</span><b>${open.length}</b><small>Motos en taller</small></div><div class="stat"><span class="stat-icon">✓</span><b>${os.filter((o) => o.Estado === "Lista para retirar").length}</b><small>Listas para retirar</small></div><div class="stat"><span class="stat-icon">◷</span><b>${os.filter((o) => o.Estado === "Esperando repuestos").length}</b><small>Esperando repuestos</small></div><div class="stat"><span class="stat-icon">♙</span><b>${state.db.Clientes.length}</b><small>Clientes registrados</small></div></div><div class="toolbar"><div><h2>Trabajos activos</h2><p class="muted">Seguimiento en tiempo real de las reparaciones.</p></div><div class="intake-dashboard-actions"><button data-intake="new">+ NUEVO INGRESO</button>${loadIntakeDraft() ? '<button class="ghost" data-intake="draft">Continuar borrador</button><button class="ghost" data-intake-discard>Descartar borrador</button>' : ""}</div></div><div class="list">${open.map((o) => orderCard(o)).join("") || '<div class="empty">No hay trabajos activos en este momento.</div>'}</div>`;
  wire();
}
function cashDate(value) {
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
  const payments = (state.db.Pagos || []).map((payment) => ({
    key: `payment:${payment.IDPago}`,
    source: "payment",
    Fecha: payment.Fecha,
    Tipo: "Ingreso",
    Categoria: "Cobro de orden",
    Descripcion: `Cobro de orden ${payment.IDOrden || ""}`.trim(),
    Importe: Number(payment.Importe || 0),
    Medio: payment.Medio || "Sin medio",
    Responsable: "",
  }));
  const manual = (state.db.Movimientos_Caja || []).map((movement) => ({
    key: `movement:${movement.IDMovimiento}`,
    source: "manual",
    ...movement,
    Importe: Number(movement.Importe || 0),
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
function cashDashboard() {
  const records = cashRecords(),
    summary = cashSummary(records),
    filter = state.cashFilter;
  const mediums = Object.entries(summary.byMedium).sort(([a], [b]) =>
    a.localeCompare(b, "es"),
  );
  $("#content").innerHTML =
    `<div class="toolbar cash-toolbar"><div><h2>Caja simple</h2><p class="muted">Cobros de órdenes y movimientos manuales. El resultado no representa ganancia contable.</p></div><div class="cash-actions"><button data-cash-add="Ingreso">+ Registrar ingreso</button><button class="ghost" data-cash-add="Egreso">− Registrar egreso</button></div></div><section class="cash-filters panel"><label>Período<select id="cashPeriod"><option value="today" ${filter.period === "today" ? "selected" : ""}>Hoy</option><option value="week" ${filter.period === "week" ? "selected" : ""}>Esta semana</option><option value="month" ${filter.period === "month" ? "selected" : ""}>Este mes</option><option value="custom" ${filter.period === "custom" ? "selected" : ""}>Rango personalizado</option></select></label><label class="cash-custom" ${filter.period === "custom" ? "" : "hidden"}>Desde<input id="cashStart" type="date" value="${esc(filter.start)}"></label><label class="cash-custom" ${filter.period === "custom" ? "" : "hidden"}>Hasta<input id="cashEnd" type="date" value="${esc(filter.end)}"></label></section><section class="cash-stats"><article class="cash-stat income"><small>Ingresos del período</small><b>${money(summary.income)}</b><span>${money(summary.payment)} cobros · ${money(summary.manualIncome)} manuales</span></article><article class="cash-stat expense"><small>Egresos del período</small><b>${money(summary.expense)}</b><span>Gastos y retiros manuales</span></article><article class="cash-stat net"><small>Resultado neto</small><b>${money(summary.net)}</b><span>Ingresos menos egresos</span></article></section><section class="panel cash-mediums"><div class="toolbar"><h2>Flujo neto por medio</h2><small class="muted">Efectivo registrado, sin saldo de apertura.</small></div><div class="cash-medium-list">${mediums.map(([medium, amount]) => `<div><span>${esc(medium)}</span><b class="${amount < 0 ? "negative" : ""}">${money(amount)}</b></div>`).join("") || '<p class="muted">No hay movimientos para este período.</p>'}</div></section><section class="toolbar"><div><h2>Movimientos</h2><p class="muted">${records.length} movimiento${records.length === 1 ? "" : "s"} en el período.</p></div></section><section class="cash-list">${records.map((record) => `<article class="cash-row ${record.Tipo === "Egreso" ? "is-expense" : "is-income"}"><div class="cash-row-main"><div><span class="badge cash-badge ${record.source === "payment" ? "cash-payment" : ""}">${record.source === "payment" ? "Cobro de orden" : esc(record.Tipo)}</span><strong>${esc(record.Categoria || "Sin categoría")}</strong><p>${esc(record.Descripcion || "Sin descripción")}</p></div><b class="${record.Tipo === "Egreso" ? "negative" : "positive"}">${record.Tipo === "Egreso" ? "−" : "+"}${money(record.Importe)}</b></div><div class="cash-row-meta"><span>${esc(cashDateLabel(record.Fecha))}</span><span>${esc(record.Medio || "Sin medio")}</span>${record.Responsable ? `<span>${esc(record.Responsable)}</span>` : ""}</div></article>`).join("") || '<div class="empty">No hay cobros ni movimientos en el período seleccionado.</div>'}</section>`;
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
      FechaIngreso: new Date().toISOString().slice(0, 10),
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
      Fecha: new Date().toISOString().slice(0, 10),
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
    body = `<div class="fields"><label>Buscar cliente<input id="intakeClientSearch" value="${esc(i.clientQuery || "")}" placeholder="Nombre, DNI o teléfono"></label><label>Opción<select id="intakeClientMode"><option value="existing" ${i.clientMode === "existing" ? "selected" : ""}>Cliente existente</option><option value="new" ${i.clientMode === "new" ? "selected" : ""}>Nuevo cliente</option></select></label></div>${i.clientMode === "existing" ? `<div class="intake-options">${matches.map((x) => `<button type="button" class="${i.clientId === x.IDCliente ? "selected" : ""}" data-intake-client="${esc(x.IDCliente)}"><b>${esc(x.Nombre)}</b><small>${esc(x.Telefono || x.DNI || "Sin contacto")}</small></button>`).join("") || '<p class="muted">Buscá o registrá un cliente nuevo.</p>'}</div>` : `<div class="fields"><label>Nombre<input data-intake-client-field="Nombre" value="${esc(i.client.Nombre || "")}" required></label><label>Teléfono<input data-intake-client-field="Telefono" value="${esc(i.client.Telefono || "")}" required></label><label>WhatsApp<input data-intake-client-field="WhatsApp" value="${esc(i.client.WhatsApp || "")}"></label><label>DNI<input data-intake-client-field="DNI" value="${esc(i.client.DNI || "")}"></label><label>Domicilio<input data-intake-client-field="Domicilio" value="${esc(i.client.Domicilio || "")}"></label><label>Observaciones<textarea data-intake-client-field="Observaciones">${esc(i.client.Observaciones || "")}</textarea></label></div>`}`;
  } else if (i.step === 2) {
    const bikes = client?.IDCliente
      ? (state.db.Motos || []).filter((x) => x.IDCliente === client.IDCliente)
      : [];
    body = `<p class="muted">Cliente: <b>${esc(client?.Nombre || "Sin seleccionar")}</b></p><div class="fields"><label>Opción<select id="intakeMotoMode"><option value="existing" ${i.motoMode === "existing" ? "selected" : ""}>Moto existente</option><option value="new" ${i.motoMode === "new" ? "selected" : ""}>Nueva moto</option></select></label></div>${i.motoMode === "existing" ? `<div class="intake-options">${bikes.map((x) => `<button type="button" class="${i.motoId === x.IDMoto ? "selected" : ""}" data-intake-moto="${esc(x.IDMoto)}"><b>${esc([x.Patente, x.Marca, x.Modelo].filter(Boolean).join(" · "))}</b></button>`).join("") || '<p class="muted">No hay motos para este cliente. Registrá una nueva.</p>'}</div>` : `<div class="fields">${["Patente", "Marca", "Modelo", "Cilindrada", "Anio", "Color", "Chasis", "Observaciones"].map((field) => `<label>${field}<input data-intake-moto-field="${field}" value="${esc(i.moto[field] || "")}" ${["Patente", "Marca", "Modelo"].includes(field) ? "required" : ""}></label>`).join("")}</div>`}`;
  } else if (i.step === 3) {
    body = `<div class="fields"><label>Fecha de ingreso<input data-intake-reception="FechaIngreso" type="date" value="${esc(i.reception.FechaIngreso)}" required></label><label>Kilometraje<input data-intake-reception="Kilometraje" type="number" min="0" value="${esc(i.reception.Kilometraje)}"></label><label>Estado<input value="Recibida" readonly></label><label>Fecha prometida<input data-intake-reception="FechaPrometida" type="date" value="${esc(i.reception.FechaPrometida)}"></label><label class="intake-wide">Problema informado<textarea data-intake-reception="Problema" required>${esc(i.reception.Problema)}</textarea></label><label class="intake-wide">Observaciones<textarea data-intake-reception="Observaciones">${esc(i.reception.Observaciones)}</textarea></label></div>`;
  } else if (i.step === 4) {
    body = `<p class="muted">Las fotos se subirán sólo después de crear la orden. Los borradores no conservan archivos seleccionados.</p><div class="intake-photo-actions"><label class="ghost">Tomar foto<input id="intakeCamera" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple hidden></label><label class="ghost">Elegir archivo<input id="intakeFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden></label></div><div id="intakePreviews" class="intake-previews"></div>`;
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
      : !i.client.Nombre.trim() || !i.client.Telefono.trim())
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
    `${state.db.Clientes.length} clientes · ${state.db.Motos.length} motos · ${state.db.Ordenes_Trabajo.length} órdenes`;
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
        client: intake.clientId ? null : intake.client,
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
function orderCard(o) {
  const t = totals(o.IDOrden),
    m = (state.db.Motos || []).find((x) => x.IDMoto === o.IDMoto),
    title = m ? `${m.Patente} · ${m.Marca} ${m.Modelo}` : moto(o.IDMoto),
    date = o.FechaIngreso
      ? new Date(o.FechaIngreso).toLocaleDateString("es-AR")
      : "Sin fecha";
  return `<article class="item order-card"><div class="itemhead"><div><strong>${esc(title)}</strong><div class="order-meta"><span>Ingreso: ${esc(date)}</span><span>${esc(o.Problema || "Sin detalle")}</span></div></div><span class="badge" data-state="${esc(o.Estado)}">${esc(o.Estado || "Sin estado")}</span></div><p class="amounts"><span>Total <b>${money(t.total)}</b></span><span>Cobrado <b>${money(t.paid)}</b></span><span>Saldo <b class="due">${money(t.due)}</b></span></p><button data-open="${esc(o.IDOrden)}">Abrir orden</button><button class="ghost" data-edit="Ordenes_Trabajo:${esc(o.IDOrden)}">Editar</button></article>`;
}
function orderCardView(o) {
  const summary = totals(o.IDOrden);
  const bike = (state.db.Motos || []).find((row) => row.IDMoto === o.IDMoto);
  const client =
    bike &&
    (state.db.Clientes || []).find((row) => row.IDCliente === bike.IDCliente);
  const title = bike
    ? [bike.Patente, bike.Marca, bike.Modelo].filter(Boolean).join(" · ")
    : moto(o.IDMoto);
  const next = nextOrderStage(o.Estado);
  return `<article class="item order-card"><div class="itemhead"><div><strong>${esc(title)}</strong><div class="order-meta"><span>Orden: ${esc(o.IDOrden)}</span><span>Cliente: ${esc(client?.Nombre || "Sin cliente")}</span><span>Ingreso: ${esc(argentinaDate(o.FechaIngreso))}</span><span>${esc(o.Problema || "Sin detalle")}</span></div></div><span class="badge" data-state="${esc(o.Estado)}">${esc(orderStageLabel(o.Estado))}</span></div><p class="amounts"><span>Presupuesto <b>${money(summary.total)}</b></span><span>Cobrado <b>${money(summary.paid)}</b></span><span>Saldo <b class="due">${money(summary.due)}</b></span></p><div class="order-actions"><button data-open="${esc(o.IDOrden)}">Abrir orden</button>${next ? `<button class="ghost" data-order-stage="${esc(o.IDOrden)}" data-next-stage="${esc(next)}">Avanzar: ${esc(orderStageLabel(next))}</button>` : ""}<button class="ghost" data-edit="Ordenes_Trabajo:${esc(o.IDOrden)}">Editar</button></div></article>`;
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
function customerDetail(id) {
  const customer = (state.db.Clientes || []).find(
    (row) => row.IDCliente === id,
  );
  if (!customer) return toast("No se encontró el cliente.");
  state.galleryAbortController?.abort();
  state.activeOrderId = "";
  state.galleryRequest += 1;
  const bikes = (state.db.Motos || []).filter((row) => row.IDCliente === id);
  const phone = String(customer.Telefono || "").trim();
  const whatsapp =
    normalizeWhatsApp(customer.WhatsApp) || normalizeWhatsApp(phone, true);
  const contactActions = [
    phone
      ? `<a class="contact-link" href="tel:${esc(phone.replace(/[^+\d]/g, ""))}">📞 Llamar</a>`
      : "",
    whatsapp
      ? `<a class="contact-link contact-whatsapp" href="https://wa.me/${whatsapp}" target="_blank" rel="noopener noreferrer">${whatsappIcon} WhatsApp</a>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  const detail = [
    ["Teléfono", customer.Telefono],
    ["WhatsApp", customer.WhatsApp],
    ["DNI", customer.DNI],
    ["Domicilio", customer.Domicilio],
    ["Observaciones", customer.Observaciones],
  ]
    .filter(([, value]) => String(value || "").trim())
    .map(
      ([label, value]) =>
        `<div class="contact-field"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`,
    )
    .join("");
  $("#content").innerHTML =
    `<div class="toolbar"><div><h2>Ficha del cliente</h2><p class="muted">Agenda de contactos y motocicletas asociadas.</p></div><button class="ghost" id="back">← Volver a clientes</button></div><section class="panel contact-profile"><div class="contact-profile-head"><div class="contact-avatar">${esc((customer.Nombre || "C").trim().charAt(0).toUpperCase())}</div><div><h2>${esc(customer.Nombre || "Cliente sin nombre")}</h2><p class="muted">${bikes.length} moto${bikes.length === 1 ? "" : "s"} registrada${bikes.length === 1 ? "" : "s"}</p></div></div><div class="contact-actions">${contactActions}<button class="ghost" data-edit="Clientes:${esc(id)}">Editar cliente</button></div><div class="contact-fields">${detail || '<p class="muted">Sin datos adicionales.</p>'}</div></section><div class="toolbar"><h2>Motos asociadas (${bikes.length})</h2><button data-add-client-moto="${esc(id)}">+ Agregar moto</button></div><div class="list">${bikes.map(motoCard).join("") || '<div class="empty">Este cliente todavía no tiene motos registradas.</div>'}</div>`;
  $("#back").onclick = () => {
    state.view = "Clientes";
    render();
  };
  wire();
}

function customerCard(client) {
  const phone = String(client.Telefono || "").trim(),
    whatsapp = String(client.WhatsApp || "").trim(),
    waNumber = normalizeWhatsApp(whatsapp) || normalizeWhatsApp(phone, true);
  const bikesCount = (state.db.Motos || []).filter(
    (bike) => bike.IDCliente === client.IDCliente,
  ).length;
  const rows = [
    phone && `<div><span>Teléfono</span><b>${esc(phone)}</b></div>`,
    whatsapp && `<div><span>WhatsApp</span><b>${esc(whatsapp)}</b></div>`,
    client.DNI && `<div><span>DNI</span><b>${esc(client.DNI)}</b></div>`,
    client.Domicilio &&
      `<div class="customer-wide"><span>Domicilio</span><b>${esc(client.Domicilio)}</b></div>`,
  ]
    .filter(Boolean)
    .join("");
  return `<article class="item customer-card"><div class="itemhead"><div><strong>${esc(client.Nombre || "Cliente sin nombre")}</strong></div><div class="customer-actions">${waNumber ? `<a class="whatsapp-button" href="https://wa.me/${waNumber}" target="_blank" rel="noopener noreferrer" aria-label="Abrir WhatsApp de ${esc(client.Nombre || "cliente")}">${whatsappIcon}<span>WhatsApp</span></a>` : ""}<button data-open-client="${esc(client.IDCliente)}">Ver ficha · ${bikesCount} moto${bikesCount === 1 ? "" : "s"}</button><button class="ghost" data-edit="Clientes:${esc(client.IDCliente)}">Editar</button></div></div><div class="customer-data">${rows || '<span class="muted">Sin datos de contacto.</span>'}</div>${client.Observaciones ? `<p class="customer-note">${esc(client.Observaciones)}</p>` : ""}</article>`;
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
  return `<article class="item moto-card"><div class="itemhead"><div><strong>${esc(title)}</strong><small>Cliente: ${esc(owner?.Nombre || "Sin cliente")}</small></div><div class="customer-actions">${owner ? `<button class="ghost" data-open-client="${esc(owner.IDCliente)}">Ver cliente</button>` : ""}<button data-open-moto="${esc(bike.IDMoto)}">Ver historial</button><button class="ghost" data-edit="Motos:${esc(bike.IDMoto)}">Editar</button><button class="ghost" data-moto-active="${esc(bike.IDMoto)}" data-active="${motoIsActive(bike) ? "false" : "true"}">${motoIsActive(bike) ? "Dar de baja" : "Reactivar"}</button></div></div>${!motoIsActive(bike) ? '<p class="muted"><b>● Moto dada de baja</b></p>' : ""}<p class="muted">${historyCount} orden${historyCount === 1 ? "" : "es"} registrada${historyCount === 1 ? "" : "s"}</p></article>`;
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
function list(table) {
  if (!defs[table]) return;
  const rows =
    table === "Pagos"
      ? (state.db[table] || []).filter((row) => !isDuplicatedPaymentHeader(row))
      : state.db[table] || [];
  $("#content").innerHTML =
    `<div class="toolbar"><div><h2>${defs[table].title}</h2><p class="muted">${rows.length} registro${rows.length === 1 ? "" : "s"}</p></div><button data-add="${table}">+ Nuevo</button></div>${table === "Motos" ? '<label style="display:flex;align-items:center;gap:10px;margin:12px 0;cursor:pointer"><input type="checkbox" id="showInactiveMotos" style="width:20px;height:20px"> Mostrar motos dadas de baja</label>' : ""}<input id="search" placeholder="Buscar por nombre, patente, descripción…" aria-label="Buscar en ${defs[table].title}"><div class="list" id="results"></div>`;
  const display = () => {
    $("#results").innerHTML =
      rows
        .filter(
          (r) =>
            table !== "Motos" ||
            motoIsActive(r) ||
            $("#showInactiveMotos")?.checked,
        )
        .filter((r) => {
          const query = $("#search").value.trim();
          if (!query) return true;
          const searchable = searchableRecord(table, r);
          return query
            .split(/\s+/)
            .every((term) => searchable.includes(normalizeSearch(term)));
        })
        .map((r) =>
          table === "Clientes"
            ? customerCard(r)
            : table === "Motos"
              ? motoCard(r)
              : table === "Pagos"
                ? paymentCard(r)
                : table === "Ordenes_Trabajo"
                  ? orderCardView(r)
                  : `<div class="item"><strong>${esc(r.Nombre || r.Descripcion || r.Patente || r.IDPago || r.IDRepuesto || r.IDServicio)}</strong><small>${esc(Object.values(r).slice(1, 5).join(" · "))}</small><div><button class="ghost" data-edit="${table}:${esc(r[Object.keys(defs).includes(table) ? { Clientes: "IDCliente", Motos: "IDMoto", Pagos: "IDPago", Servicios: "IDServicio", Repuestos: "IDRepuesto" }[table] : "IDOrden"])}">Editar</button></div></div>`,
        )
        .join("") || '<div class="empty">No se encontraron registros.</div>';
    wire();
  };
  $("#search").oninput = display;
  $("#showInactiveMotos")?.addEventListener("change", display);
  display();
}
function selectOpts(field) {
  let arr = [];
  if (field === "IDCliente")
    arr = state.db.Clientes.map((x) => [x.IDCliente, x.Nombre]);
  if (field === "IDMoto")
    arr = state.db.Motos.map((x) => [x.IDMoto, moto(x.IDMoto)]);
  if (field === "IDOrden")
    arr = state.db.Ordenes_Trabajo.map((x) => [
      x.IDOrden,
      moto(x.IDMoto) + " · " + x.Estado,
    ]);
  if (field === "Estado") arr = ORDER_STAGES;
  if (field === "Tipo") arr = ["Servicio", "Repuesto"].map((x) => [x, x]);
  if (field === "Medio")
    arr = ["Efectivo", "Transferencia", "Débito", "Crédito", "QR", "Otro"].map(
      (x) => [x, x],
    );
  return arr;
}
function form(table, id = "", preset = {}) {
  state.activeOrderId = "";
  state.galleryRequest += 1;
  const def = defs[table],
    pk = {
      Clientes: "IDCliente",
      Motos: "IDMoto",
      Ordenes_Trabajo: "IDOrden",
      Detalle_Trabajo: "IDDetalle",
      Pagos: "IDPago",
      Servicios: "IDServicio",
      Repuestos: "IDRepuesto",
    }[table];
  const existing = (state.db[table] || []).find((x) => x[pk] === id) || {};
  const row = { ...existing, ...preset };
  $("#content").innerHTML =
    `<div class="toolbar"><h2>${id ? "Editar" : "Nuevo"} · ${def.title}</h2><button class="ghost" id="back">Volver</button></div><form id="editForm" class="panel"><div class="fields">${def.fields
      .map((f) => {
        const opts = selectOpts(f),
          value = row[f] ?? "",
          req = def.required.includes(f) ? "required" : "";
        const input = opts.length
          ? `<select name="${f}" ${req}><option value="">Seleccionar…</option>${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(value) === String(v) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`
          : f === "Observaciones" || f === "Problema" || f === "Diagnostico"
            ? `<textarea name="${f}" ${req}>${esc(value)}</textarea>`
            : `<input name="${f}" value="${esc(value)}" ${req} ${["Importe", "Cantidad", "PrecioUnitario", "PrecioSugerido", "Costo", "PrecioVenta", "Descuento", "Kilometraje", "Cilindrada", "Anio"].includes(f) ? 'type="number" step="any" min="0"' : f.startsWith("Fecha") ? 'type="date"' : 'type="text"'}>`;
        return `<label>${esc(f)}${input}</label>`;
      })
      .join("")}</div><button>Guardar</button></form>`;
  $("#back").onclick = render;
  $("#editForm").onsubmit = async (e) => {
    e.preventDefault();

    const formulario = e.currentTarget;
    const boton = formulario.querySelector(
      'button[type="submit"], button:not([type])',
    );

    // Evitar doble clic o múltiples envíos simultáneos
    if (formulario.dataset.saving === "true") return;

    formulario.dataset.saving = "true";

    if (boton) {
      boton.disabled = true;
      boton.textContent = "Guardando...";
    }

    const obj = Object.fromEntries(new FormData(formulario));
    if (id) obj[pk] = id;

    try {
      await api("save", { table, record: obj });

      toast("Guardado correctamente");

      await load();
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        showLogin(error.message);
      } else {
        toast("No se pudo guardar: " + error.message);
      }
    } finally {
      formulario.dataset.saving = "false";

      if (boton) {
        boton.disabled = false;
        boton.textContent = "Guardar";
      }
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

function orderDetail(id) {
  const o = state.db.Ordenes_Trabajo.find((x) => x.IDOrden === id);
  if (!o) return;
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

  $("#content").innerHTML =
    `<button class="ghost" id="back">← Volver</button><h2>${esc(moto(o.IDMoto))}</h2><div class="panel"><b>${esc(o.Estado)}</b><p>Problema: ${esc(o.Problema)}</p><p>Diagnóstico: ${esc(o.Diagnostico)}</p><p>Kilometraje: ${esc(o.Kilometraje)}</p><button data-edit="Ordenes_Trabajo:${id}">Editar orden</button></div><h2>Servicios y repuestos</h2><div class="list">${d.map((x) => `<div class="item">${esc(x.Tipo)} · ${esc(x.Descripcion)} · ${esc(x.Cantidad)} × ${money(Number(x.PrecioUnitario))} = ${money(Number(x.Subtotal))}</div>`).join("")}</div><button data-concept="${id}">+ Agregar concepto</button><h2>Pagos</h2><div class="panel"><p>Total: ${money(t.total)} · Cobrado: ${money(t.paid)}</p><h2 class="${t.due > 0 ? "danger" : "success"}">Saldo: ${money(t.due)}</h2>${p.map((x) => `<p>${esc(x.Medio)} · ${money(Number(x.Importe))}</p>`).join("")}<button data-pay="${id}">+ Registrar cobro</button></div><h2>Fotografías</h2><div class="panel">${gallery}<form id="photoForm"><div class="fields"><label>Tipo<select name="Tipo"><option>Ingreso</option><option>Diagnóstico</option><option>Reparación</option><option>Entrega</option><option>General</option></select></label><label>Foto<input type="file" name="foto" accept="image/*" capture="environment" required></label></div><button>Subir foto</button></form><small>Las fotos se almacenan de forma privada en Google Drive.</small></div><button id="print" class="ghost">Imprimir comprobante / Guardar PDF</button>`;
  $("#back").onclick = render;
  $("#print").onclick = () => printOrder(id);
  $("#photoForm input[type=file]").accept = "image/jpeg,image/png,image/webp";
  $("#photoForm").onsubmit = async (e) => {
    e.preventDefault();
    const file = e.target.foto.files[0];
    if (!file) return;
    if (!isSupportedPhotoFile(file))
      return toast("Solo se admiten fotografías JPG, PNG o WEBP.");
    const submit = e.target.querySelector(
      "button[type=submit], button:not([type])",
    );
    if (submit?.disabled) return;
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Subiendo fotografía…";
    }
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
      toast("Fotografía guardada correctamente.");
      orderDetail(id);
    } catch (error) {
      if (error instanceof SessionExpiredError) showLogin(error.message);
      else toast(`No se pudo guardar la fotografía. ${error.message}`);
    } finally {
      if ($("#photoForm button")) {
        $("#photoForm button").disabled = false;
        $("#photoForm button").textContent = "Subir foto";
      }
    }
  };
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
function motoDetail(id) {
  const bike = (state.db.Motos || []).find((row) => row.IDMoto === id);
  if (!bike) return;
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
    `<div class="toolbar"><div><h2>${esc(title || "Moto")}</h2><p class="muted">Cliente: ${esc(owner?.Nombre || "Sin cliente")}</p></div><div>${owner ? `<button class="ghost" data-open-client="${esc(owner.IDCliente)}">Ver ficha del cliente</button>` : ""}<button class="ghost" id="back">Volver a motos</button><button data-edit="Motos:${esc(id)}">Editar moto</button><button class="ghost" data-moto-active="${esc(id)}" data-active="${motoIsActive(bike) ? "false" : "true"}">${motoIsActive(bike) ? "Dar de baja" : "Reactivar"}</button></div></div>${!motoIsActive(bike) ? '<p class="muted"><b>● Moto dada de baja</b></p>' : ""}<section class="panel"><h2>Historial de servicios</h2><p class="muted">Órdenes vinculadas a esta moto, desde el ingreso más reciente.</p><div class="list">${history}</div></section>`;
  $("#back").onclick = () => {
    state.view = "Motos";
    render();
  };
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
function wire() {
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
      (b.onclick = () =>
        form("Pagos", "", {
          IDOrden: b.dataset.pay,
          Fecha: new Date().toISOString().slice(0, 10),
          Medio: "Efectivo",
        })),
  );
}
