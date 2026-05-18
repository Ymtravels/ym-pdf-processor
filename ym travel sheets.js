/**
 * YM Travel PDF Processor v23
 * 
 * NEW IN V23:
 * - Fixed AC new format "Issued: Jan 21, 2026" date detection (checked first now)
 * - Added support for arrow route format in Seats section "LGA → YUL"
 * 
 * PREVIOUS FEATURES (v22):
 * - Fixed duplicate detection for merged roundtrips (ABC123/DEF456 now properly detected)
 * - PHL excluded from pricing rules (still included for roundtrip matching)
 * - AA middle initial names now detected (e.g., "CHAIM L HILDESHAIM")
 * - Porter passenger count fix
 * - AA roundtrip detection in single PDF (LIT → LGA → LIT now shows LIT → LGA with roundtrip ✓)
 * - OCR incomplete warning - flags files where OCR failed for manual review
 * - Filename fallback for routes when OCR fails (e.g., "name lga-yul-lga.pdf")
 * - New AC format support: "Booking confirmation CAU4WM" and "Aron Mr Kamman" name format
 * 
 * PREVIOUS FEATURES (v21):
 * - Roundtrip checkbox in Column U
 * - Connecting flight handling - shows only origin and final destination
 * - Fixed AA passenger count - counts UNIQUE names only
 * - Strict pricing - no guessing, leaves blank if not confident
 * 
 * SETUP: Paste into Extensions > Apps Script, save, run from YM Travel menu
 */

// ============ CONFIGURATION ============
const CONFIG = {
  SOURCE_FOLDER_NAME: "YM travel pdf processing",
  PROCESSED_FOLDER_NAME: "Processed",
  OPERATOR_NAME: "Zalman",
  BATCH_LIMIT: 13  // Max PDFs to process per run (to avoid timeout)
};

// Column positions (1-indexed) - Column A is auto-date, so we start from B
const COLUMNS = {
  DATE_AUTO: 1,  // A - don't touch
  LAST: 2,       // B
  FIRST: 3,      // C
  FROM: 4,       // D
  SYSTEM: 5,     // E
  OPERATOR: 6,   // F
  COST: 7,       // G
  CHARGED: 8,    // H
  PAID: 9,       // I
  TO: 10,        // J
  PROFIT: 11,    // K
  PROFIT_PERCENT: 12,    // L
  RETAINED_PERCENT: 13,  // M
  RETAINED_AMOUNT: 14,   // N
  AIRLINE: 15,   // O
  PNR: 16,       // P
  DATE1: 17,     // Q
  DATE2: 18,     // R
  AIRPORT1: 19,  // S
  AIRPORT2: 20,  // T
  ROUNDTRIP: 21, // U - checkbox for roundtrip
  TRAVELERS: 22, // V
  KOSHER: 24     // X
};

// Airline codes mapping
const AIRLINE_CODES = {
  "air canada": "AC",
  "united airlines": "UA",
  "united": "UA",
  "delta air lines": "DL",
  "delta": "DL",
  "american airlines": "AA",
  "american eagle": "AA",
  "southwest": "WN",
  "jetblue": "B6",
  "alaska airlines": "AS",
  "spirit airlines": "NK",
  "frontier airlines": "F9",
  "british airways": "BA",
  "lufthansa": "LH",
  "emirates": "EK",
  "el al": "LY",
  "westjet": "WS",
  "porter": "PT",
  "porter airlines": "PT"
};

// Known airport codes
const KNOWN_AIRPORTS = ["LGA", "JFK", "EWR", "YYZ", "YUL", "YTZ", "MIA", "LAX", "ORD", "DFW", "ATL", "SFO", "BOS", "DCA", "IAD", "CDG", "LHR", "MEX", "PHX", "SEA", "DEN", "LAS", "MCO", "CLT", "MSP", "DTW", "PHL", "FLL", "TPA", "SAN", "IAH", "AUS", "BNA", "PDX", "STL", "MCI", "RDU", "SJC", "OAK", "SMF", "SNA", "CUN", "YVR", "YOW", "YHZ", "YWG", "YEG", "YYC", "CVG", "IND", "CMH", "PIT", "CLE", "BUF", "ROC", "SYR", "ALB", "PWM", "BDL", "PVD", "MHT", "ABQ", "ELP", "SAT", "OKC", "TUL", "MEM", "BHM", "JAX", "RSW", "PBI", "SRQ", "MSY", "HOU", "DAL", "MDW", "SJU", "PSE", "BQN", "STT", "STX", "ILM", "GSO", "RIC", "ORF", "CHS", "SAV", "PNS", "MOB", "SHV", "LIT", "XNA", "SGF", "DSM", "OMA", "ICT", "COS", "GEG", "BOI", "SLC", "TUS", "ONT", "BUR", "LGB", "PSP", "FAT", "SBA", "MRY", "EUG", "MFR", "RNO", "SMX", "ANC", "HNL", "OGG", "KOA", "LIH", "MKE", "GRR", "SBN", "FWA", "EVV", "LEX", "SDF", "DAY", "TOL", "LAN", "FNT", "AZO", "TVC", "MBS", "PLN", "ESC", "CIU", "IMT", "MQT", "RHI", "LSE", "MSN", "ATW", "GRB", "CWA", "EAU", "DLH", "BJI", "RST", "FAR", "BIS", "MOT", "GFK", "SUX", "FSD", "RAP", "PIR", "ABR", "EDI"];

// Airports that need kosher (leave kosher field empty for these)
const KOSHER_AIRPORTS = ["CDG", "LHR"];

// NYC area airports for ROUNDTRIP MATCHING (includes PHL)
const NYC_AIRPORTS = ["LGA", "JFK", "EWR", "PHL"];
// NYC area airports for PRICING (excludes PHL - no set price for PHL)
const NYC_AIRPORTS_PRICED = ["LGA", "JFK", "EWR"];
// Canadian airports
const CANADA_YUL_YYZ = ["YUL", "YYZ"];
const CANADA_YYZ_YTZ = ["YYZ", "YTZ"];
const CANADA_ALL = ["YUL", "YYZ", "YTZ"];

// Pricing rules - for single legs (using NYC_AIRPORTS_PRICED to exclude PHL)
const PRICING_RULES = [
  // Air Canada - NYC to YUL/YYZ
  { airline: "AC", from: NYC_AIRPORTS_PRICED, to: CANADA_YUL_YYZ, economy: 110, business: 135 },
  // Air Canada - YUL/YYZ to NYC
  { airline: "AC", from: CANADA_YUL_YYZ, to: NYC_AIRPORTS_PRICED, economy: 150, business: 180 },
  // Air Canada - YUL to YYZ/YTZ
  { airline: "AC", from: ["YUL"], to: CANADA_YYZ_YTZ, economy: 110, business: 135 },
  // Air Canada - YYZ/YTZ to YUL
  { airline: "AC", from: CANADA_YYZ_YTZ, to: ["YUL"], economy: 110, business: 135 },
  
  // American Airlines - NYC to YUL/YYZ
  { airline: "AA", from: NYC_AIRPORTS_PRICED, to: CANADA_YUL_YYZ, economy: 135, business: 165 },
  // American Airlines - YUL/YYZ to NYC
  { airline: "AA", from: CANADA_YUL_YYZ, to: NYC_AIRPORTS_PRICED, economy: 165, business: 210 },
];

