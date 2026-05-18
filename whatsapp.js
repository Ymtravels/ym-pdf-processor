/**
 * WhatsApp chat parsing for YM Travel cost tracking.
 *
 * processWhatsAppChat is wired into the YM Travel menu by the onOpen() in
 * "ym travel sheets.js". processWhatsAppChatForceRewrite is intentionally
 * NOT in the menu; run it from the Apps Script editor when needed.
 */

const WHATSAPP_FOLDER_NAME = "YM travel whatsapp costs";
const COST_DATA_TAB_NAME = "Cost Data";
const OPERATOR_NAME_FILTER = "Zalman";
const WHATSAPP_FROM = "Mendy";
const WHATSAPP_SYSTEM = "Gol AR";

const COST_DATA_HEADERS = ["Date", "Time", "PNR", "Passenger Names", "Cost", "Sender", "Source Message"];

const MAIN_FROM_COL = 4;      // D
const MAIN_SYSTEM_COL = 5;    // E
const MAIN_OPERATOR_COL = 6;  // F
const MAIN_COST_COL = 7;      // G
const MAIN_PNR_COL = 16;      // P

const DATE_STAMP_RE = /^(\d{1,2}\/\d{1,2}\/\d{2}),\s+(\d{1,2}:\d{2})\s+(AM|PM)\s+-\s+([^:]+):\s?(.*)$/;
const PNR_RE = /^[A-Z0-9]{6}$/;
const REFERENCE_RE = /^\d{3}-?\d{10}$/;
const AGENT_RE = /^[cC]\s+\S/;
const COST_RE = /^\$?(\d+(?:\.\d+)?)$/;
const ALL_CAPS_NAME_RE = /^[A-Z][A-Z\s]+[A-Z]$/;
const EDITED_TAG_RE = /\s*<This message was edited>\s*$/;

function processWhatsAppChat() {
  runWhatsAppChat_(false);
}

function processWhatsAppChatForceRewrite() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    "Force Rewrite Column G",
    "This will OVERWRITE existing values in Column G (Cost) for Zalman rows.\n\n" +
    "Columns D and E will still be protected from overwrite.\n\nContinue?",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;
  runWhatsAppChat_(true);
}

function runWhatsAppChat_(forceRewriteG) {
  const ui = SpreadsheetApp.getUi();

  const promptResponse = ui.prompt(
    "Process WhatsApp Chat",
    "Process messages from date (YYYY-MM-DD) - leave blank for all messages:",
    ui.ButtonSet.OK_CANCEL
  );

  let cutoffDate = null;
  if (promptResponse.getSelectedButton() === ui.Button.OK) {
    const inputText = promptResponse.getResponseText().trim();
    if (inputText !== "") {
      cutoffDate = parseISODate_(inputText);
      if (!cutoffDate) {
        ui.alert('Invalid date: "' + inputText + '". Use YYYY-MM-DD format.');
        return;
      }
    }
  }
  // CANCEL or CLOSE -> cutoffDate stays null -> process all messages.

  const file = findWhatsAppFile_();
  if (!file) return;

  // Newer WhatsApp exports use U+202F (narrow no-break space) before AM/PM.
  const text = file.getBlob().getDataAsString().replace(/ /g, " ");
  let messages = splitIntoMessages_(text);

  if (cutoffDate) {
    const cutoffMs = cutoffDate.getTime();
    messages = messages.filter(msg => {
      const msgDate = whatsAppDateToDate_(msg.date);
      return msgDate && msgDate.getTime() >= cutoffMs;
    });
  }

  const bookings = [];
  for (const msg of messages) {
    const messageBookings = parseBookingFromMessage_(msg);
    bookings.push(...messageBookings);
  }

  writeCostDataTab_(bookings);
  const result = applyCostFormulas_(forceRewriteG);
  showSummaryAlert_(bookings.length, result.filled, result.fromFilled, result.systemFilled, result.skippedExisting, result.unmatchedPNRs);
}

function findWhatsAppFile_() {
  const ui = SpreadsheetApp.getUi();
  const folders = DriveApp.getFoldersByName(WHATSAPP_FOLDER_NAME);
  if (!folders.hasNext()) {
    ui.alert("Drive folder not found: " + WHATSAPP_FOLDER_NAME);
    return null;
  }
  const folder = folders.next();
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().endsWith(".txt")) return f;
  }
  ui.alert("No .txt files found in folder: " + WHATSAPP_FOLDER_NAME);
  return null;
}