// ============ MAIN FUNCTION ============
function processTravelPDFs() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const ui = SpreadsheetApp.getUi();
  
  const folders = DriveApp.getFoldersByName(CONFIG.SOURCE_FOLDER_NAME);
  if (!folders.hasNext()) {
    ui.alert('Folder not found!\n\nPlease create a folder named "' + CONFIG.SOURCE_FOLDER_NAME + '" in Google Drive.');
    return;
  }
  const sourceFolder = folders.next();
  
  let processedFolder;
  const subFolders = sourceFolder.getFoldersByName(CONFIG.PROCESSED_FOLDER_NAME);
  if (subFolders.hasNext()) {
    processedFolder = subFolders.next();
  } else {
    processedFolder = sourceFolder.createFolder(CONFIG.PROCESSED_FOLDER_NAME);
  }
  
  // Get all existing PNRs from the sheet to check for duplicates
  const existingPNRs = getExistingPNRs(sheet);
  Logger.log("Found " + existingPNRs.size + " existing PNRs in sheet");
  
  const files = sourceFolder.getFilesByType(MimeType.PDF);
  
  // First, collect all files and sort by name
  const allFiles = [];
  while (files.hasNext()) {
    allFiles.push(files.next());
  }
  
  if (allFiles.length === 0) {
    ui.alert('No PDFs found in folder "' + CONFIG.SOURCE_FOLDER_NAME + '"');
    return;
  }
  
  // Sort files by name so roundtrips stay together
  allFiles.sort((a, b) => a.getName().localeCompare(b.getName()));
  
  // Get first BATCH_LIMIT files
  const selectedFiles = allFiles.slice(0, CONFIG.BATCH_LIMIT);
  
  let errorCount = 0;
  let duplicateCount = 0;
  const errors = [];
  const duplicates = [];
  const noPnrFiles = [];
  const noPriceFiles = [];
  const ocrIncompleteFiles = []; // NEW: Track files where OCR appears incomplete
  const newPNRsThisRun = new Set();
  
  // Collect all flight data first, don't add to sheet yet
  const allFlightData = [];
  const fileMap = new Map(); // Map flight data to files for moving later
  
  for (const file of selectedFiles) {
    try {
      const fileName = file.getName();
      const pdfText = extractTextFromPDF(file);
      
      if (!pdfText || pdfText.trim().length === 0) {
        errors.push(fileName + ": Could not extract text from PDF");
        errorCount++;
        continue;
      }
      
      Logger.log("Processing file: " + fileName);
      Logger.log("Extracted text: " + pdfText.substring(0, 1000));
      
      const flightData = parseFlightConfirmation(pdfText, fileName);
      
      if (flightData) {
        // Add source filename to flight data
        flightData.sourceFile = fileName;
        
        // Normalize PNR to uppercase for consistent duplicate checking
        const pnrNormalized = flightData.pnr ? flightData.pnr.toUpperCase() : "";
        
        // Check for duplicate PNR (only if PNR exists)
        if (pnrNormalized && (existingPNRs.has(pnrNormalized) || newPNRsThisRun.has(pnrNormalized))) {
          duplicates.push(flightData.pnr + " (" + fileName + ")");
          duplicateCount++;
          file.moveTo(processedFolder);
          continue;
        }
        
        // Track if no PNR
        if (!flightData.pnr) {
          noPnrFiles.push(fileName);
        }
        
        // Track if no price (strict mode)
        if (!flightData.charged) {
          noPriceFiles.push(fileName);
        }
        
        // Track if OCR was incomplete (needs manual review)
        if (flightData.ocrIncomplete) {
          ocrIncompleteFiles.push(fileName);
        }
        
        // Store flight data and file reference
        allFlightData.push(flightData);
        fileMap.set(flightData, file);
        
        if (pnrNormalized) {
          newPNRsThisRun.add(pnrNormalized);
        }
      } else {
        errors.push(fileName + ": Could not parse flight data");
        errorCount++;
      }
    } catch (e) {
      errors.push(file.getName() + ": " + e.message);
      errorCount++;
    }
  }
  
  // ============ ROUNDTRIP MATCHING ============
  const potentialPairs = findPotentialRoundtripPairs(allFlightData);
  let confirmedPairIndices = new Set();
  
  if (potentialPairs.length > 0) {
    // Build the confirmation message
    let pairMessage = "Found " + potentialPairs.length + " potential roundtrip pair(s):\n\n";
    
    for (let i = 0; i < potentialPairs.length; i++) {
      const pair = potentialPairs[i];
      const flight1 = pair.flight1;
      const flight2 = pair.flight2;
      
      pairMessage += (i + 1) + ". " + flight1.lastName + ", " + flight1.firstName + "\n";
      pairMessage += "   " + flight1.airport1 + "→" + flight1.airport2 + " (" + flight1.date1 + ") [" + flight1.airline + "] Ticketed: " + flight1.ticketingDate + "\n";
      pairMessage += "   " + flight2.airport1 + "→" + flight2.airport2 + " (" + flight2.date1 + ") [" + flight2.airline + "] Ticketed: " + flight2.ticketingDate + "\n\n";
    }
    
    pairMessage += "Enter numbers to confirm as roundtrips (e.g., 1,2) or leave blank to skip:";
    
    const response = ui.prompt("Roundtrip Matching", pairMessage, ui.ButtonSet.OK_CANCEL);
    
    if (response.getSelectedButton() === ui.Button.OK) {
      const input = response.getResponseText().trim();
      if (input !== "") {
        const numbers = input.split(",").map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n >= 1 && n <= potentialPairs.length);
        numbers.forEach(n => confirmedPairIndices.add(n - 1)); // Convert to 0-indexed
      }
    }
  }
  
  // ============ ORGANIZE FLIGHTS FOR INSERTION ============
  const orderedFlights = organizeFlightsForInsertion(allFlightData, potentialPairs, confirmedPairIndices);
  
  // ============ ADD TO SHEET ============
  let processedCount = 0;
  for (const flightData of orderedFlights) {
    addRowToSheet(sheet, flightData);
    // Handle file moving - for merged roundtrips, need to move both files
    if (flightData.isRoundtrip) {
      // Find and move both original files for this merged roundtrip
      for (const [origFlight, file] of fileMap.entries()) {
        if (origFlight.pnr && flightData.pnr.includes(origFlight.pnr)) {
          file.moveTo(processedFolder);
        }
      }
    } else {
      const file = fileMap.get(flightData);
      if (file) {
        file.moveTo(processedFolder);
      }
    }
    processedCount++;
  }
  
  // Calculate remaining files
  const remainingFiles = allFiles.length - selectedFiles.length;
  
  // ============ BUILD SUMMARY MESSAGE ============
  let message = "Processing complete!\n\n";
  message += "✓ Added: " + processedCount + " row(s)\n";
  
  if (confirmedPairIndices.size > 0) {
    message += "✓ Merged: " + confirmedPairIndices.size + " roundtrip(s) into single rows\n";
  }
  
  // OCR INCOMPLETE WARNING - Show first so user notices
  if (ocrIncompleteFiles.length > 0) {
    message += "\n🔴 OCR INCOMPLETE - MANUAL REVIEW NEEDED: " + ocrIncompleteFiles.length + "\n";
    message += "   (Passenger count, cabin class, price may be wrong)\n";
    for (const f of ocrIncompleteFiles) {
      message += "   - " + f + "\n";
    }
  }
  
  if (noPriceFiles.length > 0) {
    message += "⚠ No price (needs manual entry): " + noPriceFiles.length + "\n";
    for (const f of noPriceFiles.slice(0, 5)) {
      message += "   - " + f + "\n";
    }
    if (noPriceFiles.length > 5) {
      message += "   ... and " + (noPriceFiles.length - 5) + " more\n";
    }
  }
  
  if (noPnrFiles.length > 0) {
    message += "⚠ No PNR found (added anyway): " + noPnrFiles.length + "\n";
    for (const f of noPnrFiles) {
      message += "   - " + f + "\n";
    }
  }
  
  if (duplicateCount > 0) {
    message += "⊘ Skipped (duplicate PNR): " + duplicateCount + "\n";
    const showDupes = duplicates.slice(0, 10);
    for (const dupe of showDupes) {
      message += "   - " + dupe + "\n";
    }
    if (duplicates.length > 10) {
      message += "   ... and " + (duplicates.length - 10) + " more\n";
    }
  }
  
  if (errorCount > 0) {
    message += "✗ Errors: " + errorCount + "\n\n";
    message += "Error details:\n";
    const showErrors = errors.slice(0, 5);
    message += showErrors.join("\n");
    if (errors.length > 5) {
      message += "\n... and " + (errors.length - 5) + " more errors";
    }
  }
  
  // Show remaining files message
  if (remainingFiles > 0) {
    message += "\n\n⏳ " + remainingFiles + " PDF(s) remaining in folder.\nRun again to process more.";
  }
  
  ui.alert(message);
}

// ============ FIND POTENTIAL ROUNDTRIP PAIRS ============
function findPotentialRoundtripPairs(flights) {
  const pairs = [];
  const used = new Set();
  
  for (let i = 0; i < flights.length; i++) {
    if (used.has(i)) continue;
    
    const flight1 = flights[i];
    
    // Only match AC and AA (they have ticketing dates)
    if (flight1.airline !== "AC" && flight1.airline !== "AA") continue;
    if (!flight1.ticketingDate) continue;
    
    for (let j = i + 1; j < flights.length; j++) {
      if (used.has(j)) continue;
      
      const flight2 = flights[j];
      
      // Only match AC and AA
      if (flight2.airline !== "AC" && flight2.airline !== "AA") continue;
      if (!flight2.ticketingDate) continue;
      
      // Check if same passenger - flexible matching
      // Names can be stored differently between airlines
      if (!namesMatch(flight1, flight2)) continue;
      
      // Check if ticketing dates are within 2 days of each other
      if (!ticketingDatesClose(flight1.ticketingDate, flight2.ticketingDate)) continue;
      
      // Check if opposite routes (considering area equivalents)
      if (areOppositeRoutes(flight1, flight2)) {
        // Determine which is outbound (earlier date)
        const date1 = parseFlightDate(flight1.date1);
        const date2 = parseFlightDate(flight2.date1);
        
        let outbound, inbound;
        if (date1 && date2 && date1 <= date2) {
          outbound = flight1;
          inbound = flight2;
        } else if (date1 && date2) {
          outbound = flight2;
          inbound = flight1;
        } else {
          // Can't determine, use order found
          outbound = flight1;
          inbound = flight2;
        }
        
        pairs.push({
          flight1: outbound,
          flight2: inbound,
          index1: flights.indexOf(outbound),
          index2: flights.indexOf(inbound)
        });
        
        used.add(i);
        used.add(j);
        break;
      }
    }
  }
  
  return pairs;
}

// ============ CHECK IF NAMES MATCH (flexible) ============
function namesMatch(flight1, flight2) {
  const first1 = flight1.firstName.toLowerCase();
  const first2 = flight2.firstName.toLowerCase();
  const last1 = flight1.lastName.toLowerCase();
  const last2 = flight2.lastName.toLowerCase();
  
  // Check if any part of last name matches (at least 3 chars)
  const lastNameMatch = 
    last1.includes(last2) || 
    last2.includes(last1) ||
    last1.split(" ").some(part => last2.includes(part) && part.length >= 3) ||
    last2.split(" ").some(part => last1.includes(part) && part.length >= 3);
  
  // Check if any part of first name matches (at least 3 chars)
  // This prevents matching different family members like Jeffrey vs Arielle
  const firstNameMatch = 
    first1.includes(first2) || 
    first2.includes(first1) ||
    first1.split(" ").some(part => first2.includes(part) && part.length >= 3) ||
    first2.split(" ").some(part => first1.includes(part) && part.length >= 3);
  
  return lastNameMatch && firstNameMatch;
}