function splitIntoMessages_(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(EDITED_TAG_RE, "");
    const m = line.match(DATE_STAMP_RE);
    if (m) {
      if (current) messages.push(current);
      current = {
        date: m[1],
        time: m[2] + " " + m[3],
        sender: m[4].trim(),
        body: m[5]
      };
    } else if (current) {
      current.body += "\n" + line;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function parseBookingFromMessage_(msg) {
  const lines = msg.body.split(/\r?\n/);
  const pnrs = [];
  const refs = [];
  const agents = [];
  const costs = [];
  const names = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(EDITED_TAG_RE, "").trim();
    if (!line) continue;

    if (REFERENCE_RE.test(line)) {
      refs.push(line);
      continue;
    }
    if (COST_RE.test(line)) {
      const num = Number(line.match(COST_RE)[1]);
      if (num <= 99999) {
        costs.push(num);
        continue;
      }
      // Number too large to be a real travel cost — fall through to next classifier.
    }
    if (AGENT_RE.test(line)) {
      agents.push(line);
      continue;
    }
    if (PNR_RE.test(line)) {
      pnrs.push(line);
      continue;
    }
    if (ALL_CAPS_NAME_RE.test(line) && line.includes(" ")) {
      names.push(line);
    }
  }

  const fieldsPresent = (pnrs.length > 0 ? 1 : 0)
                      + (refs.length > 0 ? 1 : 0)
                      + (agents.length > 0 ? 1 : 0)
                      + (costs.length > 0 ? 1 : 0);

  if (fieldsPresent < 2) return [];
  if (pnrs.length === 0) return []; // no PNR = nothing to look up later

  const base = {
    date: msg.date,
    time: msg.time,
    names: names.join(" / "),
    sender: msg.sender,
    rawBody: msg.body.trim()
  };

  if (pnrs.length === 1 && costs.length === 1) {
    return [{ ...base, pnr: pnrs[0], cost: costs[0] }];
  }
  if (pnrs.length === 1 && costs.length === 2) {
    return [{ ...base, pnr: pnrs[0], cost: costs[0] + costs[1] }];
  }
  if (pnrs.length === 2 && costs.length === 1) {
    return [{ ...base, pnr: pnrs.join(" / "), cost: costs[0] }];
  }
  if (pnrs.length === 2 && costs.length === 2) {
    return [
      { ...base, pnr: pnrs[0], cost: costs[0] },
      { ...base, pnr: pnrs[1], cost: costs[1] }
    ];
  }
  // Edge case: >2 PNRs or >2 costs, or 0 costs with PNRs present.
  return [{
    ...base,
    pnr: pnrs.join(" / "),
    cost: costs.length > 0 ? costs.join(" / ") : ""
  }];
}

function writeCostDataTab_(bookings) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(COST_DATA_TAB_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(COST_DATA_TAB_NAME);
  } else {
    sheet.clearContents();
  }

  const rows = [COST_DATA_HEADERS];
  for (const b of bookings) {
    rows.push([b.date, b.time, b.pnr, b.names, b.cost, b.sender, b.rawBody]);
  }
  sheet.getRange(1, 1, rows.length, COST_DATA_HEADERS.length).setValues(rows);
}