// ============ CHECK IF TICKETING DATES ARE WITHIN 2 DAYS ============
function ticketingDatesClose(date1, date2) {
  // Dates are in format "YYYY-MM-DD"
  if (!date1 || !date2) return false;
  
  // Exact match
  if (date1 === date2) return true;
  
  // Parse dates and check difference
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;
  
  const diffMs = Math.abs(d1.getTime() - d2.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  
  return diffDays <= 2;
}

// ============ CHECK IF OPPOSITE ROUTES ============
function areOppositeRoutes(flight1, flight2) {
  // Get primary airports (handle "LGA/JFK" format)
  const apt1_from = flight1.airport1.split("/")[0].trim();
  const apt1_to = flight1.airport2.split("/")[0].trim();
  const apt2_from = flight2.airport1.split("/")[0].trim();
  const apt2_to = flight2.airport2.split("/")[0].trim();
  
  Logger.log("Checking opposite routes: " + apt1_from + "→" + apt1_to + " vs " + apt2_from + "→" + apt2_to);
  
  // For a roundtrip:
  // - Flight 2 should depart from where Flight 1 arrives (or same area)
  // - Flight 2 should arrive where Flight 1 departed (or same area)
  
  // Check if flight1's destination matches flight2's origin
  const destToOriginMatch = airportsMatch(apt1_to, apt2_from);
  
  // Check if flight1's origin matches flight2's destination
  const originToDestMatch = airportsMatch(apt1_from, apt2_to);
  
  Logger.log("destToOriginMatch: " + destToOriginMatch + ", originToDestMatch: " + originToDestMatch);
  
  return destToOriginMatch && originToDestMatch;
}

// ============ CHECK IF TWO AIRPORTS MATCH (same or same metro area) ============
function airportsMatch(apt1, apt2) {
  // Exact match
  if (apt1 === apt2) return true;
  
  // NYC area - LGA, JFK, EWR are interchangeable
  if (NYC_AIRPORTS.includes(apt1) && NYC_AIRPORTS.includes(apt2)) return true;
  
  // Toronto area - YYZ and YTZ are interchangeable (both Toronto)
  const TORONTO_AIRPORTS = ["YYZ", "YTZ"];
  if (TORONTO_AIRPORTS.includes(apt1) && TORONTO_AIRPORTS.includes(apt2)) return true;
  
  // Note: YUL (Montreal) is NOT interchangeable with Toronto airports
  
  return false;
}

// ============ GET AIRPORT AREA (for display purposes) ============
function getAirportArea(airport) {
  if (NYC_AIRPORTS.includes(airport)) return "NYC";
  if (CANADA_ALL.includes(airport)) return "CANADA";
  return airport; // Return airport itself if not in a known area
}

// ============ PARSE FLIGHT DATE ============
function parseFlightDate(dateStr) {
  if (!dateStr) return null;
  
  const months = {
    "jan": 0, "feb": 1, "mar": 2, "apr": 3, "may": 4, "jun": 5,
    "jul": 6, "aug": 7, "sep": 8, "oct": 9, "nov": 10, "dec": 11
  };
  
  // Try "11 Dec 2025" format
  let match = dateStr.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
  if (match) {
    return new Date(parseInt(match[3]), months[match[2].toLowerCase()], parseInt(match[1]));
  }
  
  // Try "Dec 11, 2025" format
  match = dateStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (match) {
    return new Date(parseInt(match[3]), months[match[1].toLowerCase()], parseInt(match[2]));
  }
  
  return null;
}

// ============ ORGANIZE FLIGHTS FOR INSERTION ============
function organizeFlightsForInsertion(allFlights, pairs, confirmedPairIndices) {
  const ordered = [];
  const usedIndices = new Set();
  
  // First, merge confirmed pairs into single combined records
  for (let i = 0; i < pairs.length; i++) {
    if (confirmedPairIndices.has(i)) {
      const pair = pairs[i];
      const outbound = pair.flight1;
      const inbound = pair.flight2;
      
      // Create merged flight record
      const mergedFlight = mergeRoundtripFlights(outbound, inbound);
      ordered.push(mergedFlight);
      
      usedIndices.add(allFlights.indexOf(outbound));
      usedIndices.add(allFlights.indexOf(inbound));
    }
  }
  
  // Then add remaining flights in original order
  for (let i = 0; i < allFlights.length; i++) {
    if (!usedIndices.has(i)) {
      ordered.push(allFlights[i]);
    }
  }
  
  return ordered;
}

// ============ MERGE ROUNDTRIP FLIGHTS INTO ONE RECORD ============
function mergeRoundtripFlights(outbound, inbound) {
  // Combine PNRs: "ABC123/DEF456"
  const combinedPnr = outbound.pnr + "/" + inbound.pnr;
  
  // Combine source files
  const combinedSourceFile = outbound.sourceFile + " + " + inbound.sourceFile;
  
  // Date1 = outbound date, Date2 = return date
  const date1 = outbound.date1;
  const date2 = inbound.date1;
  
  // Airport1: where the trip starts (and returns to)
  // If outbound departs from different airport than inbound arrives, show both
  let airport1;
  if (outbound.airport1 !== inbound.airport2 && isSameArea(outbound.airport1, inbound.airport2)) {
    airport1 = outbound.airport1 + " / " + inbound.airport2;
  } else {
    airport1 = outbound.airport1;
  }
  
  // Airport2: the destination (where outbound goes to / inbound departs from)
  let airport2;
  if (outbound.airport2 !== inbound.airport1 && isSameArea(outbound.airport2, inbound.airport1)) {
    airport2 = outbound.airport2 + " / " + inbound.airport1;
  } else {
    airport2 = outbound.airport2;
  }
  
  // Calculate combined price - STRICT: only if both have prices
  let combinedPrice = "";
  const outboundPrice = outbound.charged || 0;
  const inboundPrice = inbound.charged || 0;
  
  if (outboundPrice && inboundPrice) {
    combinedPrice = (parseFloat(outboundPrice) || 0) + (parseFloat(inboundPrice) || 0);
  }
  // If either is missing, leave blank for manual entry
  
  // Combine passenger counts (should be same, but take max just in case)
  const passengerCount = Math.max(outbound.passengerCount || 1, inbound.passengerCount || 1);
  
  // Airline: if different, show both
  let airline;
  if (outbound.airline !== inbound.airline) {
    airline = outbound.airline + "/" + inbound.airline;
  } else {
    airline = outbound.airline;
  }
  
  return {
    lastName: outbound.lastName,
    firstName: outbound.firstName,
    airline: airline,
    pnr: combinedPnr,
    date1: date1,
    date2: date2,
    airport1: airport1,
    airport2: airport2,
    charged: combinedPrice,
    ticketingDate: outbound.ticketingDate,
    passengerCount: passengerCount,
    sourceFile: combinedSourceFile,
    isRoundtrip: true  // Flag for reference
  };
}

// ============ GET EXISTING PNRs ============
function getExistingPNRs(sheet) {
  const pnrColumn = sheet.getRange("P:P").getValues();
  const pnrSet = new Set();
  
  for (let i = 2; i < pnrColumn.length; i++) {
    const pnr = pnrColumn[i][0];
    if (pnr && pnr.toString().trim() !== "") {
      const pnrStr = pnr.toString().trim().toUpperCase();
      
      // Handle merged roundtrip PNRs like "ABC123/DEF456"
      if (pnrStr.includes("/")) {
        const parts = pnrStr.split("/");
        for (const part of parts) {
          if (part.trim()) {
            pnrSet.add(part.trim());
          }
        }
      } else {
        pnrSet.add(pnrStr);
      }
    }
  }
  
  return pnrSet;
}

// ============ PDF TEXT EXTRACTION ============
function extractTextFromPDF(file) {
  const blob = file.getBlob();
  
  const tempDoc = Drive.Files.create(
    {
      name: "temp_" + file.getName(),
      mimeType: MimeType.GOOGLE_DOCS
    },
    blob,
    {
      ocr: true,
      ocrLanguage: 'en'
    }
  );
  
  const doc = DocumentApp.openById(tempDoc.id);
  const text = doc.getBody().getText();
  
  Drive.Files.remove(tempDoc.id);
  
  return text;
}

// ============ FLIGHT DATA PARSING ============
function parseFlightConfirmation(text, fileName) {
  fileName = fileName || "";
  
  const data = {
    lastName: "",
    firstName: "",
    airline: "",
    pnr: "",
    date1: "",
    date2: "",
    airport1: "",
    airport2: "",
    charged: "",
    ticketingDate: "",  // for roundtrip matching
    passengerCount: 1,  // default to 1
    sourceFile: "",     // will be set by caller
    isRoundtrip: false, // track if roundtrip detected in single PDF
    ocrIncomplete: false // NEW: flag if OCR appears incomplete
  };
  
  // Detect airline first
  data.airline = detectAirline(text);
  
  // Extract PNR/Confirmation Code
  data.pnr = extractPNR(text, data.airline);
  
  // Extract passenger name and count based on airline format
  const nameInfo = extractPassengerName(text, data.airline);
  data.firstName = nameInfo.firstName;
  data.lastName = nameInfo.lastName;
  data.passengerCount = nameInfo.passengerCount || 1;
  
  // Extract ticketing date (for AC and AA)
  data.ticketingDate = extractTicketingDate(text, data.airline);
  
  // Extract flight details (includes roundtrip detection and pricing)
  const flightInfo = extractFlightDetails(text, data.airline);
  data.airport1 = flightInfo.airport1;
  data.airport2 = flightInfo.airport2;
  data.date1 = flightInfo.date1;
  data.date2 = flightInfo.date2;
  data.isRoundtrip = flightInfo.isRoundtrip || false;  // Roundtrip detected in single PDF
  
  // FALLBACK: If airports are same (like LGA-LGA) or missing, try to extract from filename
  // This indicates OCR is incomplete - flag it for manual review
  if (!data.airport1 || !data.airport2 || data.airport1 === data.airport2) {
    const fileNameUpper = fileName.toUpperCase();
    // Look for pattern like "LGA-YUL-LGA" or "YYZ-JFK" in filename
    const routeMatch = fileNameUpper.match(/([A-Z]{3})-([A-Z]{3})(?:-([A-Z]{3}))?/);
    if (routeMatch) {
      const apt1 = routeMatch[1];
      const apt2 = routeMatch[2];
      const apt3 = routeMatch[3];
      
      if (KNOWN_AIRPORTS.includes(apt1) && KNOWN_AIRPORTS.includes(apt2)) {
        data.airport1 = apt1;
        data.airport2 = apt2;
        data.ocrIncomplete = true; // Flag that we had to use filename
        
        // If there's a third airport and it matches the first, it's a roundtrip
        if (apt3 && apt3 === apt1) {
          data.isRoundtrip = true;
          Logger.log("⚠️ OCR incomplete - Roundtrip detected from filename: " + apt1 + " → " + apt2 + " → " + apt3);
        } else {
          Logger.log("⚠️ OCR incomplete - Route extracted from filename: " + apt1 + " → " + apt2);
        }
      }
    }
    
    // Even if we couldn't get route from filename, flag as incomplete if airports were bad
    if (data.airport1 === data.airport2 || !data.airport1 || !data.airport2) {
      data.ocrIncomplete = true;
    }
  }
  
  // STRICT PRICING: Only apply price if we have confident cabin detection AND OCR is complete
  if (flightInfo.totalPrice && flightInfo.cabinConfident && !data.ocrIncomplete) {
    if (data.passengerCount > 1) {
      data.charged = flightInfo.totalPrice * data.passengerCount;
    } else {
      data.charged = flightInfo.totalPrice;
    }
    Logger.log("Price from rules: " + data.charged);
  } else {
    // Leave blank for manual entry
    data.charged = "";
    if (data.ocrIncomplete) {
      Logger.log("No price - OCR incomplete, needs manual review");
    } else {
      Logger.log("No price found - manual entry needed");
    }
  }
  
  Logger.log("Parsed data: " + JSON.stringify(data));
  
  // Validate minimum required data - now allows missing PNR
  if (!data.lastName && !data.airport1) {
    return null;
  }
  
  return data;
}

// ============ EXTRACT TICKETING DATE ============
function extractTicketingDate(text, airline) {
  // Air Canada formats
  if (airline === "AC") {
    // NEW FORMAT FIRST: "Issued: Jan 21, 2026" (at top of new AC PDFs)
    const acNewPattern = /Issued:\s*([A-Za-z]{3}\s+\d{1,2},?\s+\d{4})/i;
    const acNewMatch = text.match(acNewPattern);
    if (acNewMatch) {
      Logger.log("AC new ticketing date found: " + acNewMatch[1]);
      return normalizeDate(acNewMatch[1]);
    }
    
    // OLD FORMAT: "Travel booked/ticket issued on: 7 Dec, 2025"
    const acOldPattern = /(?:Travel booked\/ticket issued on|ticket issued on|issued on)[:\s]*(\d{1,2}\s+[A-Za-z]+,?\s+\d{4})/i;
    const acOldMatch = text.match(acOldPattern);
    if (acOldMatch) {
      Logger.log("AC old ticketing date found: " + acOldMatch[1]);
      return normalizeDate(acOldMatch[1]);
    }
  }
  
  // American Airlines format: "Status: Ticketed - Dec 15, 2025"
  if (airline === "AA") {
    const aaPattern = /Status[:\s]*Ticketed\s*[-–]\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i;
    const aaMatch = text.match(aaPattern);
    if (aaMatch) {
      return normalizeDate(aaMatch[1]);
    }
  }

  // United Airlines (Format B): "Date of purchase: Thu, May 07, 2026"
  // Format A has no explicit ticketing date — falls through to return "".
  if (airline === "UA") {
    const uaPattern = /Date of purchase:\s*(?:[A-Za-z]{3},\s*)?([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i;
    const uaMatch = text.match(uaPattern);
    if (uaMatch) {
      return normalizeDate(uaMatch[1]);
    }
  }

  return "";
}

// ============ NORMALIZE DATE FORMAT ============
function normalizeDate(dateStr) {
  // Convert various formats to "YYYY-MM-DD" for consistent comparison
  const months = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",
    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12"
  };
  
  // Try "7 Dec, 2025" format (day first)
  let match = dateStr.match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = months[match[2].toLowerCase().substring(0, 3)];
    const year = match[3];
    if (month) {
      return year + "-" + month + "-" + day;
    }
  }
  
  // Try "Dec 15, 2025" format (month first)
  match = dateStr.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (match) {
    const month = months[match[1].toLowerCase().substring(0, 3)];
    const day = match[2].padStart(2, '0');
    const year = match[3];
    if (month) {
      return year + "-" + month + "-" + day;
    }
  }
  
  return dateStr; // Return as-is if can't parse
}

function detectAirline(text) {
  const textLower = text.toLowerCase();
  
  // Check for Porter first (before Alaska, since Porter PDFs mention Alaska as partner)
  if (textLower.includes("porter") || text.includes("P O R T E R")) {
    return "PT";
  }
  
  for (const [pattern, code] of Object.entries(AIRLINE_CODES)) {
    if (textLower.includes(pattern)) {
      return code;
    }
  }
  
  return "XX";
}

function extractPNR(text, airline) {
  // Handle Porter's spaced-out format first
  const porterSpacedPattern = /P\s*O\s*R\s*T\s*E\s*R\s+C\s*O\s*N\s*F\s*I\s*R\s*M\s*A\s*T\s*I\s*O\s*N\s*N\s*O\s*[.\s]*([A-Z0-9]{5,6})/i;
  const porterSpacedMatch = text.match(porterSpacedPattern);
  if (porterSpacedMatch) {
    return porterSpacedMatch[1].toUpperCase();
  }
  
  const patterns = [
    /AA Record Locator[:\s]*([A-Z0-9]{5,6})/i,
    /Confirmation number:\s*([A-Z0-9]{6})/i,                  // United Format A (lowercase "number")
    /Confirmation Number:\s*\n?\s*([A-Z0-9]{6})/i,            // United Format B (code may wrap to next line)
    /Record Locator[:\s]*([A-Z0-9]{5,6})/i,
    /Booking [Rr]eference[:\s]*([A-Z0-9]{5,6})/i,
    /Booking confirmation\s*([A-Z0-9]{5,6})/i,  // New AC format
    /Confirmation [Cc]ode[:\s]*([A-Z0-9]{5,6})/i,
    /Confirmation[:\s#]*([A-Z0-9]{5,6})/i,
    /PORTER CONFIRMATION NO[.\s]*([A-Z0-9]{5,6})/i,
    /Confirmation No[.\s]*([A-Z0-9]{5,6})/i,
    /PNR[:\s]*([A-Z0-9]{5,6})/i,
    /Reservation [Cc]ode[:\s]*([A-Z0-9]{5,6})/i,
    /Locator[:\s]*([A-Z0-9]{5,6})/i,
    /\b([A-Z]{3}[A-Z0-9]{3})\b.*Issued:/i  // Fallback: 6-char code before "Issued:"
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].toUpperCase();
    }
  }
  
  return "";
}