function applyCostFormulas_(forceRewriteG) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { filled: 0, fromFilled: 0, systemFilled: 0, skippedExisting: 0, unmatchedPNRs: [] };

  // exactCostMap keys = the verbatim Column C value ("ABC" or "ABC / DEF").
  // containedInMerged = individual PNRs that appear inside any merged row.
  const costSheet = ss.getSheetByName(COST_DATA_TAB_NAME);
  const exactCostMap = new Map();
  const containedInMerged = new Set();
  if (costSheet && costSheet.getLastRow() >= 2) {
    const costValues = costSheet.getRange(2, 3, costSheet.getLastRow() - 1, 3).getValues();
    for (const row of costValues) {
      const pnrCell = String(row[0] || "").trim();
      const cost = row[2];
      if (!pnrCell || cost === "" || cost === null) continue;
      exactCostMap.set(pnrCell, cost);
      if (pnrCell.includes("/")) {
        const parts = pnrCell.split(/\s*\/\s*/).filter(Boolean);
        for (const p of parts) containedInMerged.add(p);
      }
    }
  }

  const numRows = lastRow - 1;
  const operators = sheet.getRange(2, MAIN_OPERATOR_COL, numRows, 1).getValues();
  const pnrs = sheet.getRange(2, MAIN_PNR_COL, numRows, 1).getValues();
  const existingCosts = sheet.getRange(2, MAIN_COST_COL, numRows, 1).getValues();
  const existingFormulas = sheet.getRange(2, MAIN_COST_COL, numRows, 1).getFormulas();
  const existingFroms = sheet.getRange(2, MAIN_FROM_COL, numRows, 1).getValues();
  const existingFromFormulas = sheet.getRange(2, MAIN_FROM_COL, numRows, 1).getFormulas();
  const existingSystems = sheet.getRange(2, MAIN_SYSTEM_COL, numRows, 1).getValues();
  const existingSystemFormulas = sheet.getRange(2, MAIN_SYSTEM_COL, numRows, 1).getFormulas();

  let filled = 0;
  let fromFilled = 0;
  let systemFilled = 0;
  let skippedExisting = 0;
  const unmatchedPNRs = [];

  for (let i = 0; i < numRows; i++) {
    const operator = String(operators[i][0] || "").trim();
    if (operator !== OPERATOR_NAME_FILTER) continue;

    const pnrCell = String(pnrs[i][0] || "").trim();
    if (!pnrCell) continue;

    const gAlreadyHasData = !forceRewriteG &&
      (existingCosts[i][0] !== "" || existingFormulas[i][0] !== "");

    // Classify the row: would this PNR match Cost Data, and what cost value
    // would we write to Column G if it were empty? This runs even when G
    // already has data, because a successful match still entitles D/E to be filled.
    let matched = false;
    let costValue = null;      // numeric cost we'd write if G is writable
    const unmatchedToAdd = []; // PNRs we'd push to the unmatched list if G is writable

    if (pnrCell.includes("/")) {
      // Merged PNR in main tab.
      const parts = pnrCell.split(/\s*\/\s*/).filter(Boolean);
      const spacedKey = parts.join(" / ");

      if (exactCostMap.has(spacedKey)) {
        matched = true;
        costValue = exactCostMap.get(spacedKey);
      } else {
        const missing = parts.filter(p => !exactCostMap.has(p));
        if (missing.length > 0) {
          for (const m of missing) unmatchedToAdd.push(m);
        } else {
          matched = true;
          costValue = parts.reduce((sum, p) => sum + Number(exactCostMap.get(p)), 0);
        }
      }
    } else {
      // Single PNR in main tab.
      if (exactCostMap.has(pnrCell)) {
        matched = true;
        costValue = exactCostMap.get(pnrCell);
      } else if (containedInMerged.has(pnrCell)) {
        unmatchedToAdd.push(pnrCell + " (only in merged WhatsApp row)");
      } else {
        // Not in Cost Data at all — leave G blank, just report as unmatched.
        unmatchedToAdd.push(pnrCell);
      }
    }

    // Apply: respect the G safety, then count and write D/E for matched rows.
    const rowNum = i + 2;
    if (gAlreadyHasData) {
      skippedExisting++;
      // Don't write G. Don't push to unmatched — the user already has data there.
    } else {
      if (costValue !== null) {
        sheet.getRange(rowNum, MAIN_COST_COL).setValue(costValue);
      }
      for (const u of unmatchedToAdd) unmatchedPNRs.push(u);
      if (matched) filled++;
    }

    // D/E only when the row actually matched, regardless of G state.
    if (!matched) continue;
    if (existingFroms[i][0] === "" && existingFromFormulas[i][0] === "") {
      sheet.getRange(rowNum, MAIN_FROM_COL).setValue(WHATSAPP_FROM);
      fromFilled++;
    }
    if (existingSystems[i][0] === "" && existingSystemFormulas[i][0] === "") {
      sheet.getRange(rowNum, MAIN_SYSTEM_COL).setValue(WHATSAPP_SYSTEM);
      systemFilled++;
    }
  }

  return { filled, fromFilled, systemFilled, skippedExisting, unmatchedPNRs };
}

function showSummaryAlert_(parsed, filled, fromFilled, systemFilled, skippedExisting, unmatched) {
  const ui = SpreadsheetApp.getUi();
  const lines = [];
  lines.push("Bookings parsed from WhatsApp: " + parsed);
  lines.push("Cost values filled in main tab: " + filled);
  lines.push('"From" cells filled in main tab: ' + fromFilled);
  lines.push('"System" cells filled in main tab: ' + systemFilled);
  lines.push("Rows skipped (already had data): " + skippedExisting);
  lines.push("");
  if (unmatched.length === 0) {
    lines.push("All PNRs matched.");
  } else {
    lines.push("Unmatched PNRs (" + unmatched.length + "):");
    const shown = unmatched.slice(0, 30);
    for (const p of shown) lines.push("  - " + p);
    if (unmatched.length > 30) {
      lines.push("  ...and " + (unmatched.length - 30) + " more");
    }
  }
  ui.alert("WhatsApp Chat Processed", lines.join("\n"), ui.ButtonSet.OK);
}