function stripTitles(name) {
  if (!name) return name;
  return name.replace(/\b(?:Mr|Mrs|Ms|Miss|Dr)\b/gi, "").replace(/\s+/g, " ").trim();
}

function extractPassengerName(text, airline) {
  let firstName = "";
  let lastName = "";
  let passengerCount = 1;
  
  // For American Airlines - find ALL CAPS names after "Traveler Information"
  if (airline === "AA") {
    // Header words to skip
    const headerWords = ["PASSENGER", "CLASS", "SEAT", "ASSIGNMENT", "TRAVELER", "INFORMATION", 
                         "ECONOMY", "BUSINESS", "FIRST", "AMERICAN", "AIRLINES", "OPERATED", 
                         "REPUBLIC", "AIRWAYS", "EAGLE", "CARRIER", "FLIGHT", "NUMBER", 
                         "DEPARTING", "ARRIVING", "BOOKING", "CODE", "MEALS", "CITY", "DATE", 
                         "TIME", "YOUR", "ITINERARY", "STATUS", "TICKETED", "REFRESHMENTS"];
    
    // Find section after "Traveler Information"
    let searchText = text;
    const travelerIdx = text.indexOf("Traveler Information");
    if (travelerIdx > -1) {
      searchText = text.substring(travelerIdx);
    }
    
    // Look for ALL CAPS names - handles middle initials (1 letter) and middle names
    // Pattern matches: FIRSTNAME + optional middle parts + LASTNAME (all caps, allows single letters)
    const namePattern = /\b([A-Z]{2,}(?:\s+[A-Z]{1,})*\s+[A-Z]{2,})\b/g;
    const foundNames = [];
    const uniqueNames = new Set(); // Track unique names to avoid duplicates
    let match;
    
    while ((match = namePattern.exec(searchText)) !== null) {
      const fullMatch = match[1];
      const words = fullMatch.split(/\s+/).filter(w => w);
      
      // Need at least 2 words for a valid name
      if (words.length < 2) continue;
      
      // Skip if any word is a header word
      const isHeader = words.some(w => headerWords.includes(w));
      if (isHeader) continue;
      
      // Skip if any word is a known airport code (prevents "LGA PM" being detected as name)
      const hasAirportCode = words.some(w => KNOWN_AIRPORTS.includes(w));
      if (hasAirportCode) continue;
      
      // Skip if any word is AM/PM (from flight times)
      const hasTimeIndicator = words.some(w => w === "AM" || w === "PM");
      if (hasTimeIndicator) continue;
      
      // Skip if looks like airport codes (exactly 3 letters each, only 2 words)
      if (words.length === 2 && words[0].length === 3 && words[1].length === 3) continue;
      
      // Skip N/A
      if (words.includes("N") || words.join(" ").includes("N/A")) continue;
      
      // Create a unique key for this name to detect duplicates
      const nameKey = words.join(" ").toUpperCase();
      
      // Only add if we haven't seen this exact name before
      if (!uniqueNames.has(nameKey)) {
        uniqueNames.add(nameKey);
        foundNames.push(words);
      }
    }
    
    if (foundNames.length > 0) {
      // First name found is the primary passenger
      const nameParts = foundNames[0];
      if (nameParts.length >= 2) {
        // Last word is last name, rest is first name
        lastName = capitalizeWords(nameParts[nameParts.length - 1]);
        firstName = capitalizeWords(nameParts.slice(0, -1).join(" "));
      }
      passengerCount = foundNames.length; // Now counts UNIQUE names only
    }
    
    // Fallback: try the email subject line pattern "Rachel Esther Azulay 12/23/2025 trip details"
    if (!firstName || !lastName) {
      const subjectPattern = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+\d{1,2}\/\d{1,2}\/\d{4}\s+trip details/im;
      const subjectMatch = text.match(subjectPattern);
      if (subjectMatch) {
        const nameParts = subjectMatch[1].split(/\s+/);
        if (nameParts.length >= 2) {
          lastName = nameParts[nameParts.length - 1];
          firstName = nameParts.slice(0, -1).join(" ");
        }
      }
    }
    
    if (firstName && lastName) {
      return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
    }
  }

  // For United Airlines - handle both formats
  if (airline === "UA") {
    // FORMAT A: "Traveler 1 FIRST LAST" (ALL-CAPS name follows the "Traveler 1" label)
    const uaFormatAPattern = /Traveler\s+1\s+([A-Z][A-Z]+(?:\s+[A-Z][A-Z]+)*)/;
    const uaFormatAMatch = text.match(uaFormatAPattern);
    if (uaFormatAMatch) {
      const nameParts = uaFormatAMatch[1].split(/\s+/);
      if (nameParts.length >= 2) {
        lastName = capitalizeWords(nameParts[nameParts.length - 1]);
        firstName = capitalizeWords(nameParts.slice(0, -1).join(" "));
      }
      const travelerMatches = text.match(/\bTraveler\s+\d+\b/g);
      if (travelerMatches) {
        passengerCount = travelerMatches.length;
      }
      return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
    }

    // FORMAT B: "Traveler Details" header, then LASTNAME/FIRSTNAME on a following line
    const uaFormatBPattern = /Traveler Details\s*\n+([A-Z]+)\/([A-Z]+)/;
    const uaFormatBMatch = text.match(uaFormatBPattern);
    if (uaFormatBMatch) {
      lastName = capitalizeWords(uaFormatBMatch[1]);
      firstName = capitalizeWords(uaFormatBMatch[2]);
      const detailsIdx = text.indexOf("Traveler Details");
      if (detailsIdx > -1) {
        const detailsSection = text.substring(detailsIdx);
        const slashLines = detailsSection.match(/^[A-Z]+\/[A-Z]+$/gm);
        if (slashLines) {
          passengerCount = slashLines.length;
        }
      }
      return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
    }

    // Neither format matched — return empty rather than falling through to AC/Porter logic.
    return { firstName: "", lastName: "", passengerCount: 1 };
  }

  // For Air Canada - handle multiple formats
  if (airline === "AC") {
    // Count passengers by counting title occurrences in Passengers section
    const passengersIdx = text.indexOf("Passengers");
    if (passengersIdx > -1) {
      const passengersSection = text.substring(passengersIdx, passengersIdx + 500);
      const titleMatches = passengersSection.match(/\b(MR|MS|MRS|MISS|DR)\s+[A-Za-z]/gi);
      if (titleMatches) {
        passengerCount = titleMatches.length;
      }
      
      // NEW AC FORMAT: "Avraham Shlomo Mr Borbely" (FirstName MiddleName Title LastName) - title before last name
      // Exclude "Passengers" header word from matching
      const newFormatPattern = /(?<!Passengers\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:Mr|Ms|Mrs|Miss|Dr)\s+([A-Z][a-z]+)/g;
      const newFormatMatches = passengersSection.match(newFormatPattern);
      if (newFormatMatches && newFormatMatches.length > 0) {
        passengerCount = newFormatMatches.length;
        // Extract first passenger name - skip "Passengers" if it appears
        const firstMatch = passengersSection.match(/(?:^|[\n\r]+)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:Mr|Ms|Mrs|Miss|Dr)\s+([A-Z][a-z]+)/);
        if (firstMatch) {
          // Make sure we didn't capture "Passengers" as part of the name
          let firstNameRaw = firstMatch[1];
          if (firstNameRaw.toLowerCase().startsWith("passengers")) {
            firstNameRaw = firstNameRaw.substring(10).trim();
          }
          firstName = capitalizeWords(firstNameRaw);
          lastName = capitalizeWords(firstMatch[2]);
          Logger.log("AC new format detected: " + firstName + " " + lastName + ", count: " + passengerCount);
          return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
        }
      }
    }
    
    // OLD AC FORMAT: Get first passenger name - match until we hit Ticket# or Seats or end of name
    // Pattern: MR/MS + FirstName + optional MiddleName(s) + LastName (stopping before Ticket/Seats)
    const acPattern = /(?:MS|MR|MRS|MISS|DR)\s+([A-Za-z]+(?:\s+[A-Za-z]+)*?)(?:\s+(?:Ticket|Seats|$))/i;
    const acMatch = text.match(acPattern);
    if (acMatch) {
      const fullName = acMatch[1].trim();
      const nameParts = fullName.split(/\s+/);
      if (nameParts.length >= 2) {
        lastName = capitalizeWords(nameParts[nameParts.length - 1]);
        firstName = capitalizeWords(nameParts.slice(0, -1).join(" "));
        return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
      } else if (nameParts.length === 1) {
        lastName = capitalizeWords(nameParts[0]);
        return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
      }
    }
    
    // Fallback: Try simpler pattern that stops at common delimiters
    const acPattern2 = /(?:MS|MR|MRS|MISS|DR)\s+([A-Za-z]+)\s+([A-Za-z]+)\s+([A-Za-z]+)(?:\s|$)/i;
    const acMatch2 = text.match(acPattern2);
    if (acMatch2 && acMatch2[3].toLowerCase() !== "ticket" && acMatch2[3].toLowerCase() !== "seats") {
      firstName = capitalizeWords(acMatch2[1] + " " + acMatch2[2]);
      lastName = capitalizeWords(acMatch2[3]);
      return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
    }
    
    // Even simpler fallback: just first and last name
    const acPattern3 = /(?:MS|MR|MRS|MISS|DR)\s+([A-Za-z]+)\s+([A-Za-z]+)(?:\s|$)/i;
    const acMatch3 = text.match(acPattern3);
    if (acMatch3 && acMatch3[2].toLowerCase() !== "ticket" && acMatch3[2].toLowerCase() !== "seats") {
      firstName = capitalizeWords(acMatch3[1]);
      lastName = capitalizeWords(acMatch3[2]);
      return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
    }
  }
  
  // For Porter - handle OCR issues and count passengers
  if (airline === "PT") {
    // Count passengers by looking for NAME + SEATS pattern
    // Pattern: "FIRSTNAME LASTNAME S E A T S" or similar OCR variations
    const porterPassengerPattern = /([A-Z]{2,}(?:\s+[A-Z]{2,})+)\s*S\s*E\s*A\s*T\s*S?/gi;
    const porterMatches = text.match(porterPassengerPattern);
    if (porterMatches) {
      passengerCount = porterMatches.length;
      Logger.log("Porter passenger count from SEATS pattern: " + passengerCount);
    }
    
    // Get first passenger name
    const porterPattern1 = /([A-Z]{4,})\s+([A-Z]{4,})S\s*E\s*A/i;
    const porterMatch1 = text.match(porterPattern1);
    if (porterMatch1) {
      firstName = capitalizeWords(porterMatch1[1]);
      lastName = capitalizeWords(porterMatch1[2]);
      return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
    }
    
    const porterPattern2 = /([A-Z]{3,})\s+([A-Z]{3,})\s*(?:SEATS|S\s*E\s*A\s*T|EWR|YTZ|YYZ|LGA|JFK)/i;
    const porterMatch2 = text.match(porterPattern2);
    if (porterMatch2) {
      firstName = capitalizeWords(porterMatch2[1]);
      lastName = capitalizeWords(porterMatch2[2]);
      return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
    }
    
    const porterPattern3 = /Passengers?\s+([A-Z][A-Z]+)\s+([A-Z][A-Z]+)/i;
    const porterMatch3 = text.match(porterPattern3);
    if (porterMatch3) {
      firstName = capitalizeWords(porterMatch3[1]);
      lastName = capitalizeWords(porterMatch3[2]);
      return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
    }
  }
  
  // For Air Canada fallback - MS/MR FirstName MiddleName LastName (old format)
  const acPattern = /(?:MS|MR|MRS|MISS|DR)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+([A-Za-z]+)/i;
  const acMatch = text.match(acPattern);
  if (acMatch) {
    firstName = capitalizeWords(acMatch[1]);
    lastName = capitalizeWords(acMatch[2]);
    return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
  }
  
  // LASTNAME/FIRSTNAME format
  const slashPattern = /([A-Z]+)\/([A-Z]+(?:\s+[A-Z]+)?)\s+(?:MR|MS|MRS)/i;
  const slashMatch = text.match(slashPattern);
  if (slashMatch) {
    lastName = capitalizeWords(slashMatch[1]);
    firstName = capitalizeWords(slashMatch[2]);
    return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
  }
  
  return { firstName: stripTitles(firstName), lastName: stripTitles(lastName), passengerCount };
}