function parseISODate_(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  // Catch invalid dates like 2026-02-30, which Date silently rolls forward.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt;
}

function whatsAppDateToDate_(dateStr) {
  // M/D/YY format. yy < 80 -> 2000s, else 1900s.
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const yy = Number(m[3]);
  const year = yy < 80 ? 2000 + yy : 1900 + yy;
  return new Date(year, month - 1, day);
}

// Diagnostic only — DOES NOT modify the sheet. Mirrors the safety check used by
// applyCostFormulas_ in non-force mode so you can see, per row, whether Column G
// would be protected or would get overwritten on the next processWhatsAppChat run.
function diagnoseColumnG() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("No data rows on active sheet.");
    return;
  }

  const numRows = lastRow - 1;
  const operators = sheet.getRange(2, MAIN_OPERATOR_COL, numRows, 1).getValues();
  const pnrs = sheet.getRange(2, MAIN_PNR_COL, numRows, 1).getValues();
  const existingCosts = sheet.getRange(2, MAIN_COST_COL, numRows, 1).getValues();
  const existingFormulas = sheet.getRange(2, MAIN_COST_COL, numRows, 1).getFormulas();

  let protectedCount = 0;
  let wouldOverwriteCount = 0;

  Logger.log("=== diagnoseColumnG_ ===");
  Logger.log("Sheet: " + sheet.getName() + ", scanning rows 2.." + lastRow);
  Logger.log("Filter: Column F = \"" + OPERATOR_NAME_FILTER + "\"");

  for (let i = 0; i < numRows; i++) {
    const operator = String(operators[i][0] || "").trim();
    if (operator !== OPERATOR_NAME_FILTER) continue;

    const rowNum = i + 2;
    const pnr = String(pnrs[i][0] || "").trim();
    const gValue = existingCosts[i][0];
    const gFormula = existingFormulas[i][0];

    // Same expression applyCostFormulas_ uses when forceRewriteG = false.
    const wouldBeProtected = (gValue !== "" || gFormula !== "");

    if (wouldBeProtected) protectedCount++;
    else wouldOverwriteCount++;

    Logger.log(
      "Row " + rowNum +
      " | PNR: " + (pnr || "(empty)") +
      " | G value: " + JSON.stringify(gValue) +
      " | G formula: " + (gFormula === "" ? "(empty)" : gFormula) +
      " | " + (wouldBeProtected ? "PROTECTED" : "WOULD OVERWRITE")
    );
  }

  Logger.log("=== Summary ===");
  Logger.log("Zalman rows protected (G has value or formula): " + protectedCount);
  Logger.log("Zalman rows that would be overwritten (G empty): " + wouldOverwriteCount);
}

// One-time cleanup helper. Walks every Zalman row; for each Column G cell that
// holds a VLOOKUP formula, replaces the formula with the cell's currently
// displayed value. Formula cells that currently evaluate to "" are cleared
// (truly empty). Non-VLOOKUP formulas and already-static values are untouched.
// Safe to re-run; idempotent after one full pass.
function convertFormulasToValuesInG() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("No data rows on active sheet.");
    return;
  }

  const numRows = lastRow - 1;
  const operators = sheet.getRange(2, MAIN_OPERATOR_COL, numRows, 1).getValues();
  const gValues = sheet.getRange(2, MAIN_COST_COL, numRows, 1).getValues();
  const gFormulas = sheet.getRange(2, MAIN_COST_COL, numRows, 1).getFormulas();

  let converted = 0;
  let blanked = 0;

  Logger.log("=== convertFormulasToValuesInG ===");
  Logger.log("Sheet: " + sheet.getName() + ", scanning rows 2.." + lastRow);

  for (let i = 0; i < numRows; i++) {
    const operator = String(operators[i][0] || "").trim();
    if (operator !== OPERATOR_NAME_FILTER) continue;

    const formula = gFormulas[i][0];
    if (formula === "" || !/VLOOKUP/i.test(formula)) continue;

    const rowNum = i + 2;
    const currentValue = gValues[i][0];
    const cell = sheet.getRange(rowNum, MAIN_COST_COL);

    if (currentValue === "" || currentValue === null) {
      cell.clearContent();
      blanked++;
    } else {
      cell.setValue(currentValue);
    }
    converted++;
  }

  Logger.log("Converted: " + converted + " VLOOKUP cell(s) in Column G");
  Logger.log("Of those, blanked (formula evaluated to \"\"): " + blanked);
}