function extractFlightDetails(text, airline) {
  let airport1 = "";
  let airport2 = "";
  let date1 = "";
  let date2 = "";
  let totalPrice = "";
  let cabinConfident = false;  // Track if we're confident about cabin class
  let isRoundtrip = false;     // NEW: Track if roundtrip detected in single PDF
  
  // Find all flight legs in order
  const legs = extractFlightLegs(text, airline);
  Logger.log("Found flight legs: " + JSON.stringify(legs));
  
  if (legs.length === 0) {
    // Fallback to simple airport detection
    const simpleAirports = findAirportsSimple(text);
    if (simpleAirports.length >= 2) {
      airport1 = simpleAirports[0];
      airport2 = simpleAirports[1];
    }
    
    // Get first date found
    const dates = extractDates(text);
    if (dates.length > 0) {
      date1 = dates[0];
    }
    
    // Not confident about cabin, so no price
    return { airport1, airport2, date1, date2, totalPrice: "", cabinConfident: false, isRoundtrip: false };
  }
  
  // Single leg (one-way)
  if (legs.length === 1) {
    airport1 = legs[0].from;
    airport2 = legs[0].to;
    date1 = legs[0].date || "";
    cabinConfident = legs[0].cabinConfident || false;
    
    if (cabinConfident) {
      totalPrice = calculateLegPrice(airline, legs[0].from, legs[0].to, legs[0].cabin);
    }
    
    return { airport1, airport2, date1, date2, totalPrice, cabinConfident, isRoundtrip: false };
  }
  
  // Multiple legs - check if roundtrip within same PDF
  if (legs.length >= 2) {
    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];
    
    // Check if it's a roundtrip (last leg returns to origin area)
    isRoundtrip = isReturnFlight(firstLeg.from, lastLeg.to);
    
    if (isRoundtrip) {
      const outboundFrom = firstLeg.from;
      const outboundTo = firstLeg.to;
      const returnFrom = lastLeg.from;
      const returnTo = lastLeg.to;
      
      if (outboundFrom !== returnTo && isSameArea(outboundFrom, returnTo)) {
        airport1 = outboundFrom + " / " + returnTo;
      } else {
        airport1 = outboundFrom;
      }
      
      if (outboundTo !== returnFrom && isSameArea(outboundTo, returnFrom)) {
        airport2 = outboundTo + " / " + returnFrom;
      } else {
        airport2 = outboundTo;
      }
      
      date1 = firstLeg.date || "";
      date2 = lastLeg.date || "";  // NEW: Also capture return date
      
      // Only calculate price if BOTH legs have confident cabin detection
      const bothLegsConfident = firstLeg.cabinConfident && lastLeg.cabinConfident;
      
      if (bothLegsConfident) {
        const outboundPrice = calculateLegPrice(airline, firstLeg.from, firstLeg.to, firstLeg.cabin);
        const returnPrice = calculateLegPrice(airline, lastLeg.from, lastLeg.to, lastLeg.cabin);
        
        if (outboundPrice && returnPrice) {
          totalPrice = outboundPrice + returnPrice;
          cabinConfident = true;
        }
      }
      
      Logger.log("Roundtrip detected in single PDF: " + airport1 + " → " + airport2 + ", leg1=" + firstLeg.cabin + ", leg2=" + lastLeg.cabin + ", totalPrice=" + totalPrice);
    } else {
      airport1 = firstLeg.from;
      airport2 = firstLeg.to;
      date1 = firstLeg.date || "";
      cabinConfident = firstLeg.cabinConfident || false;
      
      if (cabinConfident) {
        totalPrice = calculateLegPrice(airline, firstLeg.from, firstLeg.to, firstLeg.cabin);
      }
    }
  }
  
  return { airport1, airport2, date1, date2, totalPrice, cabinConfident, isRoundtrip };
}

function extractFlightLegs(text, airline) {
  const legs = [];

  // For UA, use dedicated extractor that handles both UA formats
  if (airline === "UA") {
    const uaLegs = extractUAItinerary(text);
    if (uaLegs.length > 0) {
      return uaLegs;
    }
  }

  // For AA, extract the full itinerary to find true origin and final destination
  if (airline === "AA") {
    const aaLegs = extractAAItinerary(text);
    if (aaLegs.length > 0) {
      return aaLegs;
    }
  }
  
  // For Air Canada, check Seats section first for roundtrip detection
  if (airline === "AC") {
    const seatsSection = text.match(/Seats[\s\S]*?(?=Purchase|$)/i);
    if (seatsSection) {
      // Match both old format "LGA-YUL" and new format "LGA → YUL" or "LGA YUL"
      const seatRoutes = seatsSection[0].match(/([A-Z]{3})\s*[-→]\s*([A-Z]{3})/g);
      if (seatRoutes && seatRoutes.length >= 1) {
        const routePairs = [];
        for (const route of seatRoutes) {
          // Split on dash, arrow, or spaces
          const parts = route.split(/[-→]/).map(p => p.trim());
          if (parts.length === 2 && KNOWN_AIRPORTS.includes(parts[0]) && KNOWN_AIRPORTS.includes(parts[1])) {
            routePairs.push({ from: parts[0], to: parts[1] });
          }
        }
        
        if (routePairs.length >= 2) {
          // Multiple routes found - likely a roundtrip
          const dates = extractDates(text);
          
          // Find all cabin classes in order (for each leg)
          const cabinMatches = [];
          const cabinPattern = /Cabin\s*:\s*(Economy|Business)\s*Class/gi;
          let cabinMatch;
          while ((cabinMatch = cabinPattern.exec(text)) !== null) {
            cabinMatches.push(cabinMatch[1].toLowerCase());
          }
          
          // Determine cabin for each leg
          const leg1Cabin = cabinMatches.length >= 1 ? (cabinMatches[0].includes("business") ? "business" : "economy") : "economy";
          const leg2Cabin = cabinMatches.length >= 2 ? (cabinMatches[1].includes("business") ? "business" : "economy") : "economy";
          const leg1Confident = cabinMatches.length >= 1;
          const leg2Confident = cabinMatches.length >= 2;
          
          legs.push({ 
            from: routePairs[0].from, 
            to: routePairs[0].to, 
            cabin: leg1Cabin, 
            cabinConfident: leg1Confident, 
            date: dates[0] || "" 
          });
          
          legs.push({ 
            from: routePairs[1].from, 
            to: routePairs[1].to, 
            cabin: leg2Cabin,
            cabinConfident: leg2Confident, 
            date: dates[1] || "" 
          });
          
          Logger.log("AC roundtrip detected from Seats section: " + JSON.stringify(legs));
          return legs;
        } else if (routePairs.length === 1) {
          // Single route found
          const dates = extractDates(text);
          const cabinInfo = detectCabinClass(text, airline);
          
          legs.push({
            from: routePairs[0].from,
            to: routePairs[0].to,
            cabin: cabinInfo.cabin,
            cabinConfident: cabinInfo.confident,
            date: dates[0] || ""
          });
          
          Logger.log("AC single leg from Seats section: " + JSON.stringify(legs));
          return legs;
        }
      }
      
      // Also try space-separated format "LGA YUL" (OCR sometimes drops the arrow)
      const spaceRoutes = seatsSection[0].match(/\b([A-Z]{3})\s+([A-Z]{3})\b/g);
      if (spaceRoutes && spaceRoutes.length >= 1) {
        const routePairs = [];
        for (const route of spaceRoutes) {
          const parts = route.split(/\s+/).map(p => p.trim());
          if (parts.length === 2 && KNOWN_AIRPORTS.includes(parts[0]) && KNOWN_AIRPORTS.includes(parts[1])) {
            routePairs.push({ from: parts[0], to: parts[1] });
          }
        }
        
        if (routePairs.length >= 1) {
          const dates = extractDates(text);
          const cabinInfo = detectCabinClass(text, airline);
          
          for (let i = 0; i < routePairs.length; i++) {
            legs.push({
              from: routePairs[i].from,
              to: routePairs[i].to,
              cabin: cabinInfo.cabin,
              cabinConfident: i === 0 ? cabinInfo.confident : false,
              date: dates[i] || ""
            });
          }
          
          Logger.log("AC legs from space-separated Seats section: " + JSON.stringify(legs));
          return legs;
        }
      }
    }
  }
  
  // Pattern 1: Air Canada format - look for explicit cabin indicator
  const acPattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+([A-Z]{3})\s+[\d:]+\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+([A-Z]{3})\s+[\d:]+[^C]*Cabin\s*:\s*(\w+)/gi;
  let match;
  while ((match = acPattern.exec(text)) !== null) {
    const from = match[2];
    const to = match[4];
    const cabinRaw = match[5].toLowerCase();
    const cabin = cabinRaw.includes("business") ? "business" : "economy";
    const cabinConfident = true;  // Explicit "Cabin:" found
    
    if (KNOWN_AIRPORTS.includes(from) && KNOWN_AIRPORTS.includes(to)) {
      legs.push({ from, to, cabin, cabinConfident, date: "" });
    }
  }
  
  // Pattern 2: Route patterns like "YUL-LGA" - NO cabin confidence without explicit class
  const routePattern = /([A-Z]{3})\s*[-–—]\s*([A-Z]{3})/g;
  while ((match = routePattern.exec(text)) !== null) {
    const from = match[1];
    const to = match[2];
    
    if (KNOWN_AIRPORTS.includes(from) && KNOWN_AIRPORTS.includes(to)) {
      const exists = legs.some(l => l.from === from && l.to === to);
      if (!exists) {
        // Check for explicit cabin class near this route
        const context = text.substring(Math.max(0, match.index - 200), Math.min(text.length, match.index + 200));
        const cabinInfo = detectCabinClass(context, airline);
        legs.push({ from, to, cabin: cabinInfo.cabin, cabinConfident: cabinInfo.confident, date: "" });
      }
    }
  }
  
  // Pattern 3: Porter format "EWR → YTZ"
  const porterPattern = /([A-Z]{3})\s*[→+>]\s*([A-Z]{3})/g;
  while ((match = porterPattern.exec(text)) !== null) {
    const from = match[1];
    const to = match[2];
    
    if (KNOWN_AIRPORTS.includes(from) && KNOWN_AIRPORTS.includes(to)) {
      const exists = legs.some(l => l.from === from && l.to === to);
      if (!exists) {
        // Porter doesn't have business class on most routes
        legs.push({ from, to, cabin: "economy", cabinConfident: false, date: "" });
      }
    }
  }
  
  // Try to extract dates for each leg
  const dates = extractDates(text);
  for (let i = 0; i < legs.length && i < dates.length; i++) {
    legs[i].date = dates[i];
  }
  
  // If no legs found, try simpler detection
  if (legs.length === 0) {
    const airports = findAirportsSimple(text);
    
    // Check for explicit cabin class in full text
    const cabinInfo = detectCabinClass(text, airline);
    
    if (airports.length >= 2) {
      // For connecting flights, use first and last airport only
      const origin = airports[0];
      const destination = airports[airports.length - 1];
      
      // Only add if origin and destination are different
      if (origin !== destination) {
        legs.push({ from: origin, to: destination, cabin: cabinInfo.cabin, cabinConfident: cabinInfo.confident, date: dates[0] || "" });
      }
    }
  }
  
  // If we have multiple legs that form a connection, consolidate to origin and final destination
  if (legs.length >= 2) {
    const consolidatedLegs = consolidateConnectingFlights(legs);
    return consolidatedLegs;
  }
  
  return legs;
}

// ============ EXTRACT AA ITINERARY (handles connecting flights) ============
function extractAAItinerary(text) {
  const legs = [];
  
  // Look for "Your Itinerary" section and extract airports in order
  const itineraryIdx = text.indexOf("Your Itinerary");
  if (itineraryIdx === -1) return legs;
  
  const itinerarySection = text.substring(itineraryIdx, itineraryIdx + 2000);
  
  // Find all airport codes in the itinerary section in order of appearance
  const airportMatches = [];
  for (const apt of KNOWN_AIRPORTS) {
    const regex = new RegExp("\\b" + apt + "\\b", "g");
    let match;
    while ((match = regex.exec(itinerarySection)) !== null) {
      airportMatches.push({ code: apt, index: match.index });
    }
  }
  
  // Sort by position in text
  airportMatches.sort((a, b) => a.index - b.index);
  
  if (airportMatches.length < 2) return legs;
  
  // Get unique airports in order (remove consecutive duplicates)
  const orderedAirports = [];
  for (const apt of airportMatches) {
    if (orderedAirports.length === 0 || orderedAirports[orderedAirports.length - 1] !== apt.code) {
      orderedAirports.push(apt.code);
    }
  }
  
  Logger.log("AA Itinerary airports in order: " + JSON.stringify(orderedAirports));
  
  if (orderedAirports.length < 2) return legs;
  
  // Detect cabin class - for AA with mixed classes, we can't be confident
  const cabinInfo = detectCabinClass(text, "AA");
  
  // Check if there are mixed cabin classes (First and Economy both mentioned)
  const hasFirst = /\bFirst\b/i.test(text);
  const hasEconomy = /\bEconomy\b/i.test(text);
  const hasBusiness = /\bBusiness\b/i.test(text);
  const mixedCabin = (hasFirst && hasEconomy) || (hasBusiness && hasEconomy);
  
  // If mixed cabin, not confident about pricing
  const confident = cabinInfo.confident && !mixedCabin;
  
  // Extract dates
  const dates = extractDates(text);
  
  const origin = orderedAirports[0];
  const lastAirport = orderedAirports[orderedAirports.length - 1];
  
  // Check if this is a ROUNDTRIP (first and last airports are same or in same area)
  if (origin === lastAirport || isSameArea(origin, lastAirport)) {
    // It's a roundtrip! Find the turnaround point
    // For LIT → LGA → LIT, turnaround is LGA (the middle unique airport)
    if (orderedAirports.length >= 3) {
      // Find the destination (the airport that's not the origin)
      let destination = null;
      for (const apt of orderedAirports) {
        if (apt !== origin && !isSameArea(apt, origin)) {
          destination = apt;
          break;
        }
      }
      
      if (destination) {
        Logger.log("AA roundtrip detected: " + origin + " → " + destination + " → " + lastAirport);
        
        // Outbound leg
        legs.push({
          from: origin,
          to: destination,
          cabin: cabinInfo.cabin,
          cabinConfident: confident,
          date: dates[0] || ""
        });
        
        // Return leg
        legs.push({
          from: destination,
          to: lastAirport,
          cabin: cabinInfo.cabin,
          cabinConfident: confident,
          date: dates[1] || dates[0] || ""
        });
        
        return legs;
      }
    }
  }
  
  // Not a roundtrip - single direction (could be with connections)
  // Origin is first airport, destination is last airport
  const destination = lastAirport;
  const flightDate = dates.length > 0 ? dates[0] : "";
  
  legs.push({
    from: origin,
    to: destination,
    cabin: cabinInfo.cabin,
    cabinConfident: confident,
    date: flightDate
  });

  return legs;
}

function extractUAItinerary(text) {
  const legs = [];

  // FORMAT A: "MSP 2H, 40M EWR" — origin + duration + destination on one line
  const formatAPattern = /\b([A-Z]{3})\s+\d+H[^A-Z]*\d*M?\s+([A-Z]{3})\b/;
  const formatAMatch = text.match(formatAPattern);

  let origin = "";
  let destination = "";

  if (formatAMatch) {
    origin = formatAMatch[1];
    destination = formatAMatch[2];
  } else {
    // FORMAT B: airport codes in parentheses like "Newark (EWR)" — take first two
    const formatBMatches = [];
    const formatBPattern = /\(([A-Z]{3})\)/g;
    let m;
    while ((m = formatBPattern.exec(text)) !== null) {
      formatBMatches.push(m[1]);
    }
    if (formatBMatches.length >= 2) {
      origin = formatBMatches[0];
      destination = formatBMatches[1];
    }
  }

  if (!origin || !destination) return legs;

  const cabinInfo = detectCabinClass(text, "UA");
  const dates = extractDates(text);
  const flightDate = dates.length > 0 ? dates[0] : "";

  legs.push({
    from: origin,
    to: destination,
    cabin: cabinInfo.cabin,
    cabinConfident: cabinInfo.confident,
    date: flightDate
  });

  return legs;
}

// ============ CONSOLIDATE CONNECTING FLIGHTS ============
function consolidateConnectingFlights(legs) {
  if (legs.length <= 1) return legs;
  
  // Check if legs form a connection (leg1.to === leg2.from)
  let isConnection = true;
  for (let i = 0; i < legs.length - 1; i++) {
    if (legs[i].to !== legs[i + 1].from) {
      isConnection = false;
      break;
    }
  }
  
  if (isConnection) {
    // Consolidate to single leg: origin of first → destination of last
    const origin = legs[0].from;
    const destination = legs[legs.length - 1].to;
    const date = legs[0].date;
    
    // For cabin, only be confident if ALL legs have same confident cabin
    const allSameCabin = legs.every(l => l.cabin === legs[0].cabin);
    const allConfident = legs.every(l => l.cabinConfident);
    
    return [{
      from: origin,
      to: destination,
      cabin: legs[0].cabin,
      cabinConfident: allSameCabin && allConfident,
      date: date
    }];
  }
  
  // Not a simple connection - might be roundtrip or complex itinerary
  return legs;
}

// ============ DETECT CABIN CLASS WITH CONFIDENCE ============
function detectCabinClass(text, airline) {
  const textLower = text.toLowerCase();
  
  // Air Canada explicit patterns (handles both "Cabin : " and "Cabin: ")
  if (airline === "AC") {
    if (textLower.includes("cabin : business") || textLower.includes("cabin: business")) {
      return { cabin: "business", confident: true };
    }
    if (textLower.includes("cabin : economy") || textLower.includes("cabin: economy")) {
      return { cabin: "economy", confident: true };
    }
    // "Business - Standard" or "Economy - Standard" format
    if (/business\s*-\s*(standard|lowest|flex)/i.test(text)) {
      return { cabin: "business", confident: true };
    }
    if (/economy\s*-\s*(standard|lowest|flex|basic)/i.test(text)) {
      return { cabin: "economy", confident: true };
    }
  }
  
  // American Airlines - look in Class column of traveler table
  if (airline === "AA") {
    // Look for "Class" header followed by class value
    // Pattern: after passenger name, there's usually "Economy" or "Business" or "First"
    
    // Check for explicit class mentions near passenger info
    if (/\bClass\s+Business\b/i.test(text) || /\bBusiness\s+\d+[A-Z]\b/i.test(text)) {
      return { cabin: "business", confident: true };
    }
    if (/\bClass\s+Economy\b/i.test(text) || /\bEconomy\s+\d+[A-Z]\b/i.test(text)) {
      return { cabin: "economy", confident: true };
    }
    if (/\bClass\s+First\b/i.test(text) || /\bFirst\s+\d+[A-Z]\b/i.test(text)) {
      return { cabin: "business", confident: true };  // Treat First as Business for pricing
    }
    
    // Look for table format: NAME \n CLASS \n SEAT
    // e.g., "YEHOSHUA ADAM COLE \n Economy \n 17C"
    if (/[A-Z]{2,}\s+[A-Z]{2,}[^a-z]*\n\s*Economy/i.test(text)) {
      return { cabin: "economy", confident: true };
    }
    if (/[A-Z]{2,}\s+[A-Z]{2,}[^a-z]*\n\s*Business/i.test(text)) {
      return { cabin: "business", confident: true };
    }
  }

  // United Airlines
  if (airline === "UA") {
    if (/United\s+Polaris/i.test(text) || /United\s+Business/i.test(text)) {
      return { cabin: "business", confident: true };
    }
    if (/United\s+First/i.test(text)) {
      return { cabin: "business", confident: true };  // Treat First as Business for pricing
    }
    if (/United\s+Premium/i.test(text)) {
      return { cabin: "economy", confident: true };  // Premium Economy → economy for pricing
    }
    if (/United\s+Economy/i.test(text)) {
      return { cabin: "economy", confident: true };
    }
  }

  // Generic patterns (lower confidence)
  if (textLower.includes("business class")) {
    return { cabin: "business", confident: true };
  }
  if (textLower.includes("economy class")) {
    return { cabin: "economy", confident: true };
  }
  
  // No confident detection - return economy but NOT confident
  return { cabin: "economy", confident: false };
}

function findAirportsSimple(text) {
  const foundAirports = [];
  
  for (const apt of KNOWN_AIRPORTS) {
    const regex = new RegExp("\\b" + apt + "\\b", "g");
    let match;
    while ((match = regex.exec(text)) !== null) {
      foundAirports.push({ code: apt, index: match.index });
    }
  }
  
  foundAirports.sort((a, b) => a.index - b.index);
  
  return foundAirports.map(a => a.code);
}

function extractDates(text) {
  const flightDates = [];
  
  // Pattern 1: "Dec 25, 2025" or "April 26, 2026" format (handles full month names)
  const datePattern1 = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})[,.]?\s+(\d{4})\b/gi;
  let dateMatch;
  while ((dateMatch = datePattern1.exec(text)) !== null) {
    // Normalize month to 3-letter abbreviation for consistent output
    const monthAbbr = dateMatch[1].substring(0, 3);
    const dateStr = dateMatch[2] + " " + monthAbbr + " " + dateMatch[3];
    const contextStart = Math.max(0, dateMatch.index - 30);
    const contextEnd = Math.min(text.length, dateMatch.index + dateMatch[0].length + 15);
    const contextBefore = text.substring(contextStart, dateMatch.index).toLowerCase();
    const contextAfter = text.substring(dateMatch.index + dateMatch[0].length, contextEnd).toLowerCase();
    
    if (!contextBefore.includes("status") && 
        !contextBefore.includes("ticketed") && 
        !contextBefore.includes("booked") && 
        !contextBefore.includes("issued") &&
        !contextAfter.includes(" at ")) {
      if (!flightDates.includes(dateStr)) {
        flightDates.push(dateStr);
      }
    }
  }
  
  // Pattern 2: "25 Dec 2025" or "26 April 2026" format (handles full month names)
  const datePattern2 = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[,.]?\s+(\d{4})\b/gi;
  while ((dateMatch = datePattern2.exec(text)) !== null) {
    // Normalize month to 3-letter abbreviation for consistent output
    const monthAbbr = dateMatch[2].substring(0, 3);
    const dateStr = dateMatch[1] + " " + monthAbbr + " " + dateMatch[3];
    const contextStart = Math.max(0, dateMatch.index - 30);
    const contextEnd = Math.min(text.length, dateMatch.index + dateMatch[0].length + 15);
    const contextBefore = text.substring(contextStart, dateMatch.index).toLowerCase();
    const contextAfter = text.substring(dateMatch.index + dateMatch[0].length, contextEnd).toLowerCase();
    
    if (!contextBefore.includes("status") && 
        !contextBefore.includes("ticketed") && 
        !contextBefore.includes("booked") && 
        !contextBefore.includes("issued") &&
        !contextAfter.includes(" at ")) {
      if (!flightDates.includes(dateStr)) {
        flightDates.push(dateStr);
      }
    }
  }
  
  return flightDates;
}

function isReturnFlight(outboundFrom, returnTo) {
  return isSameArea(outboundFrom, returnTo);
}

function isSameArea(airport1, airport2) {
  if (NYC_AIRPORTS.includes(airport1) && NYC_AIRPORTS.includes(airport2)) {
    return true;
  }
  if (CANADA_ALL.includes(airport1) && CANADA_ALL.includes(airport2)) {
    return true;
  }
  if (airport1 === airport2) {
    return true;
  }
  return false;
}

function calculateLegPrice(airline, from, to, cabin) {
  // United — no pricing rules; manual fill (matches historical AA behavior)
  if (airline === "UA") {
    return "";
  }

  for (const rule of PRICING_RULES) {
    if (rule.airline === airline && 
        rule.from.includes(from) && 
        rule.to.includes(to)) {
      if (cabin === "business") {
        return rule.business;
      } else {
        return rule.economy;
      }
    }
  }
  
  // No matching rule - return empty (strict mode)
  return "";
}

// ============ HELPER FUNCTIONS ============
function capitalizeWords(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function addRowToSheet(sheet, data) {
  // Find first empty row in column B
  const lastNameCol = sheet.getRange("B:B").getValues();
  let newRow = 3;
  for (let i = 2; i < lastNameCol.length; i++) {
    if (lastNameCol[i][0] === "" || lastNameCol[i][0] === null) {
      newRow = i + 1;
      break;
    }
  }
  
  Logger.log("Adding row " + newRow + ": " + JSON.stringify(data));
  
  sheet.getRange(newRow, COLUMNS.LAST).setValue(data.lastName);
  sheet.getRange(newRow, COLUMNS.FIRST).setValue(data.firstName);
  sheet.getRange(newRow, COLUMNS.OPERATOR).setValue(CONFIG.OPERATOR_NAME);
  sheet.getRange(newRow, COLUMNS.CHARGED).setValue(data.charged);
  sheet.getRange(newRow, COLUMNS.AIRLINE).setValue(data.airline);
  sheet.getRange(newRow, COLUMNS.PNR).setValue(data.pnr);
  sheet.getRange(newRow, COLUMNS.DATE1).setValue(data.date1);
  sheet.getRange(newRow, COLUMNS.DATE2).setValue(data.date2);
  sheet.getRange(newRow, COLUMNS.AIRPORT1).setValue(data.airport1);
  sheet.getRange(newRow, COLUMNS.AIRPORT2).setValue(data.airport2);
  
  // Set roundtrip checkbox in column U
  if (data.isRoundtrip) {
    sheet.getRange(newRow, COLUMNS.ROUNDTRIP).insertCheckboxes();
    sheet.getRange(newRow, COLUMNS.ROUNDTRIP).setValue(true);
  } else {
    sheet.getRange(newRow, COLUMNS.ROUNDTRIP).insertCheckboxes();
    sheet.getRange(newRow, COLUMNS.ROUNDTRIP).setValue(false);
  }
  
  // Set traveler count in column V
  sheet.getRange(newRow, COLUMNS.TRAVELERS).setValue(data.passengerCount || 1);
  
  // Set kosher field - NA unless route includes kosher airports
  const airport1Codes = data.airport1.split(" / ");
  const airport2Codes = data.airport2.split(" / ");
  const allAirports = [...airport1Codes, ...airport2Codes];
  const needsKosher = allAirports.some(apt => KOSHER_AIRPORTS.includes(apt.trim()));
  
  if (!needsKosher) {
    sheet.getRange(newRow, COLUMNS.KOSHER).setValue("NA");
  }
}

// ============ MENU SETUP ============
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('YM Travel')
    .addItem('Process PDFs', 'processTravelPDFs')
    .addItem('Process WhatsApp Chat', 'processWhatsAppChat')
    .addToUi();
}
