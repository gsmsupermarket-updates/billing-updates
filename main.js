const { app, BrowserWindow, ipcMain, shell, screen, Menu, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec, execSync, spawn } = require("child_process");
const http = require("http");
const https = require("https");
const bwipjs = require("bwip-js");
const packageJson = require("./package.json");
const crypto = require("crypto");

const LICENSE_SECRET = "GSM_BILLING_SECRET";

const USER_DATA_DIR = app.getPath("userData");
const DB_FILE = path.join(USER_DATA_DIR, "billing.db");
const BACKUP_DIR = path.join(USER_DATA_DIR, "backups");
const LEGACY_DB_FILE = path.join(__dirname, "billing.db");
const LEGACY_BACKUP_DIR = path.join(__dirname, "backups");

function bootstrapDataFiles() {
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE) && fs.existsSync(LEGACY_DB_FILE)) {
    fs.copyFileSync(LEGACY_DB_FILE, DB_FILE);
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  if (fs.existsSync(LEGACY_BACKUP_DIR)) {
    const oldBackups = fs
      .readdirSync(LEGACY_BACKUP_DIR)
      .filter((f) => /^billing-\d{4}-\d{2}-\d{2}\.db$/i.test(f));
    for (const file of oldBackups) {
      const src = path.join(LEGACY_BACKUP_DIR, file);
      const dest = path.join(BACKUP_DIR, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

bootstrapDataFiles();

// Set AppUserModelId so Task Manager shows GSM Super Market instead of Electron
app.setAppUserModelId("GSM Super Market");
app.name = "GSM Super Market";

let activeDbPath = DB_FILE;
try {
  const customDbConfigPath = path.join(app.getPath("userData"), "database_path.txt");
  const exeDirConfigPath = path.join(path.dirname(app.getPath("exe")), "database_path.txt");
  
  if (fs.existsSync(exeDirConfigPath)) {
    const p = fs.readFileSync(exeDirConfigPath, "utf8").trim();
    if (p) activeDbPath = p;
  } else if (fs.existsSync(customDbConfigPath)) {
    const p = fs.readFileSync(customDbConfigPath, "utf8").trim();
    if (p) activeDbPath = p;
  }
} catch (e) {
  console.error("Failed to read custom database config", e);
}

if (!process.env.BILLSWIFT_DB_PATH) {
  process.env.BILLSWIFT_DB_PATH = activeDbPath;
}
const db = require("./database");
let mainWindow = null;
let customerDisplayWindow = null;
let mobileCompanionWindow = null;

// Remote Server State
let remoteCompanionUrl = "";
let latestCompanionHtml = "Loading... Please interact with the app to update.";
let companionServerStarted = false;

function startRemoteCompanionServer() {
  if (companionServerStarted) return;
  companionServerStarted = true;

  const server = http.createServer((req, res) => {
    // Basic reload script so the mobile browser auto-refreshes every 5 seconds
    const autoRefreshScript = `
      <script>
        setTimeout(() => { window.location.reload(); }, 5000);
      </script>
    `;
    const finalHtml = latestCompanionHtml.includes("</body>") 
      ? latestCompanionHtml.replace("</body>", autoRefreshScript + "</body>")
      : latestCompanionHtml + autoRefreshScript;
      
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(finalHtml);
  });

  server.listen(0, () => {
    const port = server.address().port;
    console.log(`Companion server running on ${port}`);

    const ssh = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-R', `80:127.0.0.1:${port}`,
      'serveo.net'
    ]);

    const handleOutput = (data) => {
      const output = data.toString();
      const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.serveo(?:usercontent)?\.(?:net|com)/);
      if (match) {
        remoteCompanionUrl = match[0];
        console.log("Remote URL established:", remoteCompanionUrl);
      }
    };

    ssh.stdout.on('data', handleOutput);
    ssh.stderr.on('data', handleOutput);
  });

  server.on('error', (e) => {
    console.error("Companion server error:", e);
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    title: "GSM Super Market",
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    show: false, // Don't show until ready
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      plugins: true,
    },
  });

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer] ${message} (${sourceId}:${line})`);
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  win.setMenu(null);
  win.setTitle("GSM Super Market");
  win.loadFile("index.html");
  mainWindow = win;

  win.on("close", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Yes", "No"],
      title: "Confirm Exit",
      message: "Are you sure you want to close GSM Super Market?",
      defaultId: 1,
      cancelId: 1
    });
    if (choice === 1) {
      e.preventDefault();
    }
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
}

const BACKUP_INTERVAL_MS = 60 * 60 * 1000; // hourly check, creates one file per day
const BACKUP_RETAIN_DAYS = 30;

function getDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function getTodayBackupPath() {
  return path.join(BACKUP_DIR, `billing-${getDateKey()}.db`);
}

function listBackupFiles() {
  ensureBackupDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^billing-\d{4}-\d{2}-\d{2}\.db$/i.test(f))
    .sort((a, b) => b.localeCompare(a))
    .map((name) => ({
      name,
      path: path.join(BACKUP_DIR, name),
    }));
}

function parseBackupDateFromName(fileName) {
  const m = /^billing-(\d{4})-(\d{2})-(\d{2})\.db$/i.exec(fileName);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanupOldBackups(retainDays = BACKUP_RETAIN_DAYS) {
  ensureBackupDir();
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - retainDays);

  let deleted = 0;
  const files = fs.readdirSync(BACKUP_DIR);
  for (const file of files) {
    const backupDate = parseBackupDateFromName(file);
    if (!backupDate) continue;
    if (backupDate < cutoff) {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
      deleted += 1;
    }
  }
  return deleted;
}

async function createDailyBackup({ force = false } = {}) {
  ensureBackupDir();
  const todayBackup = getTodayBackupPath();

  const deletedOldBackups = cleanupOldBackups();

  if (!force && fs.existsSync(todayBackup)) {
    return { ok: true, created: false, backupPath: todayBackup, deletedOldBackups };
  }
  if (!fs.existsSync(DB_FILE)) {
    throw new Error("Database file not found");
  }

  await fs.promises.copyFile(DB_FILE, todayBackup);
  return { ok: true, created: true, backupPath: todayBackup, deletedOldBackups };
}

function getBackupStatus() {
  ensureBackupDir();
  const files = listBackupFiles().map((f) => path.basename(f.path)).sort();
  const latest = files.length ? files[files.length - 1] : null;
  const todayPath = getTodayBackupPath();
  return {
    backupDir: BACKUP_DIR,
    totalBackups: files.length,
    todayExists: fs.existsSync(todayPath),
    todayFile: todayPath,
    latestFile: latest ? path.join(BACKUP_DIR, latest) : "",
    retentionDays: BACKUP_RETAIN_DAYS,
  };
}

async function restoreFromBackupFile(backupPath) {
  const resolvedBackupDir = path.resolve(BACKUP_DIR);
  const resolvedBackupPath = path.resolve(backupPath);
  if (!resolvedBackupPath.startsWith(`${resolvedBackupDir}${path.sep}`)) {
    throw new Error("Invalid backup path");
  }
  if (!fs.existsSync(resolvedBackupPath)) {
    throw new Error("Backup file not found");
  }

  // Clean any stale backup attachments from previous failed restore attempts
  const dbList = await all("PRAGMA database_list");
  for (const dbEntry of dbList) {
    const name = String(dbEntry?.name || "");
    if (name === "main" || name === "temp") continue;
    if (!/^(bkp|bkp_[A-Za-z0-9_]+)$/.test(name)) continue;
    try {
      await run(`DETACH DATABASE ${name}`);
    } catch (_err) {
      // Ignore; we'll still try with a fresh alias below
    }
  }

  const backupAlias = `bkp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    await run(`ATTACH DATABASE ? AS ${backupAlias}`, [resolvedBackupPath]);

    const requiredTables = ["products", "sales", "sale_items"];
    for (const table of requiredTables) {
      const exists = await get(
        `SELECT name FROM ${backupAlias}.sqlite_master WHERE type='table' AND name = ?`,
        [table],
      );
      if (!exists) {
        throw new Error(`Backup missing table: ${table}`);
      }
    }

    await run("DELETE FROM sale_items");
    await run("DELETE FROM sales");
    await run("DELETE FROM sale_returns");
    await run("DELETE FROM stock_adjustments");
    await run("DELETE FROM sync_queue");
    await run("DELETE FROM customers");
    await run("DELETE FROM products");

    const productCols = await all(`PRAGMA ${backupAlias}.table_info(products)`);
    const backupHasProductGst = Array.isArray(productCols)
      ? productCols.some((c) => String(c.name) === "gst_percent")
      : false;
    const backupHasProductHsn = Array.isArray(productCols)
      ? productCols.some((c) => String(c.name) === "hsn_code")
      : false;
    const backupHasProductCostPrice = Array.isArray(productCols)
      ? productCols.some((c) => String(c.name) === "cost_price")
      : false;
    const backupHasProductUnit = Array.isArray(productCols)
      ? productCols.some((c) => String(c.name) === "unit")
      : false;
    const backupHasProductPackSizeValue = Array.isArray(productCols)
      ? productCols.some((c) => String(c.name) === "pack_size_value")
      : false;
    const backupHasProductPackSizeUnit = Array.isArray(productCols)
      ? productCols.some((c) => String(c.name) === "pack_size_unit")
      : false;
    const unitExpr = backupHasProductUnit ? "COALESCE(unit, 'pcs')" : "'pcs'";
    const packValueExpr = backupHasProductPackSizeValue ? "COALESCE(pack_size_value, 0)" : "0";
    const packUnitExpr = backupHasProductPackSizeUnit ? "COALESCE(pack_size_unit, '')" : "''";

    const salesCols = await all(`PRAGMA ${backupAlias}.table_info(sales)`);
    const backupHasSaleSubtotal = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "subtotal")
      : false;
    const backupHasSaleDiscount = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "discount")
      : false;
    const backupHasSalePaymentMode = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "payment_mode")
      : false;
    const backupHasSaleCashAmount = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "cash_amount")
      : false;
    const backupHasSaleUpiAmount = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "upi_amount")
      : false;
    const backupHasSaleCardAmount = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "card_amount")
      : false;
    const backupHasSaleCustomerId = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "customer_id")
      : false;
    const backupHasSaleLoyaltyRedeemedPoints = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "loyalty_redeemed_points")
      : false;
    const backupHasSaleLoyaltyRedeemedAmount = Array.isArray(salesCols)
      ? salesCols.some((c) => String(c.name) === "loyalty_redeemed_amount")
      : false;

    const saleItemCols = await all(`PRAGMA ${backupAlias}.table_info(sale_items)`);
    const backupHasSaleItemGst = Array.isArray(saleItemCols)
      ? saleItemCols.some((c) => String(c.name) === "gst_percent")
      : false;
    const backupHasSaleItemHsn = Array.isArray(saleItemCols)
      ? saleItemCols.some((c) => String(c.name) === "hsn_code")
      : false;
    if (backupHasProductGst && backupHasProductHsn && backupHasProductCostPrice) {
      await run(`
        INSERT INTO products(id, name, barcode, price, stock, unit, pack_size_value, pack_size_unit, gst_percent, hsn_code, cost_price)
        SELECT id, name, barcode, price, COALESCE(stock, 0), ${unitExpr}, ${packValueExpr}, ${packUnitExpr}, COALESCE(gst_percent, 0), COALESCE(hsn_code, ''), COALESCE(cost_price, 0)
        FROM ${backupAlias}.products
      `);
    } else if (backupHasProductGst && backupHasProductHsn && !backupHasProductCostPrice) {
      await run(`
        INSERT INTO products(id, name, barcode, price, stock, unit, pack_size_value, pack_size_unit, gst_percent, hsn_code, cost_price)
        SELECT id, name, barcode, price, COALESCE(stock, 0), ${unitExpr}, ${packValueExpr}, ${packUnitExpr}, COALESCE(gst_percent, 0), COALESCE(hsn_code, ''), 0
        FROM ${backupAlias}.products
      `);
    } else if (backupHasProductGst && !backupHasProductHsn && backupHasProductCostPrice) {
      await run(`
        INSERT INTO products(id, name, barcode, price, stock, unit, pack_size_value, pack_size_unit, gst_percent, hsn_code, cost_price)
        SELECT id, name, barcode, price, COALESCE(stock, 0), ${unitExpr}, ${packValueExpr}, ${packUnitExpr}, COALESCE(gst_percent, 0), '', COALESCE(cost_price, 0)
        FROM ${backupAlias}.products
      `);
    } else if (backupHasProductGst && !backupHasProductHsn && !backupHasProductCostPrice) {
      await run(`
        INSERT INTO products(id, name, barcode, price, stock, unit, pack_size_value, pack_size_unit, gst_percent, hsn_code, cost_price)
        SELECT id, name, barcode, price, COALESCE(stock, 0), ${unitExpr}, ${packValueExpr}, ${packUnitExpr}, COALESCE(gst_percent, 0), '', 0
        FROM ${backupAlias}.products
      `);
    } else if (!backupHasProductGst && backupHasProductHsn && backupHasProductCostPrice) {
      await run(`
        INSERT INTO products(id, name, barcode, price, stock, unit, pack_size_value, pack_size_unit, gst_percent, hsn_code, cost_price)
        SELECT id, name, barcode, price, COALESCE(stock, 0), ${unitExpr}, ${packValueExpr}, ${packUnitExpr}, 0, COALESCE(hsn_code, ''), COALESCE(cost_price, 0)
        FROM ${backupAlias}.products
      `);
    } else if (!backupHasProductGst && backupHasProductHsn && !backupHasProductCostPrice) {
      await run(`
        INSERT INTO products(id, name, barcode, price, stock, unit, pack_size_value, pack_size_unit, gst_percent, hsn_code, cost_price)
        SELECT id, name, barcode, price, COALESCE(stock, 0), ${unitExpr}, ${packValueExpr}, ${packUnitExpr}, 0, COALESCE(hsn_code, ''), 0
        FROM ${backupAlias}.products
      `);
    } else if (!backupHasProductGst && !backupHasProductHsn && backupHasProductCostPrice) {
      await run(`
        INSERT INTO products(id, name, barcode, price, stock, unit, pack_size_value, pack_size_unit, gst_percent, hsn_code, cost_price)
        SELECT id, name, barcode, price, COALESCE(stock, 0), ${unitExpr}, ${packValueExpr}, ${packUnitExpr}, 0, '', COALESCE(cost_price, 0)
        FROM ${backupAlias}.products
      `);
    } else {
      await run(`
        INSERT INTO products(id, name, barcode, price, stock, unit, pack_size_value, pack_size_unit, gst_percent, hsn_code, cost_price)
        SELECT id, name, barcode, price, COALESCE(stock, 0), ${unitExpr}, ${packValueExpr}, ${packUnitExpr}, 0, '', 0
        FROM ${backupAlias}.products
      `);
    }

    const backupHasCustomers = await get(
      `SELECT name FROM ${backupAlias}.sqlite_master WHERE type='table' AND name = 'customers'`,
    );
    if (backupHasCustomers) {
      const customerCols = await all(`PRAGMA ${backupAlias}.table_info(customers)`);
      const backupHasCustomerEmail = Array.isArray(customerCols)
        ? customerCols.some((c) => String(c.name) === "email")
        : false;
      const backupHasCustomerAddress = Array.isArray(customerCols)
        ? customerCols.some((c) => String(c.name) === "address")
        : false;
      const backupHasCustomerDiscount = Array.isArray(customerCols)
        ? customerCols.some((c) => String(c.name) === "default_discount")
        : false;
      const backupHasCustomerPoints = Array.isArray(customerCols)
        ? customerCols.some((c) => String(c.name) === "loyalty_points")
        : false;

      await run(`
        INSERT INTO customers(id, name, phone, email, address, default_discount, loyalty_points, created_at)
        SELECT
          id,
          name,
          COALESCE(phone, ''),
          ${backupHasCustomerEmail ? "COALESCE(email, '')" : "''"},
          ${backupHasCustomerAddress ? "COALESCE(address, '')" : "''"},
          ${backupHasCustomerDiscount ? "COALESCE(default_discount, 0)" : "0"},
          ${backupHasCustomerPoints ? "COALESCE(loyalty_points, 0)" : "0"},
          COALESCE(created_at, datetime('now','localtime'))
        FROM ${backupAlias}.customers
      `);
    }

    const backupHasKhataAccounts = await get(
      `SELECT name FROM ${backupAlias}.sqlite_master WHERE type='table' AND name = 'khata_accounts'`,
    );
    const backupHasKhataEntries = await get(
      `SELECT name FROM ${backupAlias}.sqlite_master WHERE type='table' AND name = 'khata_entries'`,
    );
    if (backupHasKhataAccounts) {
      await run("DELETE FROM khata_entries");
      await run("DELETE FROM khata_accounts");
      await run(`
        INSERT INTO khata_accounts(
          id, customer_id, name, phone, address, opening_balance, current_balance, is_active, created_at
        )
        SELECT
          id, customer_id, name, COALESCE(phone, ''), COALESCE(address, ''),
          COALESCE(opening_balance, 0), COALESCE(current_balance, 0),
          COALESCE(is_active, 1), COALESCE(created_at, datetime('now','localtime'))
        FROM ${backupAlias}.khata_accounts
      `);
    }
    if (backupHasKhataEntries) {
      await run(`
        INSERT INTO khata_entries(
          id, account_id, entry_type, amount, note, sale_id, created_at
        )
        SELECT
          id, account_id, entry_type, COALESCE(amount, 0), COALESCE(note, ''),
          sale_id, COALESCE(created_at, datetime('now','localtime'))
        FROM ${backupAlias}.khata_entries
      `);
    }

    await run(`
      INSERT INTO sales(
        id, total, date, subtotal, discount, payment_mode, cash_amount, upi_amount, card_amount,
        customer_id, loyalty_redeemed_points, loyalty_redeemed_amount
      )
      SELECT
        id,
        total,
        date,
        ${backupHasSaleSubtotal ? "COALESCE(subtotal, total)" : "total"},
        ${backupHasSaleDiscount ? "COALESCE(discount, 0)" : "0"},
        ${backupHasSalePaymentMode ? "COALESCE(payment_mode, 'cash')" : "'cash'"},
        ${
          backupHasSaleCashAmount
            ? "COALESCE(cash_amount, CASE WHEN COALESCE(payment_mode, 'cash') = 'cash' THEN total ELSE 0 END)"
            : "CASE WHEN " +
              (backupHasSalePaymentMode ? "COALESCE(payment_mode, 'cash')" : "'cash'") +
              " = 'cash' THEN total ELSE 0 END"
        },
        ${backupHasSaleUpiAmount ? "COALESCE(upi_amount, 0)" : "0"},
        ${backupHasSaleCardAmount ? "COALESCE(card_amount, 0)" : "0"},
        ${backupHasSaleCustomerId ? "customer_id" : "NULL"},
        ${backupHasSaleLoyaltyRedeemedPoints ? "COALESCE(loyalty_redeemed_points, 0)" : "0"},
        ${backupHasSaleLoyaltyRedeemedAmount ? "COALESCE(loyalty_redeemed_amount, 0)" : "0"}
      FROM ${backupAlias}.sales
    `);

    const backupHasSaleReturns = await get(
      `SELECT name FROM ${backupAlias}.sqlite_master WHERE type='table' AND name = 'sale_returns'`,
    );
    if (backupHasSaleReturns) {
      await run(`
        INSERT INTO sale_returns(
          id, original_sale_id, customer_id, customer_name, payment_mode, subtotal, discount,
          loyalty_redeemed_points, loyalty_redeemed_amount, refund_total, reason, items_json,
          refunded_at, performed_by
        )
        SELECT
          id, original_sale_id, customer_id, COALESCE(customer_name, ''), COALESCE(payment_mode, 'cash'),
          COALESCE(subtotal, 0), COALESCE(discount, 0), COALESCE(loyalty_redeemed_points, 0),
          COALESCE(loyalty_redeemed_amount, 0), COALESCE(refund_total, 0), COALESCE(reason, ''),
          COALESCE(items_json, '[]'), COALESCE(refunded_at, datetime('now','localtime')),
          COALESCE(performed_by, '')
        FROM ${backupAlias}.sale_returns
      `);
    }

    const backupHasStockAdjustments = await get(
      `SELECT name FROM ${backupAlias}.sqlite_master WHERE type='table' AND name = 'stock_adjustments'`,
    );
    if (backupHasStockAdjustments) {
      await run(`
        INSERT INTO stock_adjustments(
          id, product_id, product_name, barcode, adjustment_type, qty_before, qty_change,
          qty_after, reason, created_at, performed_by
        )
        SELECT
          id, product_id, product_name, COALESCE(barcode, ''), adjustment_type,
          COALESCE(qty_before, 0), COALESCE(qty_change, 0), COALESCE(qty_after, 0),
          COALESCE(reason, ''), COALESCE(created_at, datetime('now','localtime')),
          COALESCE(performed_by, '')
        FROM ${backupAlias}.stock_adjustments
      `);
    }

    const backupHasSyncQueue = await get(
      `SELECT name FROM ${backupAlias}.sqlite_master WHERE type='table' AND name = 'sync_queue'`,
    );
    if (backupHasSyncQueue) {
      await run(`
        INSERT INTO sync_queue(
          id, entity_type, action_type, entity_id, payload_json, status, retry_count, last_error, created_at, updated_at
        )
        SELECT
          id, entity_type, action_type, COALESCE(entity_id, ''), COALESCE(payload_json, '{}'),
          COALESCE(status, 'pending'), COALESCE(retry_count, 0), COALESCE(last_error, ''),
          COALESCE(created_at, datetime('now','localtime')), COALESCE(updated_at, datetime('now','localtime'))
        FROM ${backupAlias}.sync_queue
      `);
    }

    if (backupHasSaleItemGst && backupHasSaleItemHsn) {
      await run(`
        INSERT INTO sale_items(id, sale_id, product_id, product_name, price, qty, gst_percent, hsn_code)
        SELECT id, sale_id, product_id, product_name, price, qty, COALESCE(gst_percent, 0), COALESCE(hsn_code, '')
        FROM ${backupAlias}.sale_items
      `);
    } else if (backupHasSaleItemGst && !backupHasSaleItemHsn) {
      await run(`
        INSERT INTO sale_items(id, sale_id, product_id, product_name, price, qty, gst_percent, hsn_code)
        SELECT id, sale_id, product_id, product_name, price, qty, COALESCE(gst_percent, 0), ''
        FROM ${backupAlias}.sale_items
      `);
    } else if (!backupHasSaleItemGst && backupHasSaleItemHsn) {
      await run(`
        INSERT INTO sale_items(id, sale_id, product_id, product_name, price, qty, gst_percent, hsn_code)
        SELECT id, sale_id, product_id, product_name, price, qty, 0, COALESCE(hsn_code, '')
        FROM ${backupAlias}.sale_items
      `);
    } else {
      await run(`
        INSERT INTO sale_items(id, sale_id, product_id, product_name, price, qty, gst_percent, hsn_code)
        SELECT id, sale_id, product_id, product_name, price, qty, 0, ''
        FROM ${backupAlias}.sale_items
      `);
    }

    const backupHasSettings = await get(
      `SELECT name FROM ${backupAlias}.sqlite_master WHERE type='table' AND name = 'settings'`,
    );
    if (backupHasSettings) {
      await run("DELETE FROM settings");
      await run(`INSERT INTO settings(key, value) SELECT key, value FROM ${backupAlias}.settings`);
    }

    await run("COMMIT");
    await run(`DETACH DATABASE ${backupAlias}`);
    return { ok: true, restoredFrom: resolvedBackupPath };
  } catch (err) {
    try {
      await run("ROLLBACK");
    } catch (_rollbackErr) {}
    try {
      await run(`DETACH DATABASE ${backupAlias}`);
    } catch (_detachErr) {}
    throw err;
  }
}

async function runAutoBackup() {
  try {
    const result = await createDailyBackup();
    if (result.created) {
      console.log("Daily backup created:", result.backupPath);
      await logBackupEvent("auto_backup", "success", "Daily backup created", result.backupPath);
      await logAuditEvent("backup_auto", "success", "system", result.backupPath, "Daily backup created");
    }
    if (result.deletedOldBackups > 0) {
      console.log("Old backups deleted:", result.deletedOldBackups);
      await logBackupEvent(
        "backup_cleanup",
        "success",
        `Deleted ${result.deletedOldBackups} old backup(s)`,
        "",
      );
      await logAuditEvent(
        "backup_cleanup",
        "success",
        "system",
        "",
        `Deleted ${result.deletedOldBackups} old backup(s)`,
      );
    }
  } catch (err) {
    console.error("Daily backup failed:", err.message);
    await logBackupEvent("auto_backup", "failed", err?.message || "Auto backup failed", "");
    await logAuditEvent("backup_auto", "failed", "system", "", err?.message || "Auto backup failed");
  }
}

app.whenReady().then(async () => {
  // Critical setup tasks (fast)
  try {
    await ensureDefaultUsers();
    const userCount = await get("SELECT COUNT(*) AS cnt FROM users");
    if (Number(userCount?.cnt) > 0) {
      await setSettingValue("setup_complete", "1");
    }
  } catch (_e) {}

  createWindow();

  // Defer heavy startup tasks so the UI can load instantly
  setTimeout(async () => {
    try {
      await runAutoBackup();
    } catch (_e) {}
  }, 3000);

  setInterval(() => {
    void runAutoBackup();
  }, BACKUP_INTERVAL_MS);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function ensureDefaultUsers() {
  try {
    await run(
      "INSERT OR IGNORE INTO users(username, password, role) VALUES('admin', 'admin123', 'admin')",
    );
    await run(
      "INSERT OR IGNORE INTO users(username, password, role) VALUES('cashier', 'cash123', 'cashier')",
    );
  } catch (err) {
    console.error("Default user seed failed:", err?.message || err);
  }
}

function getLocalTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toMoney(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function getSalePoints(total) {
  return Math.max(0, Math.floor(toMoney(total) / 100));
}

function normalizeRedeemPoints(value) {
  const points = Math.floor(Number(value || 0));
  return Number.isFinite(points) && points > 0 ? points : 0;
}

function getRedeemAmountFromPoints(points, subtotalAfterDiscount) {
  return Math.min(normalizeRedeemPoints(points), Math.max(0, toMoney(subtotalAfterDiscount)));
}

function getSaleLoyaltySnapshot(saleLike) {
  return {
    earnedPoints: getSalePoints(saleLike?.total),
    redeemedPoints: normalizeRedeemPoints(saleLike?.loyaltyRedeemedPoints),
    redeemedAmount: toMoney(saleLike?.loyaltyRedeemedAmount),
  };
}

function normalizePaymentMode(mode) {
  const value = String(mode || "cash").trim().toLowerCase();
  return ["cash", "upi", "card", "split", "credit"].includes(value) ? value : "cash";
}

async function logBackupEvent(action, status, message = "", backupPath = "") {
  try {
    await run(
      "INSERT INTO backup_logs(action, status, message, backup_path, created_at) VALUES(?,?,?,?,?)",
      [
        String(action || "").trim(),
        String(status || "").trim(),
        String(message || "").trim(),
        String(backupPath || "").trim(),
        getLocalTimestamp(),
      ],
    );
  } catch (err) {
    console.error("backup_logs insert failed:", err?.message || err);
  }
}

function normalizeActor(actor) {
  const value = String(actor || "").trim();
  return value ? value.slice(0, 120) : "system";
}

async function logAuditEvent(action, status, actor = "system", target = "", message = "") {
  try {
    await run(
      "INSERT INTO audit_logs(action, status, actor, target, message, created_at) VALUES(?,?,?,?,?,?)",
      [
        String(action || "").trim(),
        String(status || "").trim(),
        normalizeActor(actor),
        String(target || "").trim().slice(0, 180),
        String(message || "").trim(),
        getLocalTimestamp(),
      ],
    );
  } catch (err) {
    console.error("audit_logs insert failed:", err?.message || err);
  }
}

async function getAdminPin() {
  const row = await get("SELECT value FROM settings WHERE key = 'admin_pin'");
  if (!row || !row.value) {
    await run("INSERT OR REPLACE INTO settings(key, value) VALUES('admin_pin', '1234')");
    return "1234";
  }
  return String(row.value);
}

async function getSettingValue(key, fallback = "") {
  const row = await get("SELECT value FROM settings WHERE key = ?", [String(key)]);
  if (!row || row.value === null || row.value === undefined || row.value === "") {
    return fallback;
  }
  return String(row.value);
}

async function setSettingValue(key, value) {
  await run("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", [String(key), String(value ?? "")]);
}

async function getStoreSettings() {
  return {
    storeName: await getSettingValue("store_name", "GSM SUPER MARKET"),
    storeAddress: await getSettingValue("store_address", ""),
    storePhone: await getSettingValue("store_phone", ""),
    storeGstin: await getSettingValue("store_gstin", ""),
    receiptFooter: await getSettingValue("store_receipt_footer", "*** THANK YOU ðŸ™ VISIT AGAIN ***"),
    receiptTnc: await getSettingValue("store_receipt_tnc", "*.Items Are Exchanged Within 7 Days"),
    logoPath: await getSettingValue("store_logo_path", ""),
    appLanguage: await getSettingValue("app_language", "en"),
    upiVpa: await getSettingValue("store_upi_vpa", ""),
  };
}

async function getHardwareSettings() {
  return {
    defaultPrintMode: await getSettingValue("hardware_default_print_mode", "thermal"),
    thermalPrinterDevice: await getSettingValue("hardware_thermal_printer_device", ""),
    thermalPrinterWidth: await getSettingValue("hardware_thermal_printer_width", "80mm"),
    barcodeLabelFormat: await getSettingValue("hardware_barcode_label_format", "3-across"),
    scannerSubmitMode: await getSettingValue("hardware_scanner_submit_mode", "enter"),
    scannerFocusLock: (await getSettingValue("hardware_scanner_focus_lock", "0")) === "1",
    customerDisplayEnabled: (await getSettingValue("hardware_customer_display_enabled", "0")) === "1",
    customerDisplayAutoOpen: (await getSettingValue("hardware_customer_display_auto_open", "0")) === "1",
    customerDisplayX: await getSettingValue("hardware_customer_display_x", ""),
    customerDisplayY: await getSettingValue("hardware_customer_display_y", ""),
    customerDisplayWidth: await getSettingValue("hardware_customer_display_width", "900"),
    customerDisplayHeight: await getSettingValue("hardware_customer_display_height", "540"),
    customerDisplayFullscreen: (await getSettingValue("hardware_customer_display_fullscreen", "0")) === "1",
    cashDrawerEnabled: (await getSettingValue("hardware_cash_drawer_enabled", "0")) === "1",
    cashDrawerCommand: await getSettingValue("hardware_cash_drawer_command", ""),
    cashDrawerOnCashSale: (await getSettingValue("hardware_cash_drawer_on_cash_sale", "0")) === "1",
    uiFontSize: await getSettingValue("hardware_ui_font_size", "normal"),
  };
}

function safeJsonStringify(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? {});
  } catch (_err) {
    return fallback;
  }
}

async function enqueueSync(entityType, actionType, entityId = "", payload = {}) {
  try {
    const now = getLocalTimestamp();
    await run(
      `INSERT INTO sync_queue(
        entity_type, action_type, entity_id, payload_json, status, retry_count, last_error, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        String(entityType || "").trim().slice(0, 80),
        String(actionType || "").trim().slice(0, 80),
        String(entityId || "").trim().slice(0, 120),
        safeJsonStringify(payload),
        "pending",
        0,
        "",
        now,
        now,
      ],
    );
  } catch (err) {
    console.error("sync_queue insert failed:", err?.message || err);
  }
}

function parseFlexibleDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct;

  const normalized = text.includes(" ") && /^\d{4}-\d{2}-\d{2}\s/.test(text)
    ? new Date(text.replace(" ", "T"))
    : null;
  if (normalized && !Number.isNaN(normalized.getTime())) return normalized;

  return null;
}

async function getReorderSuggestionsData({ days = 14, targetDays = 10 } = {}) {
  const windowDays = Math.max(3, Math.min(60, Number(days || 14)));
  const coverageDays = Math.max(5, Math.min(45, Number(targetDays || 10)));
  const products = await all(
    `SELECT p.id, p.name, p.barcode, p.stock, p.cost_price AS costPrice,
            COALESCE(c.name, '') AS categoryName
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE COALESCE(p.is_archived, 0) = 0
     ORDER BY p.name COLLATE NOCASE ASC`,
  );
  const salesRows = await all(
    `SELECT si.product_id AS productId, si.qty, s.date
     FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id`,
  );

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (windowDays - 1));

  const soldMap = new Map();
  const distinctDaysMap = new Map();
  for (const row of Array.isArray(salesRows) ? salesRows : []) {
    const productId = Number(row.productId || 0);
    if (!productId) continue;
    const soldAt = parseFlexibleDate(row.date);
    if (!soldAt || soldAt < cutoff) continue;
    soldMap.set(productId, Number(soldMap.get(productId) || 0) + Number(row.qty || 0));
    const dayKey = getDateKey(soldAt);
    const set = distinctDaysMap.get(productId) || new Set();
    set.add(dayKey);
    distinctDaysMap.set(productId, set);
  }

  return (Array.isArray(products) ? products : [])
    .map((product) => {
      const productId = Number(product.id || 0);
      const stock = Number(product.stock || 0);
      const soldWindow = Number(soldMap.get(productId) || 0);
      const activeDays = Number(distinctDaysMap.get(productId)?.size || 0);
      const avgDailySales = soldWindow > 0 ? soldWindow / windowDays : 0;
      const daysOfCover = avgDailySales > 0 ? stock / avgDailySales : null;
      const reorderLevel = Math.max(5, Math.ceil(avgDailySales * 4));
      const targetStock = avgDailySales > 0 ? Math.ceil(avgDailySales * coverageDays) : 8;
      const suggestedOrder = Math.max(0, targetStock - stock);
      const needsReorder =
        stock <= 0 ||
        stock <= reorderLevel ||
        (daysOfCover !== null && daysOfCover <= 5) ||
        (avgDailySales === 0 && stock <= 5);

      return {
        id: productId,
        name: String(product.name || ""),
        barcode: String(product.barcode || ""),
        categoryName: String(product.categoryName || ""),
        stock,
        soldWindow,
        activeDays,
        avgDailySales: Number(avgDailySales.toFixed(2)),
        daysOfCover: daysOfCover === null ? null : Number(daysOfCover.toFixed(1)),
        reorderLevel,
        suggestedOrder,
        needsReorder,
      };
    })
    .filter((row) => row.needsReorder)
    .sort((a, b) => {
      const coverA = a.daysOfCover === null ? Number.POSITIVE_INFINITY : a.daysOfCover;
      const coverB = b.daysOfCover === null ? Number.POSITIVE_INFINITY : b.daysOfCover;
      return a.stock - b.stock || coverA - coverB || b.avgDailySales - a.avgDailySales || a.name.localeCompare(b.name);
    });
}

function buildCustomerDisplayHtml(payload = {}) {
  const title = String(payload.title || "Customer Display");
  const storeName = String(payload.storeName || "BillSwift POS");
  const headline = String(payload.headline || "Welcome");
  const subline = String(payload.subline || "Ready for billing");
  const totalText = String(payload.totalText || "Rs. 0.00");
  const itemsText = String(payload.itemsText || "0 items");
  const savingsText = String(payload.savingsText || "");
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${escHtml(title)}</title>
  <style>
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      background: linear-gradient(180deg, #071f3b 0%, #0b63b6 70%, #0f77d6 100%);
      color: #fff;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
    }
    .card {
      width: min(92vw, 860px);
      border-radius: 24px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.16);
      box-shadow: 0 24px 70px rgba(0,0,0,0.28);
      padding: 34px;
      text-align: center;
      backdrop-filter: blur(6px);
    }
    .store { font-size: 20px; letter-spacing: 0.8px; opacity: 0.88; margin-bottom: 16px; }
    .headline { font-size: 54px; font-weight: 800; margin-bottom: 10px; }
    .subline { font-size: 24px; opacity: 0.92; margin-bottom: 30px; }
    .total { font-size: 80px; font-weight: 900; letter-spacing: 1px; }
    .meta { margin-top: 22px; display: flex; justify-content: center; gap: 22px; flex-wrap: wrap; font-size: 22px; opacity: 0.95; }
    .pill { border-radius: 999px; padding: 10px 18px; background: rgba(255,255,255,0.12); }
  </style>
</head>
<body>
  <div class="card">
    <div class="store">${escHtml(storeName)}</div>
    <div class="headline">${escHtml(headline)}</div>
    <div class="subline">${escHtml(subline)}</div>
    <div class="total">${escHtml(totalText)}</div>
    <div class="meta">
      <div class="pill">${escHtml(itemsText)}</div>
      ${savingsText ? `<div class="pill">${escHtml(savingsText)}</div>` : ""}
    </div>
  </div>
</body>
</html>`;
}

function buildMobileCompanionHtml(payload = {}) {
  const title = String(payload.title || "BillSwift Mobile");
  const storeName = String(payload.storeName || "GSM SUPER MARKET");
  const headline = String(payload.headline || "Live Snapshot");
  const subline = String(payload.subline || "Companion view");
  const primaryValue = String(payload.primaryValue || "Rs. 0.00");
  const secondaryValue = String(payload.secondaryValue || "");
  const chips = Array.isArray(payload.chips) ? payload.chips.filter(Boolean).slice(0, 4) : [];
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${escHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      background: linear-gradient(180deg, #071a2f 0%, #0b63b6 100%);
      color: #fff;
      min-height: 100vh;
    }
    .shell {
      padding: 18px 16px 24px;
    }
    .store {
      font-size: 12px;
      letter-spacing: 1px;
      text-transform: uppercase;
      opacity: 0.84;
      margin-bottom: 10px;
    }
    .card {
      border-radius: 22px;
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.18);
      padding: 18px 16px;
      box-shadow: 0 16px 42px rgba(0,0,0,0.25);
      backdrop-filter: blur(6px);
    }
    .headline {
      font-size: 28px;
      font-weight: 800;
      margin-bottom: 6px;
    }
    .subline {
      font-size: 14px;
      opacity: 0.9;
      margin-bottom: 18px;
    }
    .primary {
      font-size: 44px;
      font-weight: 900;
      line-height: 1.05;
      margin-bottom: 8px;
    }
    .secondary {
      font-size: 16px;
      opacity: 0.92;
      margin-bottom: 14px;
    }
    .chips {
      display: grid;
      gap: 8px;
    }
    .chip {
      border-radius: 14px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.14);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="store">${escHtml(storeName)}</div>
    <div class="card">
      <div class="headline">${escHtml(headline)}</div>
      <div class="subline">${escHtml(subline)}</div>
      <div class="primary">${escHtml(primaryValue)}</div>
      <div class="secondary">${escHtml(secondaryValue)}</div>
      <div class="chips">
        ${chips.map((chip) => `<div class="chip">${escHtml(String(chip))}</div>`).join("")}
      </div>
      ${remoteCompanionUrl ? `
      <div style="margin-top:20px;text-align:center;font-size:14px;opacity:0.9;background:rgba(0,0,0,0.25);padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,0.1);">
        <div style="margin-bottom:8px;font-weight:600;letter-spacing:0.5px;">🌍 LIVE REMOTE LINK</div>
        <div style="font-family:monospace;color:#60baff;word-break:break-all;font-size:16px;">
          ${escHtml(remoteCompanionUrl)}
        </div>
        <div style="font-size:12px;margin-top:8px;opacity:0.75;">Open this on your mobile browser anywhere</div>
      </div>
      ` : `
      <div style="margin-top:20px;text-align:center;font-size:13px;opacity:0.6;background:rgba(0,0,0,0.2);padding:10px;border-radius:8px;">
        Starting remote server... (Click any button to refresh link)
      </div>
      `}
    </div>
  </div>
</body>
</html>`;
}

async function setWindowHtml(win, html) {
  if (!win || win.isDestroyed()) return;
  await win.loadURL("about:blank").catch(() => {});
  const htmlJson = JSON.stringify(String(html || ""));
  await win.webContents.executeJavaScript(
    `
      document.open();
      document.write(${htmlJson});
      document.close();
    `,
    true,
  );
}

async function ensureCustomerDisplayWindow() {
  if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
    return customerDisplayWindow;
  }

  const settings = await getHardwareSettings();
  const width = Math.max(420, Number(settings.customerDisplayWidth || 900));
  const height = Math.max(260, Number(settings.customerDisplayHeight || 540));
  const x = String(settings.customerDisplayX || "").trim();
  const y = String(settings.customerDisplayY || "").trim();
  const options = {
    width,
    height,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#0b63b6",
    title: "Customer Display",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  };
  if (x !== "" && y !== "" && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    options.x = Number(x);
    options.y = Number(y);
  }

  customerDisplayWindow = new BrowserWindow(options);

  customerDisplayWindow.on("closed", () => {
    customerDisplayWindow = null;
  });

  await setWindowHtml(customerDisplayWindow, buildCustomerDisplayHtml());
  if (settings.customerDisplayFullscreen) {
    customerDisplayWindow.setFullScreen(true);
  }
  return customerDisplayWindow;
}

async function updateCustomerDisplay(payload = {}, { forceShow = false } = {}) {
  const settings = await getHardwareSettings();
  if (!settings.customerDisplayEnabled && !forceShow) {
    return { ok: true, mode: "disabled" };
  }
  const storeSettings = await getStoreSettings();
  const win = await ensureCustomerDisplayWindow();
  const html = buildCustomerDisplayHtml({
    title: "Customer Display",
    storeName: String(payload?.storeName || storeSettings.storeName || "GSM SUPER MARKET"),
    ...payload,
  });
  await setWindowHtml(win, html);
  if (forceShow || settings.customerDisplayAutoOpen) {
    win.show();
  }
  return { ok: true };
}

async function closeCustomerDisplay() {
  if (customerDisplayWindow && !customerDisplayWindow.isDestroyed()) {
    customerDisplayWindow.close();
  }
  customerDisplayWindow = null;
  return { ok: true };
}

async function ensureMobileCompanionWindow() {
  if (mobileCompanionWindow && !mobileCompanionWindow.isDestroyed()) {
    return mobileCompanionWindow;
  }

  mobileCompanionWindow = new BrowserWindow({
    width: 430,
    height: 820,
    minWidth: 360,
    minHeight: 640,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#0b63b6",
    title: "BillSwift Mobile Companion",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  });

  mobileCompanionWindow.on("closed", () => {
    mobileCompanionWindow = null;
  });

  await setWindowHtml(mobileCompanionWindow, buildMobileCompanionHtml());
  return mobileCompanionWindow;
}

async function updateMobileCompanion(payload = {}, { forceShow = false } = {}) {
  startRemoteCompanionServer();
  const storeSettings = await getStoreSettings();
  const win = await ensureMobileCompanionWindow();
  const html = buildMobileCompanionHtml({
    storeName: String(payload?.storeName || storeSettings.storeName || "GSM SUPER MARKET"),
    ...payload,
  });
  latestCompanionHtml = html;
  await setWindowHtml(win, html);
  if (forceShow) win.show();
  return { ok: true };
}

async function closeMobileCompanion() {
  if (mobileCompanionWindow && !mobileCompanionWindow.isDestroyed()) {
    mobileCompanionWindow.close();
  }
  mobileCompanionWindow = null;
  return { ok: true };
}

async function ensureCategoryByName(categoryNameRaw) {
  const categoryName = String(categoryNameRaw || "").trim();
  if (!categoryName) return null;

  const existing = await get("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", [categoryName]);
  if (existing?.id) return Number(existing.id);

  const inserted = await run("INSERT INTO categories(name) VALUES(?)", [categoryName]);
  return Number(inserted.lastID);
}

async function getNextPurchaseInvoiceNo() {
  const row = await get("SELECT id FROM purchases ORDER BY id DESC LIMIT 1");
  const next = Number(row?.id || 0) + 1;
  return String(next).padStart(2, "0");
}

function normalizeBatchNo(value) {
  return String(value || "").trim().slice(0, 80);
}

function normalizeExpiryDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

async function normalizePurchaseItems(items) {
  const normalized = [];
  let total = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const productId = Number(item?.productId);
    const qty = Number(item?.qty);
    const freeUnits = Math.max(0, Number(item?.freeUnits || 0));
    const costPrice = Number(item?.costPrice);
    const mrp = Math.max(0, Number(item?.mrp || 0));
    const gstPct = Math.max(0, Number(item?.gstPct || 0));
    const rateType = String(item?.rateType || "exclusive").toLowerCase() === "inclusive" ? "inclusive" : "exclusive";
    const batchNo = normalizeBatchNo(item?.batchNo);
    const expiryDate = normalizeExpiryDate(item?.expiryDate);

    if (!Number.isFinite(productId) || productId <= 0) {
      throw new Error("Invalid product in purchase items");
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error("Purchase quantity must be greater than 0");
    }
    if (!Number.isFinite(costPrice) || costPrice < 0) {
      throw new Error("Cost price must be valid");
    }
    if (String(item?.expiryDate || "").trim() && !expiryDate) {
      throw new Error("Expiry date must be in YYYY-MM-DD format");
    }

    // Calculate basic (taxable) amount:
    // Inclusive: cost price includes GST â†’ basic = costPrice Ã— 100/(100+gst)
    // Exclusive: cost price is pre-GST â†’ basic = costPrice
    const basicRate = rateType === "inclusive" && gstPct > 0
      ? costPrice * 100 / (100 + gstPct)
      : costPrice;
    const basicAmount = qty * basicRate;
    const lineTotal = qty * costPrice; // billed amount (inclusive of GST if inclusive)

    total += lineTotal;
    normalized.push({
      productId,
      qty,
      freeUnits,
      costPrice,
      mrp,
      gstPct,
      rateType,
      basicAmount,
      batchNo,
      expiryDate,
    });
  }

  return { items: normalized, total };
}

async function insertInventoryBatch({ purchaseId, purchaseItemId, supplierId, product, item }) {
  await run(
    `INSERT INTO inventory_batches(
       purchase_id, purchase_item_id, product_id, product_name, barcode, supplier_id,
       batch_no, expiry_date, qty_received, qty_returned, cost_price, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      purchaseId,
      purchaseItemId,
      Number(product.id),
      String(product.name || ""),
      String(product.barcode || ""),
      supplierId,
      String(item.batchNo || ""),
      String(item.expiryDate || ""),
      Number(item.qty || 0),
      0,
      Number(item.costPrice || 0),
      getLocalTimestamp(),
      getLocalTimestamp(),
    ],
  );
}

async function buildSupplierStatement(supplierId) {
  const supplier = await get(
    "SELECT id, name, phone, gstin, category, hsn_code AS hsnCode, address, COALESCE(is_active, 1) AS isActive, created_at AS createdAt FROM suppliers WHERE id = ?",
    [supplierId],
  );
  if (!supplier) throw new Error("Supplier not found");

  const purchases = await all(
    `SELECT
        p.id,
        p.invoice_no AS invoiceNo,
        p.total,
        p.notes,
        p.created_at AS createdAt,
        COALESCE(SUM(pr.return_total), 0) AS returnedTotal,
        COUNT(pr.id) AS returnCount
     FROM purchases p
     LEFT JOIN purchase_returns pr ON pr.original_purchase_id = p.id
     WHERE p.supplier_id = ?
     GROUP BY p.id, p.invoice_no, p.total, p.notes, p.created_at
     ORDER BY p.id DESC`,
    [supplierId],
  );

  const stats = await get(
    `SELECT
        COUNT(*) AS purchaseCount,
        COALESCE(SUM(total), 0) AS grossSpend,
        COALESCE((
          SELECT SUM(return_total)
          FROM purchase_returns
          WHERE supplier_id = ?
        ), 0) AS returnedAmount
     FROM purchases
     WHERE supplier_id = ?`,
    [supplierId, supplierId],
  );

  return {
    supplier: {
      id: Number(supplier.id),
      name: String(supplier.name || ""),
      phone: String(supplier.phone || ""),
      gstin: String(supplier.gstin || ""),
      category: String(supplier.category || ""),
      hsnCode: String(supplier.hsnCode || ""),
      address: String(supplier.address || ""),
      isActive: Number(supplier.isActive ?? 1),
      createdAt: String(supplier.createdAt || ""),
    },
    stats: {
      purchaseCount: Number(stats?.purchaseCount || 0),
      grossSpend: toMoney(stats?.grossSpend),
      returnedAmount: toMoney(stats?.returnedAmount),
      netSpend: Math.max(0, toMoney(stats?.grossSpend) - toMoney(stats?.returnedAmount)),
    },
    purchases: Array.isArray(purchases)
      ? purchases.map((row) => ({
          id: Number(row.id),
          invoiceNo: String(row.invoiceNo || ""),
          total: toMoney(row.total),
          notes: String(row.notes || ""),
          createdAt: String(row.createdAt || ""),
          returnedTotal: toMoney(row.returnedTotal),
          returnCount: Number(row.returnCount || 0),
          netTotal: Math.max(0, toMoney(row.total) - toMoney(row.returnedTotal)),
        }))
      : [],
  };
}

function isExpiredDate(expiryDate) {
  const text = String(expiryDate || "").trim();
  if (!text) return false;
  const today = new Date();
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return text < todayText;
}

function getMarkdownPercentForExpiry(expiryDate) {
  const text = String(expiryDate || "").trim();
  if (!text || isExpiredDate(text)) return 0;
  const daysLeft = Math.floor(
    (new Date(`${text}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  );
  if (daysLeft <= 3) return 20;
  if (daysLeft <= 7) return 10;
  return 0;
}

async function getBatchRowsForProduct(productId, { includeExpired = false } = {}) {
  const rows = await all(
    `SELECT id, product_id AS productId, product_name AS productName, barcode, batch_no AS batchNo,
            expiry_date AS expiryDate, cost_price AS costPrice,
            COALESCE(qty_received, 0) AS qtyReceived,
            COALESCE(qty_returned, 0) AS qtyReturned,
            COALESCE(qty_sold, 0) AS qtySold
     FROM inventory_batches
     WHERE product_id = ?
     ORDER BY julianday(COALESCE(NULLIF(expiry_date, ''), '2999-12-31')) ASC, id ASC`,
    [productId],
  );

  return Array.isArray(rows)
    ? rows
        .map((row) => ({
          id: Number(row.id),
          productId: Number(row.productId),
          productName: String(row.productName || ""),
          barcode: String(row.barcode || ""),
          batchNo: String(row.batchNo || ""),
          expiryDate: String(row.expiryDate || ""),
          costPrice: toMoney(row.costPrice),
          qtyReceived: Number(row.qtyReceived || 0),
          qtyReturned: Number(row.qtyReturned || 0),
          qtySold: Number(row.qtySold || 0),
          availableQty: Number(row.qtyReceived || 0) - Number(row.qtyReturned || 0) - Number(row.qtySold || 0),
        }))
        .filter((row) => row.availableQty > 0 && (includeExpired || !isExpiredDate(row.expiryDate)))
    : [];
}

async function getBatchAvailabilitySummary(productId) {
  const allRows = await getBatchRowsForProduct(productId, { includeExpired: true });
  const validRows = allRows.filter((row) => !isExpiredDate(row.expiryDate));
  const expiredRows = allRows.filter((row) => isExpiredDate(row.expiryDate));
  const nearExpiryRows = validRows.filter((row) => {
    if (!row.expiryDate) return false;
    const daysLeft = Math.floor((new Date(`${row.expiryDate}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000);
    return daysLeft >= 0 && daysLeft <= 7;
  });
  const nearExpiryMinDays = nearExpiryRows.length
    ? Math.min(
        ...nearExpiryRows.map((row) =>
          Math.floor((new Date(`${row.expiryDate}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000),
        ),
      )
    : null;
  const suggestedDiscountPercent =
    nearExpiryMinDays === null ? 0 : nearExpiryMinDays <= 3 ? 20 : nearExpiryMinDays <= 7 ? 10 : 0;

  return {
    hasBatchTracking: allRows.length > 0,
    validBatchQty: validRows.reduce((sum, row) => sum + row.availableQty, 0),
    expiredBatchQty: expiredRows.reduce((sum, row) => sum + row.availableQty, 0),
    nearExpiryQty: nearExpiryRows.reduce((sum, row) => sum + row.availableQty, 0),
    nearExpiryMinDays,
    suggestedDiscountPercent,
  };
}

async function allocateSaleItemBatches(saleId, saleItemId, productId, qty, preferredBatchId = null) {
  let rows = await getBatchRowsForProduct(productId, { includeExpired: false });
  if (!rows.length) {
    return { usedBatches: false, allocations: [] };
  }

  if (Number.isFinite(Number(preferredBatchId)) && Number(preferredBatchId) > 0) {
    const preferredId = Number(preferredBatchId);
    const preferred = rows.find((row) => Number(row.id) === preferredId);
    if (!preferred) {
      throw new Error("Selected batch is not available");
    }
    if (Number(preferred.availableQty || 0) < Number(qty || 0)) {
      // throw new Error("Selected batch does not have enough stock");
    }
    rows = [preferred];
  }

  let remaining = Number(qty || 0);
  const allocations = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    // Allow allocating more than available if it's the only way, to support negative stock
    const takeQty = remaining;

    await run(
      "UPDATE inventory_batches SET qty_sold = COALESCE(qty_sold, 0) + ?, updated_at = ? WHERE id = ?",
      [takeQty, getLocalTimestamp(), row.id],
    );
    await run(
      "INSERT INTO sale_item_batches(sale_id, sale_item_id, product_id, inventory_batch_id, qty, created_at) VALUES(?,?,?,?,?,?)",
      [saleId, saleItemId, productId, row.id, takeQty, getLocalTimestamp()],
    );
    allocations.push({
      inventoryBatchId: row.id,
      batchNo: row.batchNo,
      expiryDate: row.expiryDate,
      qty: takeQty,
    });
    remaining -= takeQty;
  }

  if (remaining > 0) {
    // Warning: Could not allocate all quantities to existing batches. Global stock will still decrease.
  }

  return { usedBatches: true, allocations };
}

async function releaseSaleBatchAllocations(saleId) {
  const rows = await all(
    `SELECT inventory_batch_id AS inventoryBatchId, COALESCE(qty, 0) AS qty
     FROM sale_item_batches
     WHERE sale_id = ?`,
    [saleId],
  );

  for (const row of Array.isArray(rows) ? rows : []) {
    await run(
      `UPDATE inventory_batches
       SET qty_sold = CASE WHEN COALESCE(qty_sold, 0) >= ? THEN COALESCE(qty_sold, 0) - ? ELSE 0 END,
           updated_at = ?
       WHERE id = ?`,
      [row.qty, row.qty, getLocalTimestamp(), row.inventoryBatchId],
    );
  }

  await run("DELETE FROM sale_item_batches WHERE sale_id = ?", [saleId]);
}

async function reduceSaleBatchAllocationsForProduct(saleId, productId, returnQty) {
  let remaining = Math.max(0, Number(returnQty || 0));
  if (!remaining) return;

  const rows = await all(
    `SELECT sib.id, sib.qty, sib.inventory_batch_id AS batchId
     FROM sale_item_batches sib
     JOIN sale_items si ON si.id = sib.sale_item_id
     WHERE sib.sale_id = ? AND si.product_id = ?
     ORDER BY sib.id ASC`,
    [saleId, productId],
  );

  for (const row of Array.isArray(rows) ? rows : []) {
    if (remaining <= 0) break;
    const available = Number(row.qty || 0);
    if (available <= 0) continue;
    const consume = Math.min(available, remaining);
    await run(
      `UPDATE inventory_batches
       SET qty_sold = CASE WHEN COALESCE(qty_sold, 0) >= ? THEN COALESCE(qty_sold, 0) - ? ELSE 0 END,
           updated_at = ?
       WHERE id = ?`,
      [consume, consume, getLocalTimestamp(), row.batchId],
    );
    const newQty = available - consume;
    if (newQty <= 0) {
      await run("DELETE FROM sale_item_batches WHERE id = ?", [row.id]);
    } else {
      await run("UPDATE sale_item_batches SET qty = ? WHERE id = ?", [newQty, row.id]);
    }
    remaining -= consume;
  }
}

async function getSaleItemsDetailed(saleId) {
  const saleItems = await all(
    `SELECT si.id AS saleItemId, si.product_id AS productId, si.product_name AS productName, si.price, si.qty,
            COALESCE(si.gst_percent, 0) AS gstPercent, COALESCE(si.hsn_code, '') AS hsnCode,
            COALESCE(p.unit, 'pcs') AS unit,
            COALESCE(p.pack_size_value, 0) AS packSizeValue,
            COALESCE(p.pack_size_unit, '') AS packSizeUnit,
            COALESCE(NULLIF(si.mrp, 0), p.mrp, si.price) AS mrp
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ?
     ORDER BY si.id ASC`,
    [saleId],
  );

  if (!Array.isArray(saleItems) || saleItems.length === 0) return [];

  const allocations = await all(
    `SELECT sib.sale_item_id AS saleItemId, sib.inventory_batch_id AS batchId, sib.qty,
            COALESCE(ib.batch_no, '') AS batchNo, COALESCE(ib.expiry_date, '') AS expiryDate
     FROM sale_item_batches sib
     LEFT JOIN inventory_batches ib ON ib.id = sib.inventory_batch_id
     WHERE sib.sale_id = ?
     ORDER BY sib.sale_item_id ASC, sib.id ASC`,
    [saleId],
  );

  const allocationMap = new Map();
  for (const row of Array.isArray(allocations) ? allocations : []) {
    const key = Number(row.saleItemId);
    if (!allocationMap.has(key)) allocationMap.set(key, []);
    allocationMap.get(key).push({
      batchId: Number(row.batchId || 0),
      qty: Number(row.qty || 0),
      batchNo: String(row.batchNo || ""),
      expiryDate: String(row.expiryDate || ""),
    });
  }

  const detailedItems = [];
  for (const item of saleItems) {
    const base = {
      id: Number(item.productId),
      name: String(item.productName || ""),
      price: toMoney(item.price),
      originalPrice: toMoney(item.price),
      gstPercent: toMoney(item.gstPercent),
      hsnCode: String(item.hsnCode || ""),
      unit: String(item.unit || "pcs"),
      packSizeValue: Number(item.packSizeValue || 0),
      packSizeUnit: String(item.packSizeUnit || ""),
      mrp: Number(item.mrp || item.price || 0),
    };
    const batches = allocationMap.get(Number(item.saleItemId)) || [];
    if (batches.length) {
      let allocatedQty = 0;
      batches.forEach((batch, idx) => {
        const qty = Number(batch.qty || 0);
        allocatedQty += qty;
        detailedItems.push({
          ...base,
          qty,
          lineId: Number(`${item.saleItemId}${String(idx + 1).padStart(2, "0")}`),
          preferredBatchId: Number(batch.batchId || 0) || null,
          batchNo: String(batch.batchNo || ""),
          expiryDate: String(batch.expiryDate || ""),
          markdownPercent: getMarkdownPercentForExpiry(batch.expiryDate),
          hasBatchTracking: true,
          batchAvailableQty: qty,
        });
      });

      const leftoverQty = Math.max(0, Number(item.qty || 0) - allocatedQty);
      if (leftoverQty > 0) {
        detailedItems.push({
          ...base,
          qty: leftoverQty,
          lineId: Number(`${item.saleItemId}99`),
          preferredBatchId: null,
          batchNo: "",
          expiryDate: "",
          markdownPercent: 0,
          hasBatchTracking: false,
          batchAvailableQty: 0,
        });
      }
    } else {
      detailedItems.push({
        ...base,
        qty: Number(item.qty || 0),
        lineId: Number(`${item.saleItemId}00`),
        preferredBatchId: null,
        batchNo: "",
        expiryDate: "",
        markdownPercent: 0,
        hasBatchTracking: false,
        batchAvailableQty: 0,
      });
    }
  }

  return detailedItems;
}

ipcMain.on("alert-sync", (event, message) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const opts = {
    type: "info",
    message: String(message),
    title: "Alert"
  };
  if (win) dialog.showMessageBoxSync(win, opts);
  else dialog.showMessageBoxSync(opts);
  event.returnValue = true;
});

ipcMain.on("confirm-sync", (event, message) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const opts = {
    type: "question",
    buttons: ["OK", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: String(message),
    title: "Confirm"
  };
  const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
  event.returnValue = choice === 0;
});

ipcMain.handle("login", async (_event, payload) => {
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "").trim();

  if (!username || !password) {
    await logAuditEvent("login", "failed", username || "unknown", "", "Missing username or password");
    throw new Error("Username and password are required");
  }

  const setupComplete = (await getSettingValue("setup_complete", "0")) === "1";
  if (!setupComplete) {
    await logAuditEvent("login", "failed", username, "", "Setup not completed");
    throw new Error("Complete first-time setup before login");
  }

  await ensureDefaultUsers();
  const user = await get(
    "SELECT id, username, role FROM users WHERE LOWER(username) = LOWER(?) AND password = ?",
    [username, password],
  );

  if (!user) {
    await logAuditEvent("login", "failed", username, "", "Invalid username or password");
    throw new Error("Invalid username or password");
  }

  await logAuditEvent("login", "success", user.username, user.role, "User logged in");

  return {
    id: Number(user.id),
    username: String(user.username),
    role: String(user.role),
  };
});

ipcMain.handle("get-setup-status", async () => {
  const value = await getSettingValue("setup_complete", "0");
  if (value === "1") return true;
  // If users already exist in DB, treat setup as complete and fix the flag
  try {
    const userCount = await get("SELECT COUNT(*) AS cnt FROM users");
    if (Number(userCount?.cnt) > 0) {
      await setSettingValue("setup_complete", "1");
      return true;
    }
  } catch (_e) {}
  return false;
});

ipcMain.handle("set-setup-complete", async () => {
  await setSettingValue("setup_complete", "1");
  return true;
});

ipcMain.handle("create-user", async (_event, payload) => {
  const username = String(payload?.username || "").trim().toLowerCase();
  const password = String(payload?.password || "").trim();
  const role = String(payload?.role || "").trim().toLowerCase();
  const performedBy = normalizeActor(payload?.performedBy);

  try {
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
      throw new Error("Username must be 3-30 chars (a-z, 0-9, . _ -)");
    }
    if (!password || password.length < 4 || password.length > 50) {
      throw new Error("Password must be 4-50 characters");
    }
    if (!["admin", "cashier"].includes(role)) {
      throw new Error("Role must be admin or cashier");
    }

    const exists = await get("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", [username]);
    if (exists) throw new Error("Username already exists");

    await run("INSERT INTO users(username, password, role) VALUES(?,?,?)", [username, password, role]);
    await logAuditEvent("user_create", "success", performedBy, username, `Role: ${role}`);
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "user_create",
      "failed",
      performedBy,
      username,
      err?.message || "Create user failed",
    );
    throw err;
  }
});

ipcMain.handle("get-users", async () => {
  return all(
    "SELECT id, username, role, created_at AS createdAt FROM users ORDER BY id DESC",
  );
});

ipcMain.handle("delete-user", async (_event, payload) => {
  const userId = Number(payload?.userId);
  const performedBy = normalizeActor(payload?.performedBy);
  if (!Number.isFinite(userId) || userId <= 0) throw new Error("Invalid user id");

  try {
    const user = await get("SELECT id, username, role FROM users WHERE id = ?", [userId]);
    if (!user) throw new Error("User not found");

    if (String(user.role) === "admin") {
      const row = await get("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'");
      const adminCount = Number(row?.total || 0);
      if (adminCount <= 1) {
        throw new Error("Cannot delete the last admin user");
      }
    }

    await run("DELETE FROM users WHERE id = ?", [userId]);
    await logAuditEvent(
      "user_delete",
      "success",
      performedBy,
      String(user.username || userId),
      `Deleted role: ${user.role}`,
    );
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "user_delete",
      "failed",
      performedBy,
      String(userId),
      err?.message || "Delete user failed",
    );
    throw err;
  }
});

ipcMain.handle("add-product", async (_event, data) => {
  const name = String(data?.name || "").trim();
  const barcode = String(data?.barcode || "").trim();
  const price = Number(data?.price);
  const stock = Number(data?.stock);
  const unit = String(data?.unit || "").trim() || "pcs";
  const packSizeValueRaw = Number(data?.packSizeValue ?? data?.pack_size_value ?? 0);
  const packSizeValue = Number.isFinite(packSizeValueRaw) ? packSizeValueRaw : NaN;
  const packSizeUnit = String(data?.packSizeUnit ?? data?.pack_size_unit ?? "").trim();
  const categoryName = String(data?.categoryName || "").trim();
  const hsnCode = String(data?.hsnCode ?? data?.hsn_code ?? "").trim();
  const gstPercent = Number(
    data?.gstPercent ?? data?.gst_percent ?? 0,
  );
  const costPrice = Number(data?.costPrice ?? data?.cost_price ?? 0);
  const mrp = Number(data?.mrp ?? 0);
  const salesPriceTaxInclusive = data?.salesPriceTaxInclusive === "No" || data?.salesPriceTaxInclusive === false || data?.salesPriceTaxInclusive === 0 ? 0 : 1;
  const mrpTaxInclusive = data?.mrpTaxInclusive === "No" || data?.mrpTaxInclusive === false || data?.mrpTaxInclusive === 0 ? 0 : 1;
  const performedBy = normalizeActor(data?.performedBy);

  try {
    if (!name || !barcode || !Number.isFinite(price) || !Number.isFinite(stock)) {
      throw new Error("Invalid product data");
    }
    if (price < 0 || stock < 0) {
      throw new Error("Price and stock cannot be negative");
    }
    if (price < 0 || stock < 0) {
      throw new Error("Price and stock cannot be negative");
    }
    if (unit.length > 12) {
      throw new Error("Unit is too long");
    }
    if (!Number.isFinite(packSizeValue) || packSizeValue < 0) {
      throw new Error("Invalid pack size value");
    }
    if (packSizeValue > 0 && !packSizeUnit) {
      throw new Error("Pack size unit is required");
    }
    if (packSizeUnit && packSizeUnit.length > 12) {
      throw new Error("Pack size unit is too long");
    }
    if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) {
      throw new Error("GST % must be between 0 and 100");
    }
    if (gstPercent > 0 && !hsnCode) {
      throw new Error("HSN is required when GST % is greater than 0");
    }
    if (hsnCode && !/^\d{4,8}$/.test(hsnCode)) {
      throw new Error("HSN must be 4 to 8 digits");
    }

    const existing = await get("SELECT id FROM products WHERE barcode = ?", [barcode]);
    if (existing) throw new Error("Barcode already exists");

    const categoryId = await ensureCategoryByName(categoryName);

    await run(
      "INSERT INTO products(name,barcode,price,stock,unit,pack_size_value,pack_size_unit,gst_percent,hsn_code,category_id,cost_price,mrp,sales_price_tax_inclusive,mrp_tax_inclusive) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
      name,
      barcode,
      price,
      stock,
      unit,
      packSizeValue,
      packSizeUnit,
      gstPercent,
      hsnCode,
      categoryId,
      costPrice,
      mrp,
      salesPriceTaxInclusive,
      mrpTaxInclusive,
    ],
    );
    await logAuditEvent(
      "product_create",
      "success",
      performedBy,
      `${name} (${barcode})`,
      `Price: ${price}, Stock: ${stock}, Unit: ${unit}, Pack: ${packSizeValue > 0 ? `${packSizeValue} ${packSizeUnit}` : "-"}, Category: ${categoryName || "-"}, GST: ${gstPercent}%, HSN: ${hsnCode || "-"}`,
    );
    await enqueueSync("product", "create", barcode, {
      name,
      barcode,
      price,
      stock,
      unit,
      packSizeValue,
      packSizeUnit,
      categoryName,
      gstPercent,
      hsnCode,
      costPrice,
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "product_create",
      "failed",
      performedBy,
      `${name} (${barcode})`,
      err?.message || "Add product failed",
    );
    throw err;
  }
});

ipcMain.handle("get-products", async (_event, payload) => {
  const includeArchived =
    typeof payload === "boolean"
      ? payload
      : Boolean(payload && typeof payload === "object" && payload.includeArchived);
  return all(
    `SELECT p.*, COALESCE(c.name, '') AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     ${includeArchived ? "" : "WHERE COALESCE(p.is_archived, 0) = 0"}
     ORDER BY COALESCE(p.is_archived, 0) ASC, p.id DESC`,
  );
});

ipcMain.handle("get-categories", async () => {
  return all("SELECT id, name FROM categories ORDER BY name COLLATE NOCASE ASC");
});

ipcMain.handle("create-customer", async (_event, payload) => {
  const name = String(payload?.name || "").trim();
  const phone = String(payload?.phone || "").trim();
  const email = String(payload?.email || "").trim();
  const address = String(payload?.address || "").trim();
  const defaultDiscount = toMoney(payload?.defaultDiscount);
  const performedBy = normalizeActor(payload?.performedBy);

  try {
    if (!name) throw new Error("Customer name is required");
    if (phone) {
      const existingPhone = await get("SELECT id FROM customers WHERE phone = ?", [phone]);
      if (existingPhone) throw new Error("Phone number already exists");
    }

    const result = await run(
      `INSERT INTO customers(name, phone, email, address, default_discount, loyalty_points, is_active, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      [name, phone, email, address, defaultDiscount, 0, 1, getLocalTimestamp()],
    );
    await logAuditEvent("customer_create", "success", performedBy, name, "Customer created");
    await enqueueSync("customer", "create", String(result.lastID), {
      name,
      phone,
      email,
      address,
      defaultDiscount,
    });
    return { ok: true, id: Number(result.lastID) };
  } catch (err) {
    await logAuditEvent(
      "customer_create",
      "failed",
      performedBy,
      name || phone,
      err?.message || "Create customer failed",
    );
    throw err;
  }
});

ipcMain.handle("update-customer", async (_event, payload) => {
  const id = Number(payload?.id);
  const name = String(payload?.name || "").trim();
  const phone = String(payload?.phone || "").trim();
  const email = String(payload?.email || "").trim();
  const address = String(payload?.address || "").trim();
  const defaultDiscount = toMoney(payload?.defaultDiscount);
  const performedBy = normalizeActor(payload?.performedBy);

  try {
    if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid customer id");
    if (!name) throw new Error("Customer name is required");
    const customer = await get("SELECT id FROM customers WHERE id = ?", [id]);
    if (!customer) throw new Error("Customer not found");
    if (phone) {
      const existingPhone = await get("SELECT id FROM customers WHERE phone = ? AND id <> ?", [phone, id]);
      if (existingPhone) throw new Error("Phone number already exists");
    }

    await run(
      "UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, default_discount = ? WHERE id = ?",
      [name, phone, email, address, defaultDiscount, id],
    );
    await logAuditEvent("customer_update", "success", performedBy, String(id), name);
    await enqueueSync("customer", "update", String(id), {
      id,
      name,
      phone,
      email,
      address,
      defaultDiscount,
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "customer_update",
      "failed",
      performedBy,
      String(id || ""),
      err?.message || "Update customer failed",
    );
    throw err;
  }
});

ipcMain.handle("get-customers", async () => {
  return all(
    `SELECT id, name, phone, email, address, default_discount AS defaultDiscount,
            loyalty_points AS loyaltyPoints, is_active AS isActive, created_at AS createdAt
     FROM customers
     ORDER BY name COLLATE NOCASE ASC`,
  );
});

ipcMain.handle("get-customer-history", async (_event, customerId) => {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid customer id");

  const customer = await get(
    `SELECT id, name, phone, email, address, default_discount AS defaultDiscount,
            loyalty_points AS loyaltyPoints, is_active AS isActive, created_at AS createdAt
     FROM customers
     WHERE id = ?`,
    [id],
  );
  if (!customer) throw new Error("Customer not found");

  const sales = await all(
    `SELECT id, total, subtotal, discount, payment_mode AS paymentMode, date,
            loyalty_redeemed_points AS loyaltyRedeemedPoints,
            loyalty_redeemed_amount AS loyaltyRedeemedAmount
     FROM sales
     WHERE customer_id = ?
     ORDER BY id DESC`,
    [id],
  );

  const totals = await get(
    `SELECT COUNT(*) AS visitCount, COALESCE(SUM(total),0) AS totalSpend,
            COALESCE(SUM(loyalty_redeemed_points),0) AS totalRedeemedPoints,
            COALESCE(SUM(loyalty_redeemed_amount),0) AS totalRedeemedAmount,
            COALESCE(SUM(CAST(total / 100 AS INTEGER)),0) AS totalEarnedPoints
     FROM sales
     WHERE customer_id = ?`,
    [id],
  );

  return {
    customer: {
      ...customer,
      defaultDiscount: toMoney(customer.defaultDiscount),
      loyaltyPoints: Number(customer.loyaltyPoints || 0),
      isActive: Number(customer.isActive ?? 1),
    },
    stats: {
      visitCount: Number(totals?.visitCount || 0),
      totalSpend: toMoney(totals?.totalSpend),
      totalRedeemedPoints: Number(totals?.totalRedeemedPoints || 0),
      totalRedeemedAmount: toMoney(totals?.totalRedeemedAmount),
      totalEarnedPoints: Number(totals?.totalEarnedPoints || 0),
    },
    sales: Array.isArray(sales)
      ? sales.map((s) => ({
          ...s,
          total: toMoney(s.total),
          subtotal: toMoney(s.subtotal),
          discount: toMoney(s.discount),
          loyaltyRedeemedPoints: Number(s.loyaltyRedeemedPoints || 0),
          loyaltyRedeemedAmount: toMoney(s.loyaltyRedeemedAmount),
        }))
      : [],
  };
});

ipcMain.handle("set-customer-active", async (_event, payload) => {
  const customerId = Number(payload?.customerId);
  const isActive = Number(payload?.isActive) ? 1 : 0;
  const pin = String(payload?.pin || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(customerId) || customerId <= 0) throw new Error("Invalid customer id");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("customer_status", "failed", performedBy, String(customerId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  try {
    const customer = await get("SELECT id, name FROM customers WHERE id = ?", [customerId]);
    if (!customer) throw new Error("Customer not found");
    await run("UPDATE customers SET is_active = ? WHERE id = ?", [isActive, customerId]);
    await logAuditEvent(
      "customer_status",
      "success",
      performedBy,
      String(customerId),
      `${customer.name} -> ${isActive ? "Active" : "Inactive"}`,
    );
    await enqueueSync("customer", "status", String(customerId), {
      customerId,
      isActive,
      name: customer.name,
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "customer_status",
      "failed",
      performedBy,
      String(customerId),
      err?.message || "Customer status change failed",
    );
    throw err;
  }
});

ipcMain.handle("delete-customer", async (_event, payload) => {
  const customerId = Number(payload?.customerId);
  const pin = String(payload?.pin || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(customerId) || customerId <= 0) throw new Error("Invalid customer id");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("customer_delete", "failed", performedBy, String(customerId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  try {
    const customer = await get("SELECT id, name FROM customers WHERE id = ?", [customerId]);
    if (!customer) throw new Error("Customer not found");

    const salesCount = await get("SELECT COUNT(*) AS count FROM sales WHERE customer_id = ?", [customerId]);
    if (Number(salesCount?.count || 0) > 0) {
      throw new Error("Customer has sales history and cannot be deleted");
    }

    await run("DELETE FROM customers WHERE id = ?", [customerId]);
    await logAuditEvent("customer_delete", "success", performedBy, String(customerId), customer.name);
    await enqueueSync("customer", "delete", String(customerId), {
      customerId,
      name: customer.name,
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "customer_delete",
      "failed",
      performedBy,
      String(customerId),
      err?.message || "Delete customer failed",
    );
    throw err;
  }
});

ipcMain.handle("get-khata-accounts", async () => {
  const rows = await all(
    `SELECT id, customer_id AS customerId, name, phone, address,
            opening_balance AS openingBalance, current_balance AS currentBalance,
            is_active AS isActive, created_at AS createdAt
     FROM khata_accounts
     ORDER BY id DESC`,
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        id: Number(row.id || 0),
        customerId: row.customerId ? Number(row.customerId) : null,
        name: String(row.name || ""),
        phone: String(row.phone || ""),
        address: String(row.address || ""),
        openingBalance: toMoney(row.openingBalance),
        currentBalance: toMoney(row.currentBalance),
        isActive: Number(row.isActive ?? 1),
        createdAt: String(row.createdAt || ""),
      }))
    : [];
});

ipcMain.handle("create-khata-account", async (_event, payload) => {
  const name = String(payload?.name || "").trim();
  const phone = String(payload?.phone || "").trim();
  const address = String(payload?.address || "").trim();
  const openingBalance = Number(payload?.openingBalance || 0);
  const customerId =
    payload?.customerId === null || payload?.customerId === undefined || payload?.customerId === ""
      ? null
      : Number(payload?.customerId);
  const performedBy = normalizeActor(payload?.performedBy);

  if (!name) throw new Error("Account name is required");
  if (!Number.isFinite(openingBalance) || openingBalance < 0) {
    throw new Error("Opening balance must be 0 or more");
  }
  if (customerId !== null && (!Number.isFinite(customerId) || customerId <= 0)) {
    throw new Error("Invalid customer selected");
  }
  if (phone) {
    const existing = await get(
      "SELECT id FROM khata_accounts WHERE phone = ? AND is_active = 1",
      [phone],
    );
    if (existing) throw new Error("Khata account with this phone already exists");
  }

  const result = await run(
    `INSERT INTO khata_accounts(customer_id, name, phone, address, opening_balance, current_balance, is_active)
     VALUES(?,?,?,?,?,?,1)`,
    [customerId, name, phone, address, openingBalance, openingBalance],
  );
  await logAuditEvent(
    "khata_account_create",
    "success",
    performedBy,
    String(result.lastID),
    `${name} | Opening Rs. ${openingBalance.toFixed(2)}`,
  );
  await enqueueSync("khata_account", "create", String(result.lastID), {
    customerId,
    name,
    phone,
    address,
    openingBalance,
  });
  return { ok: true, id: Number(result.lastID) };
});

ipcMain.handle("set-khata-active", async (_event, payload) => {
  const accountId = Number(payload?.accountId);
  const isActive = Boolean(payload?.isActive);
  const pin = String(payload?.pin || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(accountId) || accountId <= 0) throw new Error("Invalid account id");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("khata_status", "failed", performedBy, String(accountId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  const account = await get("SELECT id, name FROM khata_accounts WHERE id = ?", [accountId]);
  if (!account) throw new Error("Khata account not found");

  await run("UPDATE khata_accounts SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, accountId]);
  await logAuditEvent(
    "khata_status",
    "success",
    performedBy,
    String(accountId),
    `${account.name} -> ${isActive ? "Active" : "Inactive"}`,
  );
  await enqueueSync("khata_account", "status", String(accountId), {
    accountId,
    isActive: isActive ? 1 : 0,
  });
  return { ok: true };
});

ipcMain.handle("add-khata-entry", async (_event, payload) => {
  const accountId = Number(payload?.accountId);
  const entryType = String(payload?.entryType || "").trim().toLowerCase();
  const amount = Number(payload?.amount || 0);
  const note = String(payload?.note || "").trim();
  const saleId =
    payload?.saleId === null || payload?.saleId === undefined || payload?.saleId === ""
      ? null
      : Number(payload?.saleId);
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(accountId) || accountId <= 0) throw new Error("Select a khata account");
  if (!["credit", "payment"].includes(entryType)) throw new Error("Entry type must be credit or payment");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than 0");

  const account = await get(
    "SELECT id, name, current_balance AS currentBalance, is_active AS isActive FROM khata_accounts WHERE id = ?",
    [accountId],
  );
  if (!account) throw new Error("Khata account not found");
  if (Number(account.isActive ?? 1) !== 1) throw new Error("Khata account is inactive");

  const delta = entryType === "payment" ? -amount : amount;
  const newBalance = Number(account.currentBalance || 0) + delta;
  if (entryType === "payment" && newBalance < 0) {
    throw new Error("Payment exceeds current balance");
  }

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    await run(
      `INSERT INTO khata_entries(account_id, entry_type, amount, note, sale_id)
       VALUES(?,?,?,?,?)`,
      [accountId, entryType, amount, note, saleId],
    );
    await run("UPDATE khata_accounts SET current_balance = current_balance + ? WHERE id = ?", [
      delta,
      accountId,
    ]);
    await run("COMMIT");
  } catch (err) {
    try {
      await run("ROLLBACK");
    } catch (_rollbackErr) {}
    throw err;
  }

  await logAuditEvent(
    "khata_entry",
    "success",
    performedBy,
    String(accountId),
    `${account.name} | ${entryType} Rs. ${amount.toFixed(2)}`,
  );
  await enqueueSync("khata_entry", "create", String(accountId), {
    accountId,
    entryType,
    amount,
    note,
    saleId,
  });

  return { ok: true, newBalance: toMoney(newBalance) };
});

ipcMain.handle("get-khata-entries", async (_event, accountId) => {
  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid khata account");
  const rows = await all(
    `SELECT id, account_id AS accountId, entry_type AS entryType, amount, note, sale_id AS saleId, created_at AS createdAt
     FROM khata_entries
     WHERE account_id = ?
     ORDER BY id DESC`,
    [id],
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        id: Number(row.id || 0),
        accountId: Number(row.accountId || 0),
        entryType: String(row.entryType || ""),
        amount: toMoney(row.amount),
        note: String(row.note || ""),
        saleId: row.saleId ? Number(row.saleId) : null,
        createdAt: String(row.createdAt || ""),
      }))
    : [];
});

ipcMain.handle("create-supplier", async (_event, payload) => {
  const p = payload || {};
  const name = String(p.name || "").trim();
  const short_name = String(p.short_name || "").trim();
  const group_name = String(p.group_name || "").trim();
  const supplier_group = String(p.supplier_group || "").trim();
  const dealer_type = String(p.dealer_type || "").trim();
  const maintain_ref = String(p.maintain_ref || "").trim();
  const gstin = String(p.gstin || "").trim().toUpperCase();
  const gst_effective_date = String(p.gst_effective_date || "").trim();
  const credit_days = parseInt(p.credit_days) || 0;
  const credit_limit = parseFloat(p.credit_limit) || 0;
  const mailing_name = String(p.mailing_name || "").trim();
  const address = String(p.address || "").trim();
  const address2 = String(p.address2 || "").trim();
  const address3 = String(p.address3 || "").trim();
  const pincode = String(p.pincode || "").trim();
  const area = String(p.area || "").trim();
  const city = String(p.city || "").trim();
  const state = String(p.state || "").trim();
  const country = String(p.country || "").trim();
  const landmark = String(p.landmark || "").trim();
  const phone = String(p.phone || "").trim();
  const mobile_no = String(p.mobile_no || "").trim();
  const email_id = String(p.email_id || "").trim();
  const website_address = String(p.website_address || "").trim();
  const route_no_name = String(p.route_no_name || "").trim();
  const msme_no = String(p.msme_no || "").trim();
  const msme_type = String(p.msme_type || "").trim();
  const msme_eff_date = String(p.msme_eff_date || "").trim();
  const category = String(p.category || "").trim();
  const hsnCode = String(p.hsnCode || p.hsn_code || "").trim();
  const is_active = p.is_active !== undefined ? (Number(p.is_active) ? 1 : 0) : 1;
  const performedBy = normalizeActor(p.performedBy);

  try {
    if (!name) throw new Error("Supplier name is required");
      if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) {
        throw new Error("Supplier GSTIN must be 15 characters");
      }
      const existing = await get("SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)", [name]);
      if (existing) throw new Error("Supplier already exists");

      const result = await run(
        `INSERT INTO suppliers(
          name, short_name, group_name, supplier_group, dealer_type, maintain_ref,
          gstin, gst_effective_date, credit_days, credit_limit, mailing_name,
          address, address2, address3, pincode, area, city, state, country, landmark,
          phone, mobile_no, email_id, website_address, route_no_name,
          msme_no, msme_type, msme_eff_date, category, hsn_code, is_active
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          name, short_name, group_name, supplier_group, dealer_type, maintain_ref,
          gstin, gst_effective_date, credit_days, credit_limit, mailing_name,
          address, address2, address3, pincode, area, city, state, country, landmark,
          phone, mobile_no, email_id, website_address, route_no_name,
          msme_no, msme_type, msme_eff_date, category, hsnCode, is_active
        ],
      );
    await logAuditEvent("supplier_create", "success", performedBy, name, "Supplier created");
    await enqueueSync("supplier", "create", String(result.lastID), {
      name, phone, gstin, category, hsnCode, address
    });
    return { ok: true, id: Number(result.lastID) };
  } catch (err) {
    await logAuditEvent(
      "supplier_create",
      "failed",
      performedBy,
      name,
      err?.message || "Create supplier failed",
    );
    throw err;
  }
});

ipcMain.handle("get-suppliers", async (_event, payload) => {
  const includeInactive =
    typeof payload === "boolean"
      ? payload
      : Boolean(payload && typeof payload === "object" && payload.includeInactive);
    return all(
      `SELECT id, name, short_name, group_name, supplier_group, dealer_type, maintain_ref,
              gstin, gst_effective_date, credit_days, credit_limit, mailing_name,
              address, address2, address3, pincode, area, city, state, country, landmark,
              phone, mobile_no, email_id, website_address, route_no_name,
              msme_no, msme_type, msme_eff_date, category, hsn_code AS hsnCode,
              is_active AS isActive, opening_balance, created_at AS createdAt
       FROM suppliers
       ${includeInactive ? "" : "WHERE COALESCE(is_active, 1) = 1"}
       ORDER BY COALESCE(is_active, 1) DESC, name COLLATE NOCASE ASC`,
  );
});

ipcMain.handle("update-supplier", async (_event, payload) => {
  const p = payload || {};
  const id = Number(p.id);
  const name = String(p.name || "").trim();
  const short_name = String(p.short_name || "").trim();
  const group_name = String(p.group_name || "").trim();
  const supplier_group = String(p.supplier_group || "").trim();
  const dealer_type = String(p.dealer_type || "").trim();
  const maintain_ref = String(p.maintain_ref || "").trim();
  const gstin = String(p.gstin || "").trim().toUpperCase();
  const gst_effective_date = String(p.gst_effective_date || "").trim();
  const credit_days = parseInt(p.credit_days) || 0;
  const credit_limit = parseFloat(p.credit_limit) || 0;
  const mailing_name = String(p.mailing_name || "").trim();
  const address = String(p.address || "").trim();
  const address2 = String(p.address2 || "").trim();
  const address3 = String(p.address3 || "").trim();
  const pincode = String(p.pincode || "").trim();
  const area = String(p.area || "").trim();
  const city = String(p.city || "").trim();
  const state = String(p.state || "").trim();
  const country = String(p.country || "").trim();
  const landmark = String(p.landmark || "").trim();
  const phone = String(p.phone || "").trim();
  const mobile_no = String(p.mobile_no || "").trim();
  const email_id = String(p.email_id || "").trim();
  const website_address = String(p.website_address || "").trim();
  const route_no_name = String(p.route_no_name || "").trim();
  const msme_no = String(p.msme_no || "").trim();
  const msme_type = String(p.msme_type || "").trim();
  const msme_eff_date = String(p.msme_eff_date || "").trim();
  const category = String(p.category || "").trim();
  const hsnCode = String(p.hsnCode || p.hsn_code || "").trim();
  const is_active = p.is_active !== undefined ? (Number(p.is_active) ? 1 : 0) : 1;
  const performedBy = normalizeActor(p.performedBy);

  try {
    if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid supplier id");
    if (!name) throw new Error("Supplier name is required");
      if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) {
        throw new Error("Supplier GSTIN must be 15 characters");
      }

    const supplier = await get("SELECT id, name FROM suppliers WHERE id = ?", [id]);
    if (!supplier) throw new Error("Supplier not found");

    const duplicate = await get("SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND id <> ?", [
      name,
      id,
    ]);
    if (duplicate) throw new Error("Supplier name already exists");

      await run(
        `UPDATE suppliers SET 
          name=?, short_name=?, group_name=?, supplier_group=?, dealer_type=?, maintain_ref=?,
          gstin=?, gst_effective_date=?, credit_days=?, credit_limit=?, mailing_name=?,
          address=?, address2=?, address3=?, pincode=?, area=?, city=?, state=?, country=?, landmark=?,
          phone=?, mobile_no=?, email_id=?, website_address=?, route_no_name=?,
          msme_no=?, msme_type=?, msme_eff_date=?, category=?, hsn_code=?, is_active=?
         WHERE id=?`,
        [
          name, short_name, group_name, supplier_group, dealer_type, maintain_ref,
          gstin, gst_effective_date, credit_days, credit_limit, mailing_name,
          address, address2, address3, pincode, area, city, state, country, landmark,
          phone, mobile_no, email_id, website_address, route_no_name,
          msme_no, msme_type, msme_eff_date, category, hsnCode, is_active,
          id
        ]
      );

    await logAuditEvent(
      "supplier_update",
      "success",
      performedBy,
      `${supplier.name} -> ${name}`,
      "Supplier updated",
    );
    await enqueueSync("supplier", "update", String(id), {
      id, name, phone, gstin, category, hsnCode, address, is_active
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "supplier_update",
      "failed",
      performedBy,
      String(id || ""),
      err?.message || "Update supplier failed",
    );
    throw err;
  }
});

ipcMain.handle("set-supplier-active", async (_event, payload) => {
  const supplierId = Number(payload?.supplierId);
  const isActive = Number(payload?.isActive) ? 1 : 0;
  const pin = String(payload?.pin || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(supplierId) || supplierId <= 0) throw new Error("Invalid supplier id");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("supplier_status", "failed", performedBy, String(supplierId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  try {
    const supplier = await get("SELECT id, name FROM suppliers WHERE id = ?", [supplierId]);
    if (!supplier) throw new Error("Supplier not found");

    const activePurchases = await get(
      "SELECT COUNT(*) AS count FROM purchases WHERE supplier_id = ?",
      [supplierId],
    );
    if (!isActive && Number(activePurchases?.count || 0) > 0) {
      // allow status change even if history exists; this only blocks new use in purchase dropdown
    }

    await run("UPDATE suppliers SET is_active = ? WHERE id = ?", [isActive, supplierId]);
    await logAuditEvent(
      "supplier_status",
      "success",
      performedBy,
      String(supplierId),
      `${supplier.name} -> ${isActive ? "Active" : "Inactive"}`,
    );
    await enqueueSync("supplier", "status", String(supplierId), {
      supplierId,
      isActive,
      name: supplier.name,
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "supplier_status",
      "failed",
      performedBy,
      String(supplierId),
      err?.message || "Supplier status change failed",
    );
    throw err;
  }
});

ipcMain.handle("get-purchase-next-invoice", async () => {
  return getNextPurchaseInvoiceNo();
});

ipcMain.handle("create-purchase", async (_event, payload) => {
  const supplierId = Number(payload?.supplierId);
  const invoiceNo = String(payload?.invoiceNo || "").trim();
  const notes = String(payload?.notes || "").trim();
  const paymentMode = ["cash","credit","cheque","upi","neft"].includes(String(payload?.paymentMode||"cash").toLowerCase())
    ? String(payload.paymentMode).toLowerCase() : "cash";
  const tcsPercent = Math.max(0, Number(payload?.tcsPercent || 0));
  const crDrNote = Number(payload?.crDrNote || 0);
  const vehicleNo = String(payload?.vehicleNo || "").trim();
  const ewayBillNo = String(payload?.ewayBillNo || "").trim();
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(supplierId) || supplierId <= 0) throw new Error("Select a supplier");
  if (!invoiceNo) throw new Error("Purchase invoice number is required");
  if (!rawItems.length) throw new Error("Add at least one purchase item");

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const supplier = await get("SELECT id, name FROM suppliers WHERE id = ?", [supplierId]);
    if (!supplier) throw new Error("Supplier not found");
    const supplierStatus = await get("SELECT is_active AS isActive FROM suppliers WHERE id = ?", [supplierId]);
    if (supplierStatus && Number(supplierStatus.isActive ?? 1) !== 1) {
      throw new Error("Selected supplier is inactive");
    }

    const { items, total } = await normalizePurchaseItems(rawItems);
    const tcsAmount = total * tcsPercent / 100;
    const grandTotal = total + tcsAmount - crDrNote;

    const purchase = await run(
      `INSERT INTO purchases(supplier_id, invoice_no, total, notes, payment_mode, tcs_percent, tcs_amount, cr_dr_note, vehicle_no, ewaybill_no, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [supplierId, invoiceNo, grandTotal, notes, paymentMode, tcsPercent, tcsAmount, crDrNote, vehicleNo, ewayBillNo, getLocalTimestamp()],
    );
    const purchaseId = Number(purchase.lastID);

    for (const item of items) {
      const productId = Number(item.productId);
      const qty = Number(item.qty);
      const freeUnits = Number(item.freeUnits || 0);
      const totalQtyReceived = qty + freeUnits;
      const costPrice = Number(item.costPrice);
      const product = await get(
        "SELECT id, name, barcode, COALESCE(unit, 'pcs') AS unit, COALESCE(pack_size_value, 0) AS packSizeValue, COALESCE(pack_size_unit, '') AS packSizeUnit FROM products WHERE id = ?",
        [productId],
      );
      if (!product) throw new Error(`Product not found for id ${productId}`);

      const purchaseItem = await run(
        `INSERT INTO purchase_items(
           purchase_id, product_id, product_name, unit, pack_size_value, pack_size_unit,
           qty, returned_qty, cost_price, batch_no, expiry_date, line_total,
           mrp, free_units, gst_pct, rate_type, basic_amount
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          purchaseId, productId, product.name,
          String(product.unit || "pcs"), Number(product.packSizeValue || 0), String(product.packSizeUnit || ""),
          qty, 0, costPrice, item.batchNo, item.expiryDate, qty * costPrice,
          item.mrp, freeUnits, item.gstPct, item.rateType, item.basicAmount,
        ],
      );
      if (Number(item.mrp) > 0) {
        await run("UPDATE products SET stock = stock + ?, cost_price = ?, mrp = ?, price = ? WHERE id = ?", [
          totalQtyReceived, costPrice, item.mrp, item.mrp, productId,
        ]);
      } else {
        await run("UPDATE products SET stock = stock + ?, cost_price = ? WHERE id = ?", [
          totalQtyReceived, costPrice, productId,
        ]);
      }
      await insertInventoryBatch({
        purchaseId, purchaseItemId: Number(purchaseItem.lastID),
        supplierId, product,
        item: { ...item, qty: totalQtyReceived },
      });
    }

    await run("COMMIT");
    await logAuditEvent("purchase_create", "success", performedBy, invoiceNo,
      `Supplier: ${supplier.name}, Items: ${items.length}, Total: ${grandTotal.toFixed(2)}, Mode: ${paymentMode}`);
    await enqueueSync("purchase", "create", String(purchaseId), {
      purchaseId, invoiceNo, supplierId, supplierName: supplier.name, total: grandTotal, itemCount: items.length,
    });
    return { ok: true, purchaseId, total: grandTotal };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent("purchase_create", "failed", performedBy, invoiceNo, err?.message || "Create purchase failed");
    throw err;
  }
});

ipcMain.handle("update-purchase", async (_event, payload) => {
  const purchaseId = Number(payload?.purchaseId);
  const supplierId = Number(payload?.supplierId);
  const invoiceNo = String(payload?.invoiceNo || "").trim();
  const notes = String(payload?.notes || "").trim();
  const paymentMode = ["cash","credit","cheque","upi","neft"].includes(String(payload?.paymentMode||"cash").toLowerCase())
    ? String(payload.paymentMode).toLowerCase() : "cash";
  const tcsPercent = Math.max(0, Number(payload?.tcsPercent || 0));
  const crDrNote = Number(payload?.crDrNote || 0);
  const vehicleNo = String(payload?.vehicleNo || "").trim();
  const ewayBillNo = String(payload?.ewayBillNo || "").trim();
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(purchaseId) || purchaseId <= 0) throw new Error("Invalid purchase id");
  if (!Number.isFinite(supplierId) || supplierId <= 0) throw new Error("Select a supplier");
  if (!invoiceNo) throw new Error("Purchase invoice number is required");
  if (!rawItems.length) throw new Error("Add at least one purchase item");

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const purchase = await get("SELECT id, invoice_no AS invoiceNo FROM purchases WHERE id = ?", [purchaseId]);
    if (!purchase) throw new Error("Purchase not found");

    const supplier = await get("SELECT id, name FROM suppliers WHERE id = ?", [supplierId]);
    if (!supplier) throw new Error("Supplier not found");
    const supplierStatus = await get("SELECT is_active AS isActive FROM suppliers WHERE id = ?", [supplierId]);
    if (supplierStatus && Number(supplierStatus.isActive ?? 1) !== 1) {
      throw new Error("Selected supplier is inactive");
    }

    const returnUsage = await get(
      "SELECT COUNT(*) AS count FROM purchase_items WHERE purchase_id = ? AND COALESCE(returned_qty, 0) > 0",
      [purchaseId],
    );
    if (Number(returnUsage?.count || 0) > 0) {
      throw new Error("Purchase with returned stock cannot be edited");
    }

    const oldItems = await all(
      "SELECT product_id AS productId, qty, COALESCE(free_units, 0) AS freeUnits FROM purchase_items WHERE purchase_id = ?",
      [purchaseId],
    );

    for (const item of oldItems) {
      const totalOldQty = Number(item.qty) + Number(item.freeUnits || 0);
      await run(
        "UPDATE products SET stock = stock - ? WHERE id = ?",
        [totalOldQty, item.productId],
      );
    }

    const { items, total } = await normalizePurchaseItems(rawItems);
    const tcsAmount = total * tcsPercent / 100;
    const grandTotal = total + tcsAmount - crDrNote;

    await run(
      `UPDATE purchases SET supplier_id=?, invoice_no=?, total=?, notes=?,
       payment_mode=?, tcs_percent=?, tcs_amount=?, cr_dr_note=?, vehicle_no=?, ewaybill_no=?
       WHERE id=?`,
      [supplierId, invoiceNo, grandTotal, notes, paymentMode, tcsPercent, tcsAmount, crDrNote, vehicleNo, ewayBillNo, purchaseId],
    );
    await run("DELETE FROM purchase_items WHERE purchase_id = ?", [purchaseId]);
    await run("DELETE FROM inventory_batches WHERE purchase_id = ?", [purchaseId]);

    for (const item of items) {
      const productId = Number(item.productId);
      const qty = Number(item.qty);
      const freeUnits = Number(item.freeUnits || 0);
      const totalQtyReceived = qty + freeUnits;
      const costPrice = Number(item.costPrice);
      const product = await get(
        "SELECT id, name, barcode, COALESCE(unit, 'pcs') AS unit, COALESCE(pack_size_value, 0) AS packSizeValue, COALESCE(pack_size_unit, '') AS packSizeUnit FROM products WHERE id = ?",
        [productId],
      );
      if (!product) throw new Error(`Product not found for id ${productId}`);

      const purchaseItem = await run(
        `INSERT INTO purchase_items(
           purchase_id, product_id, product_name, unit, pack_size_value, pack_size_unit,
           qty, returned_qty, cost_price, batch_no, expiry_date, line_total,
           mrp, free_units, gst_pct, rate_type, basic_amount
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          purchaseId, productId, product.name,
          String(product.unit || "pcs"), Number(product.packSizeValue || 0), String(product.packSizeUnit || ""),
          qty, 0, costPrice, item.batchNo, item.expiryDate, qty * costPrice,
          item.mrp, freeUnits, item.gstPct, item.rateType, item.basicAmount,
        ],
      );
      if (Number(item.mrp) > 0) {
        await run("UPDATE products SET stock = stock + ?, cost_price = ?, mrp = ?, price = ? WHERE id = ?", [
          totalQtyReceived, costPrice, item.mrp, item.mrp, productId,
        ]);
      } else {
        await run("UPDATE products SET stock = stock + ?, cost_price = ? WHERE id = ?", [
          totalQtyReceived, costPrice, productId,
        ]);
      }
      await insertInventoryBatch({
        purchaseId, purchaseItemId: Number(purchaseItem.lastID),
        supplierId, product,
        item: { ...item, qty: totalQtyReceived },
      });
    }

    await run("COMMIT");
    await logAuditEvent("purchase_update", "success", performedBy, invoiceNo,
      `Supplier: ${supplier.name}, Items: ${items.length}, Total: ${grandTotal.toFixed(2)}`);
    await enqueueSync("purchase", "update", String(purchaseId), {
      purchaseId, invoiceNo, supplierId, supplierName: supplier.name, total: grandTotal, itemCount: items.length,
    });
    return { ok: true, purchaseId, total: grandTotal };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent("purchase_update", "failed", performedBy, invoiceNo || String(purchaseId), err?.message || "Update purchase failed");
    throw err;
  }
});

ipcMain.handle("get-purchases", async () => {
  return all(
    `SELECT p.id, p.supplier_id AS supplierId, p.invoice_no AS invoiceNo, p.total, p.notes,
            COALESCE(p.payment_mode,'cash') AS paymentMode,
            COALESCE(p.tcs_percent,0) AS tcsPercent, COALESCE(p.tcs_amount,0) AS tcsAmount,
            COALESCE(p.cr_dr_note,0) AS crDrNote,
            COALESCE(p.vehicle_no,'') AS vehicleNo, COALESCE(p.ewaybill_no,'') AS ewayBillNo,
            p.created_at AS createdAt,
            COALESCE(s.name, '') AS supplierName,
            COALESCE(SUM(pr.return_total), 0) AS returnedTotal,
            COUNT(pr.id) AS returnCount
     FROM purchases p
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     LEFT JOIN purchase_returns pr ON pr.original_purchase_id = p.id
     GROUP BY p.id, p.supplier_id, p.invoice_no, p.total, p.notes, p.created_at, s.name
     ORDER BY p.id DESC`,
  );
});

ipcMain.handle("get-purchase-items", async (_event, purchaseId) => {
  const id = Number(purchaseId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid purchase id");
  return all(
      `SELECT pi.id, pi.product_id AS productId, pi.product_name AS productName,
            COALESCE(pi.unit, 'pcs') AS unit,
            COALESCE(pi.pack_size_value, 0) AS packSizeValue,
            COALESCE(pi.pack_size_unit, '') AS packSizeUnit,
            pi.qty, COALESCE(pi.returned_qty, 0) AS returnedQty,
            pi.cost_price AS costPrice, COALESCE(pi.batch_no, '') AS batchNo,
            COALESCE(pi.expiry_date, '') AS expiryDate, pi.line_total AS lineTotal,
            COALESCE(pi.mrp, 0) AS mrp, COALESCE(pi.free_units, 0) AS freeUnits,
            COALESCE(pi.gst_pct, 0) AS gstPct, COALESCE(pi.rate_type,'exclusive') AS rateType,
            COALESCE(pi.basic_amount, 0) AS basicAmount,
            COALESCE(p.hsn_code, '') AS hsnCode, COALESCE(p.barcode, '') AS barcode
     FROM purchase_items pi
     LEFT JOIN products p ON p.id = pi.product_id
     WHERE pi.purchase_id = ?
     ORDER BY pi.id ASC`,
    [id],
  );
});

ipcMain.handle("get-purchase-summary", async () => {
  const overall = await get(
    "SELECT COUNT(*) AS totalPurchases, COALESCE(SUM(total),0) AS totalSpend FROM purchases",
  );
  const overallReturns = await get(
    "SELECT COUNT(*) AS totalReturns, COALESCE(SUM(return_total),0) AS totalReturned FROM purchase_returns",
  );
  const today = await get(
    "SELECT COUNT(*) AS todayPurchases, COALESCE(SUM(total),0) AS todaySpend FROM purchases WHERE date(created_at)=date('now','localtime')",
  );
  const todayReturns = await get(
    "SELECT COUNT(*) AS todayReturns, COALESCE(SUM(return_total),0) AS todayReturned FROM purchase_returns WHERE date(returned_at)=date('now','localtime')",
  );
  const todayItems = await get(
    `SELECT COALESCE(SUM(pi.qty),0) AS todayPurchaseItems
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     WHERE date(p.created_at)=date('now','localtime')`,
  );

  return {
    totalPurchases: Number(overall?.totalPurchases || 0),
    totalSpend: Number(overall?.totalSpend || 0),
    totalReturned: Number(overallReturns?.totalReturned || 0),
    totalPurchaseReturns: Number(overallReturns?.totalReturns || 0),
    netSpend: Number(overall?.totalSpend || 0) - Number(overallReturns?.totalReturned || 0),
    todayPurchases: Number(today?.todayPurchases || 0),
    todaySpend: Number(today?.todaySpend || 0),
    todayReturned: Number(todayReturns?.todayReturned || 0),
    todayPurchaseReturns: Number(todayReturns?.todayReturns || 0),
    todayNetSpend: Number(today?.todaySpend || 0) - Number(todayReturns?.todayReturned || 0),
    todayPurchaseItems: Number(todayItems?.todayPurchaseItems || 0),
  };
});

ipcMain.handle("get-purchase-gst-report", async () => {
  const rows = await all(
    `SELECT
        COALESCE(p.gst_percent, 0) AS gstPercent,
        COALESCE(SUM(pi.qty), 0) AS qtyPurchased,
        COALESCE(SUM(pi.line_total), 0) AS taxableAmount,
        COALESCE(SUM(pi.line_total * COALESCE(p.gst_percent, 0) / 100.0), 0) AS gstAmount,
        COALESCE(SUM(pi.line_total + (pi.line_total * COALESCE(p.gst_percent, 0) / 100.0)), 0) AS grossAmount
     FROM purchase_items pi
     LEFT JOIN products p ON p.id = pi.product_id
     GROUP BY COALESCE(p.gst_percent, 0)
     ORDER BY COALESCE(p.gst_percent, 0) ASC`,
  );

  return Array.isArray(rows)
    ? rows.map((row) => {
        const gstAmount = toMoney(row.gstAmount);
        return {
          gstPercent: toMoney(row.gstPercent),
          qtyPurchased: Number(row.qtyPurchased || 0),
          taxableAmount: toMoney(row.taxableAmount),
          cgstAmount: gstAmount / 2,
          sgstAmount: gstAmount / 2,
          gstAmount,
          grossAmount: toMoney(row.grossAmount),
        };
      })
    : [];
});

ipcMain.handle("delete-purchase", async (_event, payload) => {
  const purchaseId = Number(payload?.purchaseId);
  const pin = String(payload?.pin || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(purchaseId) || purchaseId <= 0) throw new Error("Invalid purchase id");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("purchase_delete", "failed", performedBy, String(purchaseId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const purchase = await get("SELECT id, invoice_no AS invoiceNo FROM purchases WHERE id = ?", [purchaseId]);
    if (!purchase) throw new Error("Purchase not found");

    const returned = await get(
      "SELECT COUNT(*) AS count FROM purchase_returns WHERE original_purchase_id = ?",
      [purchaseId],
    );
    if (Number(returned?.count || 0) > 0) {
      throw new Error("Purchase with return history cannot be deleted");
    }

    const items = await all("SELECT product_id AS productId, qty FROM purchase_items WHERE purchase_id = ?", [
      purchaseId,
    ]);

    for (const item of items) {
      const result = await run("UPDATE products SET stock = stock - ? WHERE id = ?", [
        item.qty,
        item.productId,
      ]);
    }

    await run("DELETE FROM purchase_items WHERE purchase_id = ?", [purchaseId]);
    await run("DELETE FROM inventory_batches WHERE purchase_id = ?", [purchaseId]);
    await run("DELETE FROM purchases WHERE id = ?", [purchaseId]);
    await run("COMMIT");
    await logAuditEvent(
      "purchase_delete",
      "success",
      performedBy,
      String(purchase.invoiceNo || purchaseId),
      "Purchase deleted and stock reversed",
    );
    await enqueueSync("purchase", "delete", String(purchaseId), {
      purchaseId,
      invoiceNo: purchase.invoiceNo,
    });
    return { ok: true };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "purchase_delete",
      "failed",
      performedBy,
      String(purchaseId),
      err?.message || "Delete purchase failed",
    );
    throw err;
  }
});

ipcMain.handle("return-purchase", async (_event, payload) => {
  const purchaseId = Number(payload?.purchaseId);
  const pin = String(payload?.pin || "").trim();
  const reason = String(payload?.reason || "").trim();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(purchaseId) || purchaseId <= 0) throw new Error("Invalid purchase id");
  if (!items.length) throw new Error("Select at least one item to return");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("purchase_return", "failed", performedBy, String(purchaseId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const purchase = await get(
      `SELECT p.id, p.invoice_no AS invoiceNo, p.supplier_id AS supplierId, COALESCE(s.name, '') AS supplierName
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.id = ?`,
      [purchaseId],
    );
    if (!purchase) throw new Error("Purchase not found");

    const purchaseItems = await all(
      `SELECT id, product_id AS productId, product_name AS productName, qty, COALESCE(returned_qty, 0) AS returnedQty,
              cost_price AS costPrice, COALESCE(batch_no, '') AS batchNo, COALESCE(expiry_date, '') AS expiryDate
       FROM purchase_items
       WHERE purchase_id = ?`,
      [purchaseId],
    );
    const itemMap = new Map(purchaseItems.map((row) => [Number(row.id), row]));

    const returnLines = [];
    let returnTotal = 0;

    for (const rawLine of items) {
      const purchaseItemId = Number(rawLine?.purchaseItemId);
      const qty = Number(rawLine?.qty);
      if (!Number.isFinite(purchaseItemId) || purchaseItemId <= 0) {
        throw new Error("Invalid purchase return item");
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("Return quantity must be greater than 0");
      }

      const line = itemMap.get(purchaseItemId);
      if (!line) throw new Error("Purchase item not found");

      const returnableQty = Number(line.qty || 0) - Number(line.returnedQty || 0);
      if (qty > returnableQty) {
        throw new Error(`Return quantity exceeds available for ${line.productName}`);
      }

      const stockRow = await get("SELECT stock FROM products WHERE id = ?", [line.productId]);
      if (!stockRow || Number(stockRow.stock || 0) < qty) {
        throw new Error(`Current stock is lower than return quantity for ${line.productName}`);
      }

      const result = await run("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?", [
        qty,
        line.productId,
        qty,
      ]);
      if (!result || Number(result.changes || 0) === 0) {
        throw new Error(`Unable to reduce stock for ${line.productName}`);
      }

      await run("UPDATE purchase_items SET returned_qty = COALESCE(returned_qty, 0) + ? WHERE id = ?", [
        qty,
        purchaseItemId,
      ]);

      await run(
        `UPDATE inventory_batches
         SET qty_returned = COALESCE(qty_returned, 0) + ?, updated_at = ?
         WHERE purchase_item_id = ?`,
        [qty, getLocalTimestamp(), purchaseItemId],
      );

      const lineTotal = qty * Number(line.costPrice || 0);
      returnTotal += lineTotal;
      returnLines.push({
        purchaseItemId,
        productId: Number(line.productId),
        name: String(line.productName || ""),
        qty,
        costPrice: Number(line.costPrice || 0),
        lineTotal,
        batchNo: String(line.batchNo || ""),
        expiryDate: String(line.expiryDate || ""),
      });
    }

    const serializedItems = JSON.stringify(returnLines);
    const inserted = await run(
      `INSERT INTO purchase_returns(
         original_purchase_id, supplier_id, supplier_name, invoice_no, return_total, reason, items_json, returned_at, performed_by
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        purchaseId,
        purchase.supplierId,
        String(purchase.supplierName || ""),
        String(purchase.invoiceNo || ""),
        returnTotal,
        reason,
        serializedItems,
        getLocalTimestamp(),
        performedBy,
      ],
    );

    await run("COMMIT");
    await logAuditEvent(
      "purchase_return",
      "success",
      performedBy,
      String(purchase.invoiceNo || purchaseId),
      `Return total: ${returnTotal.toFixed(2)}, Lines: ${returnLines.length}${reason ? `, Reason: ${reason}` : ""}`,
    );
    await enqueueSync("purchase_return", "create", String(inserted.lastID), {
      purchaseId,
      purchaseReturnId: Number(inserted.lastID),
      invoiceNo: purchase.invoiceNo,
      supplierId: purchase.supplierId,
      supplierName: purchase.supplierName,
      returnTotal,
      reason,
      itemCount: returnLines.length,
    });
    return { ok: true, purchaseReturnId: Number(inserted.lastID), returnTotal };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "purchase_return",
      "failed",
      performedBy,
      String(purchaseId),
      err?.message || "Purchase return failed",
    );
    throw err;
  }
});

ipcMain.handle("get-purchase-returns", async () => {
  const rows = await all(
    `SELECT id, original_purchase_id AS purchaseId, supplier_id AS supplierId, supplier_name AS supplierName,
            invoice_no AS invoiceNo, return_total AS returnTotal, reason, items_json AS itemsJson,
            returned_at AS returnedAt, performed_by AS performedBy
     FROM purchase_returns
     ORDER BY id DESC`,
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        ...row,
        items: (() => {
          try {
            const parsed = JSON.parse(row.itemsJson || "[]");
            return Array.isArray(parsed) ? parsed : [];
          } catch (_err) {
            return [];
          }
        })(),
      }))
    : [];
});

ipcMain.handle("get-purchase-return-details", async (_event, purchaseReturnId) => {
  const id = Number(purchaseReturnId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid purchase return id");
  const row = await get(
    `SELECT id, original_purchase_id AS purchaseId, supplier_id AS supplierId, supplier_name AS supplierName,
            invoice_no AS invoiceNo, return_total AS returnTotal, reason, items_json AS itemsJson,
            returned_at AS returnedAt, performed_by AS performedBy
     FROM purchase_returns
     WHERE id = ?`,
    [id],
  );
  if (!row) throw new Error("Purchase return not found");
  let items = [];
  try {
    const parsed = JSON.parse(row.itemsJson || "[]");
    items = Array.isArray(parsed) ? parsed : [];
  } catch (_err) {}
  return {
    id: Number(row.id),
    purchaseId: Number(row.purchaseId),
    supplierId: row.supplierId === null || row.supplierId === undefined ? null : Number(row.supplierId),
    supplierName: String(row.supplierName || ""),
    invoiceNo: String(row.invoiceNo || ""),
    returnTotal: toMoney(row.returnTotal),
    reason: String(row.reason || ""),
    returnedAt: String(row.returnedAt || ""),
    performedBy: String(row.performedBy || ""),
    items,
  };
});

ipcMain.handle("get-expiry-alerts", async () => {
  const rows = await all(
    `SELECT
        ib.id,
        ib.product_id AS productId,
        ib.product_name AS productName,
        ib.barcode,
        ib.batch_no AS batchNo,
        ib.expiry_date AS expiryDate,
        COALESCE(ib.qty_received, 0) - COALESCE(ib.qty_returned, 0) - COALESCE(ib.qty_sold, 0) AS availableQty,
        CAST(julianday(ib.expiry_date) - julianday(date('now','localtime')) AS INTEGER) AS daysLeft
     FROM inventory_batches ib
     WHERE COALESCE(ib.expiry_date, '') <> ''
       AND (COALESCE(ib.qty_received, 0) - COALESCE(ib.qty_returned, 0) - COALESCE(ib.qty_sold, 0)) > 0
       AND julianday(ib.expiry_date) <= julianday(date('now','localtime'), '+30 day')
     ORDER BY julianday(ib.expiry_date) ASC, ib.product_name ASC`,
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        id: Number(row.id),
        productId: Number(row.productId),
        productName: String(row.productName || ""),
        barcode: String(row.barcode || ""),
        batchNo: String(row.batchNo || ""),
        expiryDate: String(row.expiryDate || ""),
        availableQty: Number(row.availableQty || 0),
        daysLeft: Number(row.daysLeft || 0),
        status:
          Number(row.daysLeft || 0) < 0 ? "Expired" : Number(row.daysLeft || 0) <= 7 ? "Expiring Soon" : "Upcoming",
      }))
    : [];
});

ipcMain.handle("get-batch-stock-report", async () => {
  const rows = await all(
    `SELECT
        ib.id,
        ib.product_id AS productId,
        ib.product_name AS productName,
        ib.barcode,
        ib.batch_no AS batchNo,
        ib.expiry_date AS expiryDate,
        ib.cost_price AS costPrice,
        COALESCE(ib.qty_received, 0) AS qtyReceived,
        COALESCE(ib.qty_returned, 0) AS qtyReturned,
        COALESCE(ib.qty_sold, 0) AS qtySold,
        (COALESCE(ib.qty_received, 0) - COALESCE(ib.qty_returned, 0) - COALESCE(ib.qty_sold, 0)) AS availableQty,
        COALESCE(s.name, '') AS supplierName,
        ib.created_at AS createdAt
     FROM inventory_batches ib
     LEFT JOIN suppliers s ON s.id = ib.supplier_id
     ORDER BY ib.product_name ASC, julianday(COALESCE(NULLIF(ib.expiry_date, ''), '2999-12-31')) ASC, ib.id DESC`,
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        id: Number(row.id),
        productId: Number(row.productId),
        productName: String(row.productName || ""),
        barcode: String(row.barcode || ""),
        batchNo: String(row.batchNo || ""),
        expiryDate: String(row.expiryDate || ""),
        costPrice: toMoney(row.costPrice),
        qtyReceived: Number(row.qtyReceived || 0),
        qtyReturned: Number(row.qtyReturned || 0),
        qtySold: Number(row.qtySold || 0),
        availableQty: Number(row.availableQty || 0),
        supplierName: String(row.supplierName || ""),
        createdAt: String(row.createdAt || ""),
      }))
    : [];
});

ipcMain.handle("get-product-batches", async (_event, payload) => {
  const productId =
    typeof payload === "object" && payload !== null ? Number(payload.productId) : Number(payload);
  const includeExpired =
    typeof payload === "object" && payload !== null ? Boolean(payload.includeExpired) : false;
  if (!Number.isFinite(productId) || productId <= 0) throw new Error("Invalid product id");
  const rows = await getBatchRowsForProduct(productId, { includeExpired });
  return rows.map((row) => {
    let daysLeft = null;
    if (row.expiryDate) {
      daysLeft = Math.floor(
        (new Date(`${row.expiryDate}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
      );
    }
    const markdownPercent = row.expiryDate
      ? daysLeft !== null && daysLeft <= 3
        ? 20
        : daysLeft !== null && daysLeft <= 7
          ? 10
          : 0
      : 0;
    return {
      ...row,
      daysLeft,
      markdownPercent,
      label: `${row.batchNo || "No Batch"}${row.expiryDate ? ` | Exp ${row.expiryDate}` : ""} | Qty ${row.availableQty}`,
    };
  });
});

ipcMain.handle("update-batch-expiry", async (_event, payload) => {
  const batchId = Number(payload?.batchId);
  const expiryDate = normalizeExpiryDate(payload?.expiryDate);
  const pin = String(payload?.pin || "").trim();
  const reason = String(payload?.reason || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(batchId) || batchId <= 0) throw new Error("Invalid batch id");
  if (!expiryDate) throw new Error("Expiry date must be in YYYY-MM-DD format");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("batch_expiry_override", "failed", performedBy, String(batchId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  try {
    const batch = await get(
      `SELECT id, product_name AS productName, batch_no AS batchNo, expiry_date AS expiryDate
       FROM inventory_batches
       WHERE id = ?`,
      [batchId],
    );
    if (!batch) throw new Error("Batch not found");
    await run("UPDATE inventory_batches SET expiry_date = ?, updated_at = ? WHERE id = ?", [
      expiryDate,
      getLocalTimestamp(),
      batchId,
    ]);
    await logAuditEvent(
      "batch_expiry_override",
      "success",
      performedBy,
      `${batch.productName} / ${batch.batchNo || batchId}`,
      `Expiry ${batch.expiryDate || "-"} -> ${expiryDate}${reason ? ` | ${reason}` : ""}`,
    );
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "batch_expiry_override",
      "failed",
      performedBy,
      String(batchId),
      err?.message || "Batch expiry update failed",
    );
    throw err;
  }
});

ipcMain.handle("get-batch-expiry-history", async () => {
  const rows = await all(
    `SELECT id, action, status, actor, target, message, created_at AS createdAt
     FROM audit_logs
     WHERE action = 'batch_expiry_override'
     ORDER BY id DESC
     LIMIT 300`,
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        id: Number(row.id),
        action: String(row.action || ""),
        status: String(row.status || ""),
        actor: String(row.actor || ""),
        target: String(row.target || ""),
        message: String(row.message || ""),
        createdAt: String(row.createdAt || ""),
      }))
    : [];
});

ipcMain.handle("get-supplier-statement", async (_event, supplierId) => {
  const id = Number(supplierId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid supplier id");
  return buildSupplierStatement(id);
});

// â”€â”€â”€ SUPPLIER KHATA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

ipcMain.handle("get-supplier-khata", async (_event, supplierId) => {
  const id = Number(supplierId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid supplier id");

  const supplier = await get(
    "SELECT id, name, phone, address, gstin, COALESCE(opening_balance,0) AS openingBalance FROM suppliers WHERE id = ?",
    [id],
  );
  if (!supplier) throw new Error("Supplier not found");

  // All purchases (credit entries â€” money owed to supplier)
  const purchases = await all(
    `SELECT p.id, p.invoice_no AS invoiceNo, p.total, p.payment_mode AS paymentMode,
            p.created_at AS createdAt,
            COALESCE((SELECT SUM(pr.return_total) FROM purchase_returns pr WHERE pr.original_purchase_id = p.id),0) AS returnedAmount
     FROM purchases p WHERE p.supplier_id = ? ORDER BY p.created_at ASC, p.id ASC`,
    [id],
  );

  // All payments made to supplier (debit entries â€” money paid)
  const payments = await all(
    `SELECT id, amount, payment_mode AS paymentMode, notes, created_at AS createdAt
     FROM supplier_payments WHERE supplier_id = ? ORDER BY created_at ASC, id ASC`,
    [id],
  );

  // Build combined ledger with running balance
  // Balance = money WE OWE to supplier
  // Opening balance adds, purchases add, returns subtract, payments subtract
  let runningBalance = toMoney(supplier.openingBalance || 0);
  const ledger = [];

  // Add opening balance entry if non-zero
  if (runningBalance !== 0) {
    ledger.push({
      type: "opening",
      date: String(supplier.createdAt || ""),
      desc: "Opening Balance",
      debit: 0,
      credit: runningBalance,
      balance: runningBalance,
    });
  }

  // Merge purchases and payments into chronological order
  const allEvents = [
    ...purchases.map((p) => ({ ...p, _type: "purchase" })),
    ...payments.map((p) => ({ ...p, _type: "payment" })),
  ].sort((a, b) => {
    const ta = String(a.createdAt || ""), tb = String(b.createdAt || "");
    return ta < tb ? -1 : ta > tb ? 1 : (a.id - b.id);
  });

  for (const ev of allEvents) {
    if (ev._type === "purchase") {
      const netPurchase = Math.max(0, toMoney(ev.total) - toMoney(ev.returnedAmount));
      runningBalance += netPurchase;
      ledger.push({
        type: "purchase",
        id: ev.id,
        date: String(ev.createdAt || ""),
        desc: `Purchase Invoice: ${ev.invoiceNo || "â€”"}` + (toMoney(ev.returnedAmount) > 0 ? ` (Return: â‚¹${toMoney(ev.returnedAmount).toFixed(2)})` : ""),
        debit: 0,
        credit: netPurchase,
        balance: runningBalance,
        paymentMode: String(ev.paymentMode || "cash"),
      });
    } else {
      const amt = toMoney(ev.amount);
      runningBalance -= amt;
      ledger.push({
        type: "payment",
        id: ev.id,
        date: String(ev.createdAt || ""),
        desc: `Payment â€” ${ev.paymentMode || "cash"}` + (ev.notes ? `: ${ev.notes}` : ""),
        debit: amt,
        credit: 0,
        balance: runningBalance,
        paymentMode: String(ev.paymentMode || "cash"),
      });
    }
  }

  return {
    supplier: {
      id: Number(supplier.id),
      name: String(supplier.name || ""),
      phone: String(supplier.phone || ""),
      address: String(supplier.address || ""),
      gstin: String(supplier.gstin || ""),
      openingBalance: toMoney(supplier.openingBalance),
    },
    currentBalance: runningBalance,
    ledger,
  };
});

ipcMain.handle("add-supplier-payment", async (_event, payload) => {
  const supplierId = Number(payload?.supplierId);
  const amount = toMoney(payload?.amount);
  const paymentMode = String(payload?.paymentMode || "cash").trim();
  const notes = String(payload?.notes || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(supplierId) || supplierId <= 0) throw new Error("Invalid supplier");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Payment amount must be > 0");

  const supplier = await get("SELECT id, name FROM suppliers WHERE id = ?", [supplierId]);
  if (!supplier) throw new Error("Supplier not found");

  await run(
    `INSERT INTO supplier_payments(supplier_id, amount, payment_mode, notes, performed_by, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
    [supplierId, amount, paymentMode, notes, performedBy, getLocalTimestamp()],
  );
  await logAuditEvent("supplier_payment", "success", performedBy,
    `${supplier.name}`, `Payment â‚¹${amount.toFixed(2)} via ${paymentMode}`);
  return { ok: true, amount };
});

ipcMain.handle("set-supplier-opening-balance", async (_event, payload) => {
  const supplierId = Number(payload?.supplierId);
  const balance = toMoney(payload?.balance ?? 0);
  if (!Number.isFinite(supplierId) || supplierId <= 0) throw new Error("Invalid supplier");
  await run("UPDATE suppliers SET opening_balance = ? WHERE id = ?", [balance, supplierId]);
  return { ok: true };
});

ipcMain.handle("get-all-supplier-balances", async () => {
  const suppliers = await all(
    `SELECT id, name, phone, COALESCE(opening_balance, 0) AS openingBalance
     FROM suppliers WHERE COALESCE(is_active,1) = 1 ORDER BY name ASC`,
  );

  const result = [];
  for (const s of suppliers) {
    const totalPurchases = await get(
      `SELECT COALESCE(SUM(p.total),0) AS total,
              COALESCE((SELECT SUM(pr.return_total) FROM purchase_returns pr
                        WHERE pr.supplier_id = ?),0) AS returned
       FROM purchases p WHERE p.supplier_id = ?`,
      [s.id, s.id],
    );
    const totalPayments = await get(
      "SELECT COALESCE(SUM(amount),0) AS paid FROM supplier_payments WHERE supplier_id = ?",
      [s.id],
    );
    const balance = toMoney(s.openingBalance)
      + toMoney(totalPurchases?.total) - toMoney(totalPurchases?.returned)
      - toMoney(totalPayments?.paid);
    result.push({
      id: Number(s.id),
      name: String(s.name || ""),
      phone: String(s.phone || ""),
      openingBalance: toMoney(s.openingBalance),
      totalPurchases: toMoney(totalPurchases?.total),
      totalReturns: toMoney(totalPurchases?.returned),
      totalPaid: toMoney(totalPayments?.paid),
      balance: Math.round(balance * 100) / 100,
    });
  }
  return result;
});

ipcMain.handle("update-product", async (_event, data) => {
  const id = Number(data?.id);
  const name = String(data?.name || "").trim();
  const barcode = String(data?.barcode || "").trim();
  const price = Number(data?.price);
  const stock = Number(data?.stock);
  const unit = String(data?.unit || "").trim() || "pcs";
  const packSizeValueRaw = Number(data?.packSizeValue ?? data?.pack_size_value ?? 0);
  const packSizeValue = Number.isFinite(packSizeValueRaw) ? packSizeValueRaw : NaN;
  const packSizeUnit = String(data?.packSizeUnit ?? data?.pack_size_unit ?? "").trim();
  const categoryName = String(data?.categoryName || "").trim();
  const hsnCode = String(data?.hsnCode ?? data?.hsn_code ?? "").trim();
  const gstPercent = Number(data?.gstPercent ?? data?.gst_percent ?? 0);
  const costPrice = Number(data?.costPrice ?? data?.cost_price ?? 0);
  const mrp = Number(data?.mrp ?? 0);
  const salesPriceTaxInclusive = data?.salesPriceTaxInclusive === "No" || data?.salesPriceTaxInclusive === false || data?.salesPriceTaxInclusive === 0 ? 0 : 1;
  const mrpTaxInclusive = data?.mrpTaxInclusive === "No" || data?.mrpTaxInclusive === false || data?.mrpTaxInclusive === 0 ? 0 : 1;
  const performedBy = normalizeActor(data?.performedBy);

  try {
    if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid product id");
    if (!name || !barcode || !Number.isFinite(price) || !Number.isFinite(stock)) {
      throw new Error("Invalid product data");
    }
    if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) {
      throw new Error("GST % must be between 0 and 100");
    }
    if (unit.length > 12) {
      throw new Error("Unit is too long");
    }
    if (!Number.isFinite(packSizeValue) || packSizeValue < 0) {
      throw new Error("Invalid pack size value");
    }
    if (packSizeValue > 0 && !packSizeUnit) {
      throw new Error("Pack size unit is required");
    }
    if (packSizeUnit && packSizeUnit.length > 12) {
      throw new Error("Pack size unit is too long");
    }
    if (gstPercent > 0 && !hsnCode) {
      throw new Error("HSN is required when GST % is greater than 0");
    }
    if (hsnCode && !/^\d{4,8}$/.test(hsnCode)) {
      throw new Error("HSN must be 4 to 8 digits");
    }

    const product = await get("SELECT id, name, barcode FROM products WHERE id = ?", [id]);
    if (!product) throw new Error("Product not found");

    const duplicate = await get("SELECT id FROM products WHERE barcode = ? AND id <> ?", [barcode, id]);
    if (duplicate) throw new Error("Barcode already exists");

    const categoryId = await ensureCategoryByName(categoryName);

    await run(
      `UPDATE products
       SET name = ?, barcode = ?, price = ?, stock = ?, unit = ?, pack_size_value = ?, pack_size_unit = ?, gst_percent = ?, hsn_code = ?, category_id = ?, cost_price = ?, mrp = ?, sales_price_tax_inclusive = ?, mrp_tax_inclusive = ?
       WHERE id = ?`,
      [name, barcode, price, stock, unit, packSizeValue, packSizeUnit, gstPercent, hsnCode, categoryId, costPrice, mrp, salesPriceTaxInclusive, mrpTaxInclusive, id],
    );

    await logAuditEvent(
      "product_update",
      "success",
      performedBy,
      `${product.name} (${product.barcode})`,
      `Updated to ${name} (${barcode}), Category: ${categoryName || "-"}, Price: ${price}, Stock: ${stock}, Unit: ${unit}, Pack: ${packSizeValue > 0 ? `${packSizeValue} ${packSizeUnit}` : "-"}`,
    );
    await enqueueSync("product", "update", barcode, {
      id,
      name,
      barcode,
      price,
      stock,
      unit,
      packSizeValue,
      packSizeUnit,
      categoryName,
      gstPercent,
      hsnCode,
      costPrice,
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "product_update",
      "failed",
      performedBy,
      String(id || ""),
      err?.message || "Update product failed",
    );
    throw err;
  }
});

ipcMain.handle("parse-excel-file", async (_event, payload) => {
  const filePath = String(payload?.filePath || "").trim();
  if (!filePath) throw new Error("No file path provided");
  if (!fs.existsSync(filePath)) throw new Error("File not found: " + filePath);

  const ext = path.extname(filePath).toLowerCase();
  let headers = [];
  let rows = [];

  if (ext === ".csv") {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 1) throw new Error("CSV file is empty");
    const parseLine = (line) => {
      const r = [];
      let cur = "", inQ = false;
      for (const c of line) {
        if (c === '"') inQ = !inQ;
        else if (c === "," && !inQ) { r.push(cur.trim()); cur = ""; }
        else cur += c;
      }
      r.push(cur.trim());
      return r;
    };
    headers = parseLine(lines[0]);
    rows = lines.slice(1).filter((l) => l.trim()).map((l) => {
      const cols = parseLine(l);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i] || ""; });
      return obj;
    });
  } else {
    // Excel: .xlsx or .xls
    let XLSX;
    try { XLSX = require("xlsx"); } catch (_e) {}
    if (!XLSX) throw new Error("xlsx library not available");
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const jRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!jRows.length) throw new Error("Excel file is empty");
    
    let headerRowIndex = 0;
    let maxCols = 0;
    const maxSearch = Math.min(20, jRows.length);
    for (let i = 0; i < maxSearch; i++) {
      const nonEmpties = jRows[i].filter(c => String(c || "").trim() !== "").length;
      if (nonEmpties > maxCols) {
        maxCols = nonEmpties;
        headerRowIndex = i;
      }
    }

    const rawHeaders = jRows[headerRowIndex].map((h) => String(h || "").trim());
    const headerCounts = {};
    headers = rawHeaders.map(h => {
      if (!h) return h;
      headerCounts[h] = (headerCounts[h] || 0) + 1;
      return headerCounts[h] > 1 ? `${h} (${headerCounts[h]})` : h;
    });

    rows = jRows.slice(headerRowIndex + 1)
      .filter((r) => r.some((c) => String(c || "").trim()))
      .map((r) => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = String(r[i] ?? "").trim(); });
        return obj;
      });
  }

  return { headers, rows };
});

ipcMain.handle("save-excel-template", async (_event) => {
  const { dialog } = require("electron");
  let XLSX;
  try { XLSX = require("xlsx"); } catch (_e) {}
  if (!XLSX) throw new Error("xlsx library not available");

  const { filePath } = await dialog.showSaveDialog({
    title: "Save Import Template",
    defaultPath: "product_import_template.xlsx",
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!filePath) return { cancelled: true };

  const hdr = ["Name", "Price", "Barcode", "Cost Price", "GST%", "HSN Code", "Category", "Unit", "MRP"];
  const r1  = ["Lays Chips 26g", "20", "8901491520112", "14", "12", "2106", "Snacks", "pcs", "20"];
  const r2  = ["Colgate 200g", "125", "8901314000108", "90", "12", "3306", "FMCG", "pcs", "130"];
  const ws = XLSX.utils.aoa_to_sheet([hdr, r1, r2]);
  ws["!cols"] = hdr.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Products");
  XLSX.writeFile(wb, filePath);
  return { filePath };
});

ipcMain.handle("save-supplier-excel-template", async (_event) => {
  const { dialog } = require("electron");
  let XLSX;
  try { XLSX = require("xlsx"); } catch (_e) {}
  if (!XLSX) throw new Error("xlsx library not available");

  const { filePath } = await dialog.showSaveDialog({
    title: "Save Supplier Import Template",
    defaultPath: "supplier_import_template.xlsx",
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!filePath) return { cancelled: true };

  const hdr = [
    "Supplier Name", "Short Name", "Group Name", "Supplier Group", "Dealer Type", "Maintain Ref", 
    "GST No", "GST Effective Date", "Credit Days", "Credit Limit", "Mailing Name",
    "Address1", "Address2", "Address3", "Pincode", "Area", "City", "State", "Country", "Landmark",
    "Phone No", "Mobile No", "E-Mail Id", "Website Address", "Route No/Name",
    "MSME No", "MSME Type", "MSME Eff Date", "Category", "HSN Code", "Opening Balance"
  ];
  
  const r1  = [
    "Ramesh Distributors", "Ramesh", "Wholesalers", "Local", "Wholesaler", "Yes",
    "29AAAAA0000A1Z5", "2023-04-01", "30", "50000", "Ramesh Trading Co",
    "123 Main St", "Sector 4", "Near SBI", "560001", "MG Road", "Bangalore", "Karnataka", "India", "SBI Bank",
    "0801234567", "9876543210", "ramesh@example.com", "www.rameshtrading.com", "Route 1",
    "UDYAM-KR-00-12345", "Micro", "2020-07-01", "Groceries", "2106", "0"
  ];
  
  const ws = XLSX.utils.aoa_to_sheet([hdr, r1]);
  ws["!cols"] = hdr.map(() => ({ wch: 20 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Suppliers");
  XLSX.writeFile(wb, filePath);
  return { filePath };
});

ipcMain.handle("import-products", async (_event, payload) => {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const performedBy = normalizeActor(payload?.performedBy);
  if (!rows.length) throw new Error("No products found in import file");

  // Helper: parse a numeric field, stripping currency symbols etc.
  const parseNum = (v) => {
    if (v === null || v === undefined) return NaN;
    const s = String(v).replace(/[â‚¹$â‚¬Â£Â¥,\s]/g, "").trim();
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  };

  // Helper: clean HSN â€” keep only digits
  const cleanHsn = (v) => String(v || "").replace(/[^\d]/g, "").trim();

  let imported = 0;
  const errors = [];
  const skippedNames = [];

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = String(row?.name || "").trim();

      // Skip completely empty rows silently
      if (!name) continue;

      let barcode = String(row?.barcode || "").trim();
      const priceRaw = parseNum(row?.price);
      const stock    = Number.isFinite(parseNum(row?.stock)) ? parseNum(row?.stock) : 0;
      const costPrice = Number.isFinite(parseNum(row?.cost_price)) ? parseNum(row?.cost_price) : 0;
      const mrp      = Number.isFinite(parseNum(row?.mrp)) ? parseNum(row?.mrp) : 0;
      let unit = String(row?.unit || row?.uom || "").trim() || "pcs";
      if (unit.length > 12) unit = unit.slice(0, 12); // truncate, don't reject
      const categoryName = String(row?.categoryName || "").trim();
      const salesPriceTaxInclusive = String(row?.salesPriceTaxInclusive || "Yes").toLowerCase().trim() === "no" ? 0 : 1;
      const mrpTaxInclusive = String(row?.mrpTaxInclusive || "Yes").toLowerCase().trim() === "no" ? 0 : 1;
      const packSizeValueRaw = parseNum(row?.packSizeValue);
      const packSizeValue = Number.isFinite(packSizeValueRaw) ? packSizeValueRaw : 0;
      let packSizeUnit = String(row?.packSizeUnit || row?.packSize || "").trim();
      if (packSizeUnit.length > 12) packSizeUnit = packSizeUnit.slice(0, 12);


      // GST: clean and default to 0
      let gstPercent = parseNum(row?.gstPercent);
      if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) gstPercent = 0;

      // HSN: strip non-digits
      let hsnCode = cleanHsn(row?.hsnCode);
      if (hsnCode && (hsnCode.length < 4 || hsnCode.length > 8)) hsnCode = ""; // drop invalid HSN silently

      // Price is the only hard requirement
      if (!Number.isFinite(priceRaw) || priceRaw < 0) {
        errors.push(`Row ${index + 2} "${name}": invalid price ("${row?.price}")`);
        skippedNames.push(name);
        continue;
      }
      const price = priceRaw;

      // Auto-generate barcode if not provided or empty
      if (!barcode) {
        const gen = await generateNewBarcode();
        barcode = String(gen || "").trim();
      }
      if (!barcode) {
        errors.push(`Row ${index + 2} "${name}": could not generate barcode`);
        skippedNames.push(name);
        continue;
      }

      const categoryId = await ensureCategoryByName(categoryName);
      const existing = await get("SELECT id, cost_price, mrp FROM products WHERE barcode = ?", [barcode]);
      if (existing) {
        // Barcode exists -> update all fields and add to stock
        await run(
          "UPDATE products SET name=?, price=?, stock=stock+?, cost_price=?, mrp=?, sales_price_tax_inclusive=?, mrp_tax_inclusive=?, unit=?, pack_size_value=?, pack_size_unit=?, gst_percent=?, hsn_code=?, category_id=? WHERE barcode=?",
          [name, price, stock, costPrice || existing.cost_price || 0, mrp || existing.mrp || 0, salesPriceTaxInclusive, mrpTaxInclusive, unit, packSizeValue, packSizeUnit, gstPercent, hsnCode, categoryId, barcode],
        );
        imported += 1;
        continue;
      }

      await run(
        `INSERT INTO products(name,barcode,price,stock,cost_price,unit,pack_size_value,pack_size_unit,gst_percent,hsn_code,category_id,mrp,sales_price_tax_inclusive,mrp_tax_inclusive)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [name, barcode, price, stock, costPrice, unit, packSizeValue, packSizeUnit, gstPercent, hsnCode, categoryId, mrp, salesPriceTaxInclusive, mrpTaxInclusive],
      );
      imported += 1;
    }

    await run("COMMIT");
    await logAuditEvent(
      "product_import",
      "success",
      performedBy,
      `${imported} imported`,
      errors.length ? `${errors.length} row(s) skipped: ${errors.slice(0,3).join("; ")}` : "Import completed",
    );
    await enqueueSync("product", "bulk_import", String(imported), {
      imported,
      skipped: errors.length,
    });
    return { ok: true, imported, skipped: errors.length, errors };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent("product_import", "failed", performedBy, "", err?.message || "Import failed");
    throw err;
  }
});

ipcMain.handle("import-suppliers", async (_event, payload) => {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const performedBy = normalizeActor(payload?.performedBy);
  if (!rows.length) throw new Error("No suppliers found in import file");

  let imported = 0;
  const errors = [];

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const name = String(row?.name || "").trim();

      // Skip completely empty rows silently
      if (!name && !row?.phone && !row?.gstin) {
        continue;
      }

      if (!name) {
        errors.push(`Row ${index + 2}: Missing Name`);
        continue;
      }

      const existing = await get("SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)", [name]);

      const short_name = String(row?.short_name || "").trim();
      const group_name = String(row?.group_name || "").trim();
      const supplier_group = String(row?.supplier_group || "").trim();
      const dealer_type = String(row?.dealer_type || "").trim();
      const maintain_ref = String(row?.maintain_ref || "").trim();
      const gstin = String(row?.gstin || "").trim();
      const gst_effective_date = String(row?.gst_effective_date || "").trim();
      const credit_days = parseInt(row?.credit_days) || 0;
      const credit_limit = parseFloat(row?.credit_limit) || 0;
      const mailing_name = String(row?.mailing_name || "").trim();
      const address = String(row?.address || "").trim();
      const address2 = String(row?.address2 || "").trim();
      const address3 = String(row?.address3 || "").trim();
      const pincode = String(row?.pincode || "").trim();
      const area = String(row?.area || "").trim();
      const city = String(row?.city || "").trim();
      const state = String(row?.state || "").trim();
      const country = String(row?.country || "").trim();
      const landmark = String(row?.landmark || "").trim();
      const phone = String(row?.phone || "").trim();
      const mobile_no = String(row?.mobile_no || "").trim();
      const email_id = String(row?.email_id || "").trim();
      const website_address = String(row?.website_address || "").trim();
      const route_no_name = String(row?.route_no_name || "").trim();
      const msme_no = String(row?.msme_no || "").trim();
      const msme_type = String(row?.msme_type || "").trim();
      const msme_eff_date = String(row?.msme_eff_date || "").trim();
      const category = String(row?.category || "").trim();
      const hsnCode = String(row?.hsn_code || row?.hsnCode || row?.hsn || "").trim();
      const opening_balance = parseFloat(row?.opening_balance) || 0;

      if (existing) {
        await run(
          `UPDATE suppliers SET 
            short_name=COALESCE(NULLIF(?,''), short_name),
            group_name=COALESCE(NULLIF(?,''), group_name),
            supplier_group=COALESCE(NULLIF(?,''), supplier_group),
            dealer_type=COALESCE(NULLIF(?,''), dealer_type),
            maintain_ref=COALESCE(NULLIF(?,''), maintain_ref),
            gstin=COALESCE(NULLIF(?,''), gstin),
            gst_effective_date=COALESCE(NULLIF(?,''), gst_effective_date),
            credit_days=COALESCE(NULLIF(?,0), credit_days),
            credit_limit=COALESCE(NULLIF(?,0), credit_limit),
            mailing_name=COALESCE(NULLIF(?,''), mailing_name),
            address=COALESCE(NULLIF(?,''), address),
            address2=COALESCE(NULLIF(?,''), address2),
            address3=COALESCE(NULLIF(?,''), address3),
            pincode=COALESCE(NULLIF(?,''), pincode),
            area=COALESCE(NULLIF(?,''), area),
            city=COALESCE(NULLIF(?,''), city),
            state=COALESCE(NULLIF(?,''), state),
            country=COALESCE(NULLIF(?,''), country),
            landmark=COALESCE(NULLIF(?,''), landmark),
            phone=COALESCE(NULLIF(?,''), phone),
            mobile_no=COALESCE(NULLIF(?,''), mobile_no),
            email_id=COALESCE(NULLIF(?,''), email_id),
            website_address=COALESCE(NULLIF(?,''), website_address),
            route_no_name=COALESCE(NULLIF(?,''), route_no_name),
            msme_no=COALESCE(NULLIF(?,''), msme_no),
            msme_type=COALESCE(NULLIF(?,''), msme_type),
            msme_eff_date=COALESCE(NULLIF(?,''), msme_eff_date),
            category=COALESCE(NULLIF(?,''), category),
            hsn_code=COALESCE(NULLIF(?,''), hsn_code),
            opening_balance=COALESCE(NULLIF(?,0), opening_balance)
          WHERE id=?`,
          [
            short_name, group_name, supplier_group, dealer_type, maintain_ref,
            gstin, gst_effective_date, credit_days, credit_limit, mailing_name,
            address, address2, address3, pincode, area, city, state, country, landmark,
            phone, mobile_no, email_id, website_address, route_no_name,
            msme_no, msme_type, msme_eff_date, category, hsnCode, opening_balance,
            existing.id
          ]
        );
      } else {
        await run(
          `INSERT INTO suppliers(
            name, short_name, group_name, supplier_group, dealer_type, maintain_ref,
            gstin, gst_effective_date, credit_days, credit_limit, mailing_name,
            address, address2, address3, pincode, area, city, state, country, landmark,
            phone, mobile_no, email_id, website_address, route_no_name,
            msme_no, msme_type, msme_eff_date, category, hsn_code, opening_balance, is_active
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          [
            name, short_name, group_name, supplier_group, dealer_type, maintain_ref,
            gstin, gst_effective_date, credit_days, credit_limit, mailing_name,
            address, address2, address3, pincode, area, city, state, country, landmark,
            phone, mobile_no, email_id, website_address, route_no_name,
            msme_no, msme_type, msme_eff_date, category, hsnCode, opening_balance
          ]
        );
      }
      imported += 1;
    }

    await run("COMMIT");
    await logAuditEvent(
      "supplier_import",
      "success",
      performedBy,
      `${imported} imported`,
      errors.length ? `${errors.length} row(s) skipped: ${errors.slice(0,3).join("; ")}` : "Import completed",
    );
    await enqueueSync("supplier", "bulk_import", String(imported), {
      imported,
      skipped: errors.length,
    });
    return { ok: true, imported, skipped: errors.length, errors };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent("supplier_import", "failed", performedBy, "", err?.message || "Import failed");
    throw err;
  }
});

ipcMain.handle("delete-product", async (_event, payload) => {
  const id = Number(
    typeof payload === "object" && payload !== null ? payload.id : payload,
  );
  const performedBy = normalizeActor(
    typeof payload === "object" && payload !== null ? payload.performedBy : "",
  );
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid product id");

  try {
    const product = await get("SELECT id, name, barcode FROM products WHERE id = ?", [id]);
    if (!product) throw new Error("Product not found");

    const saleUsage = await get("SELECT COUNT(*) AS count FROM sale_items WHERE product_id = ?", [id]);
    if (Number(saleUsage?.count || 0) > 0) {
      throw new Error("Product is linked to sales history and cannot be deleted");
    }

    const purchaseUsage = await get("SELECT COUNT(*) AS count FROM purchase_items WHERE product_id = ?", [id]);
    if (Number(purchaseUsage?.count || 0) > 0) {
      throw new Error("Product is linked to purchase history and cannot be deleted");
    }

    await run("DELETE FROM products WHERE id = ?", [id]);
    await logAuditEvent(
      "product_delete",
      "success",
      performedBy,
      `${product.name} (${product.barcode})`,
      "Product deleted",
    );
    await enqueueSync("product", "delete", String(id), {
      id,
      name: product.name,
      barcode: product.barcode,
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "product_delete",
      "failed",
      performedBy,
      String(id),
      err?.message || "Delete product failed",
    );
    throw err;
  }
});

ipcMain.handle("set-product-archived", async (_event, payload) => {
  const id = Number(payload?.id);
  const archived = Number(payload?.archived) ? 1 : 0;
  const performedBy = normalizeActor(payload?.performedBy);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid product id");

  try {
    const product = await get("SELECT id, name, barcode, is_archived AS isArchived FROM products WHERE id = ?", [
      id,
    ]);
    if (!product) throw new Error("Product not found");
    await run("UPDATE products SET is_archived = ? WHERE id = ?", [archived, id]);
    await logAuditEvent(
      "product_archive",
      "success",
      performedBy,
      `${product.name} (${product.barcode})`,
      archived ? "Product archived" : "Product restored",
    );
    await enqueueSync("product", archived ? "archive" : "restore", String(id), {
      id,
      name: product.name,
      barcode: product.barcode,
      archived,
    });
    return { ok: true };
  } catch (err) {
    await logAuditEvent(
      "product_archive",
      "failed",
      performedBy,
      String(id),
      err?.message || "Product archive failed",
    );
    throw err;
  }
});

ipcMain.handle("get-product", async (_event, barcode) => {
  const queryStr = String(barcode).trim().toLowerCase();
  const product = await get(
    "SELECT * FROM products WHERE (LOWER(TRIM(barcode)) = ? OR LOWER(TRIM(name)) = ?) AND COALESCE(is_archived, 0) = 0 LIMIT 1",
    [queryStr, queryStr]
  );
  if (!product) return null;

  const batchSummary = await getBatchAvailabilitySummary(product.id);
  return {
    ...product,
    ...batchSummary,
    blockedReason:
      batchSummary.hasBatchTracking && Number(batchSummary.validBatchQty || 0) <= 0 && Number(batchSummary.expiredBatchQty || 0) > 0
        ? "Only expired batch stock is available"
        : "",
  };
});

async function generateNewBarcode() {
  const row = await get(
    "SELECT CAST(MAX(CAST(barcode AS INTEGER)) AS INTEGER) AS maxBarcode FROM products WHERE barcode GLOB '[0-9]*'",
  );
  const next = (row?.maxBarcode || 100000) + 1;
  return String(next);
}

ipcMain.handle("generate-barcode", async () => {
  return generateNewBarcode();
});

ipcMain.handle("save-sale", async (_event, data) => {
  const items = Array.isArray(data?.items) ? data.items : [];
  const subtotal = items.reduce((sum, item) => sum + toMoney(item.price) * Number(item.qty || 0), 0);
  const discount = Math.max(0, toMoney(data?.discount));
  const requestedRedeemPoints = normalizeRedeemPoints(data?.loyaltyRedeemedPoints);
  const paymentMode = normalizePaymentMode(data?.paymentMode);
  const cashAmount = Math.max(0, toMoney(data?.cashAmount));
  const upiAmount = Math.max(0, toMoney(data?.upiAmount));
  const cardAmount = Math.max(0, toMoney(data?.cardAmount));
  let customerId =
    data?.customerId === null || data?.customerId === undefined || data?.customerId === ""
      ? null
      : Number(data?.customerId);
  const customerName = String(data?.customerName || "").trim();
  const customerPhone = String(data?.customerPhone || "").trim();
  const performedBy = normalizeActor(data?.performedBy);

  if (!items.length) throw new Error("Cart empty");
  if (customerId !== null && (!Number.isFinite(customerId) || customerId <= 0)) {
    throw new Error("Invalid customer selected");
  }
  if (discount > subtotal) throw new Error("Discount cannot exceed subtotal");
  if (requestedRedeemPoints > 0 && customerId === null) {
    throw new Error("Select a customer to redeem loyalty points");
  }

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    let customer = null;
    let loyaltyRedeemedPoints = 0;
    let loyaltyRedeemedAmount = 0;
    
    if (customerId === null && (customerName || customerPhone)) {
      if (customerPhone) {
        const existing = await get("SELECT id FROM customers WHERE phone = ? LIMIT 1", [customerPhone]);
        if (existing) {
          customerId = existing.id;
        }
      }
      if (customerId === null) {
        const res = await run("INSERT INTO customers(name, phone, is_active, created_at) VALUES(?, ?, 1, datetime('now','localtime'))", [customerName || "Walk-in", customerPhone]);
        customerId = res.lastID;
      }
    }

    if (paymentMode === "credit" && customerId === null) {
      throw new Error("Customer details are required for a Credit sale.");
    }

    if (customerId !== null) {
      customer = await get("SELECT id, name, phone, loyalty_points AS loyaltyPoints, is_active AS isActive FROM customers WHERE id = ?", [
        customerId,
      ]);
      if (!customer) throw new Error("Selected customer not found");
      if (Number(customer.isActive ?? 1) !== 1) throw new Error("Selected customer is inactive");
      loyaltyRedeemedPoints = Math.min(requestedRedeemPoints, Number(customer.loyaltyPoints || 0));
      loyaltyRedeemedAmount = getRedeemAmountFromPoints(loyaltyRedeemedPoints, subtotal - discount);
      if (requestedRedeemPoints > Number(customer.loyaltyPoints || 0)) {
        throw new Error("Customer does not have enough loyalty points");
      }
    }

    const total = Math.max(0, toMoney(subtotal - discount - loyaltyRedeemedAmount));
    if (paymentMode === "cash" && cashAmount < total) {
      throw new Error("Cash amount is less than total");
    }
    if (paymentMode === "upi" && upiAmount < total) {
      throw new Error("UPI amount is less than total");
    }
    if (paymentMode === "card" && cardAmount < total) {
      throw new Error("Card amount is less than total");
    }
    if (paymentMode === "split" && cashAmount + upiAmount + cardAmount < total) {
      throw new Error("Split payment total is less than bill total");
    }

    for (const item of items) {
      const stockRow = await get("SELECT stock FROM products WHERE id = ?", [item.id]);
      if (!stockRow) throw new Error(`Product missing (id ${item.id})`);
      // Removed strict stock check to allow negative stock billing
      const batchSummary = await getBatchAvailabilitySummary(item.id);
      if (batchSummary.hasBatchTracking && Number(batchSummary.validBatchQty || 0) < Number(item.qty || 0)) {
        if (Number(batchSummary.validBatchQty || 0) <= 0 && Number(batchSummary.expiredBatchQty || 0) > 0) {
          // Warning only, do not block
        }
      }
    }

    const sale = await run(
      `INSERT INTO sales(
        total, date, subtotal, discount, payment_mode, cash_amount, upi_amount, card_amount,
        customer_id, loyalty_redeemed_points, loyalty_redeemed_amount
      )
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        total,
        getLocalTimestamp(),
        subtotal,
        discount,
        paymentMode,
        cashAmount,
        upiAmount,
        cardAmount,
        customerId,
        loyaltyRedeemedPoints,
        loyaltyRedeemedAmount,
      ],
    );
    const saleId = sale.lastID;

    for (const item of items) {
      const saleItem = await run(
        "INSERT INTO sale_items(sale_id,product_id,product_name,price,qty,gst_percent,hsn_code,mrp) VALUES(?,?,?,?,?,?,?,?)",
        [
          saleId,
          item.id,
          item.name,
          item.price,
          item.qty,
          Number(item.gstPercent || 0),
          String(item.hsnCode || ""),
          Number(item.mrp || item.originalPrice || item.price || 0),
        ],
      );
      await allocateSaleItemBatches(
        saleId,
        Number(saleItem.lastID),
        item.id,
        item.qty,
        Number(item.preferredBatchId || 0) || null,
      );
      await run("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?", [
        item.qty,
        item.id,
        item.qty,
      ]);
    }

    const earnedPoints = getSalePoints(total);
    if (customerId !== null) {
      if (loyaltyRedeemedPoints > 0) {
        await run(
          "UPDATE customers SET loyalty_points = CASE WHEN loyalty_points >= ? THEN loyalty_points - ? ELSE 0 END WHERE id = ?",
          [loyaltyRedeemedPoints, loyaltyRedeemedPoints, customerId],
        );
      }
      if (earnedPoints > 0) {
        await run("UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?", [
          earnedPoints,
          customerId,
        ]);
      }
      
      if (paymentMode === "credit") {
        let khataAccount = await get("SELECT id, current_balance FROM khata_accounts WHERE customer_id = ?", [customerId]);
        if (!khataAccount) {
           const accName = customerName || (customer ? customer.name : "Walk-in");
           const accPhone = customerPhone || (customer ? customer.phone : "");
           const acc = await run("INSERT INTO khata_accounts(customer_id, name, phone, opening_balance, current_balance, is_active) VALUES(?, ?, ?, 0, ?, 1)", [customerId, accName, accPhone, total]);
           khataAccount = { id: acc.lastID };
        } else {
           await run("UPDATE khata_accounts SET current_balance = current_balance + ? WHERE id = ?", [total, khataAccount.id]);
        }
        await run("INSERT INTO khata_entries(account_id, entry_type, amount, note, sale_id) VALUES(?, 'sale', ?, 'Credit Sale', ?)", [khataAccount.id, total, saleId]);
      }
    }

    await run("COMMIT");
    await logAuditEvent(
      "sale_create",
      "success",
      performedBy,
      String(saleId),
      `Mode: ${paymentMode}, Total: ${total.toFixed(2)}, Redeemed: ${loyaltyRedeemedPoints}${customer ? `, Customer: ${customer.name}` : ""}`,
    );
    await enqueueSync("sale", "create", String(saleId), {
      saleId,
      paymentMode,
      total,
      subtotal,
      discount,
      customerId,
      itemCount: items.length,
    });
    return { ok: true, saleId };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "sale_create",
      "failed",
      performedBy,
      "",
      err?.message || "Create sale failed",
    );
    throw err;
  }
});

ipcMain.handle("get-sales", async () => {
  return all(
    `SELECT s.*, c.name AS customerName, c.phone AS customerPhone
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     ORDER BY s.id DESC`,
  );
});

ipcMain.handle("get-sales-summary", async () => {
  const overall = await get(
    "SELECT COUNT(*) AS totalBills, COALESCE(SUM(total),0) AS totalRevenue FROM sales",
  );
  const today = await get(
    "SELECT COUNT(*) AS todayBills, COALESCE(SUM(total),0) AS todayRevenue FROM sales WHERE date(date)=date('now','localtime')",
  );
  const todayItems = await get(
    `SELECT COALESCE(SUM(si.qty),0) AS todayItems
     FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id
     WHERE date(s.date)=date('now','localtime')`,
  );
  const month = await get(
    `SELECT COUNT(*) AS monthBills, COALESCE(SUM(total),0) AS monthRevenue
     FROM sales
     WHERE strftime('%Y-%m', date) = strftime('%Y-%m', 'now', 'localtime')`,
  );
  const paymentMix = await all(
    `SELECT payment_mode AS paymentMode, COALESCE(SUM(total),0) AS total
     FROM sales
     GROUP BY payment_mode`,
  );

  return {
    totalBills: Number(overall?.totalBills || 0),
    totalRevenue: Number(overall?.totalRevenue || 0),
    todayBills: Number(today?.todayBills || 0),
    todayRevenue: Number(today?.todayRevenue || 0),
    todayItems: Number(todayItems?.todayItems || 0),
    monthBills: Number(month?.monthBills || 0),
    monthRevenue: Number(month?.monthRevenue || 0),
    paymentMix: Array.isArray(paymentMix)
      ? paymentMix.map((row) => ({
          paymentMode: normalizePaymentMode(row.paymentMode),
          total: toMoney(row.total),
        }))
      : [],
  };
});

ipcMain.handle("get-advanced-reports", async () => {
  const monthlySales = await all(
    `SELECT strftime('%Y-%m', date) AS monthKey,
            COUNT(*) AS bills,
            COALESCE(SUM(total),0) AS revenue
     FROM sales
     GROUP BY strftime('%Y-%m', date)
     ORDER BY monthKey DESC
     LIMIT 6`,
  );

  const topProducts = await all(
    `SELECT product_name AS name,
            COALESCE(SUM(qty),0) AS qtySold,
            COALESCE(SUM(price * qty),0) AS revenue
     FROM sale_items
     GROUP BY product_name
     ORDER BY qtySold DESC, revenue DESC
     LIMIT 10`,
  );

  const productProfitRows = await all(
    `SELECT
        si.product_name AS name,
        COALESCE(SUM(si.qty),0) AS qtySold,
        COALESCE(SUM((si.price - COALESCE(p.cost_price, 0)) * si.qty),0) AS profit
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     GROUP BY si.product_name
     ORDER BY profit DESC, qtySold DESC
     LIMIT 10`,
  );

  const profitSummary = await get(
    `SELECT
        COALESCE(SUM((si.price - COALESCE(p.cost_price, 0)) * si.qty),0) AS totalProfit,
        COALESCE(SUM(CASE WHEN date(s.date)=date('now','localtime') THEN (si.price - COALESCE(p.cost_price, 0)) * si.qty ELSE 0 END),0) AS todayProfit,
        COALESCE(SUM(CASE WHEN strftime('%Y-%m', s.date)=strftime('%Y-%m', 'now', 'localtime') THEN (si.price - COALESCE(p.cost_price, 0)) * si.qty ELSE 0 END),0) AS monthProfit
     FROM sale_items si
     INNER JOIN sales s ON s.id = si.sale_id
     LEFT JOIN products p ON p.id = si.product_id`,
  );

  const stockSummary = await get(
    `SELECT
        COUNT(*) AS totalProducts,
        COALESCE(SUM(stock),0) AS totalUnits,
        COALESCE(SUM(CASE WHEN stock <= 5 THEN 1 ELSE 0 END),0) AS lowStockCount,
        COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END),0) AS outOfStockCount,
        COALESCE(SUM(stock * COALESCE(cost_price, 0)),0) AS stockValue
     FROM products`,
  );

  const paymentSummaryRows = await all(
    `SELECT
        COALESCE(SUM(cash_amount),0) AS cashTotal,
        COALESCE(SUM(upi_amount),0) AS upiTotal,
        COALESCE(SUM(card_amount),0) AS cardTotal
     FROM sales`,
  );

  return {
    monthlySales: Array.isArray(monthlySales)
      ? monthlySales
          .map((row) => ({
            monthKey: String(row.monthKey || ""),
            bills: Number(row.bills || 0),
            revenue: toMoney(row.revenue),
          }))
          .reverse()
      : [],
    topProducts: Array.isArray(topProducts)
      ? topProducts.map((row) => ({
          name: String(row.name || ""),
          qtySold: Number(row.qtySold || 0),
          revenue: toMoney(row.revenue),
        }))
      : [],
    productProfitRows: Array.isArray(productProfitRows)
      ? productProfitRows.map((row) => ({
          name: String(row.name || ""),
          qtySold: Number(row.qtySold || 0),
          profit: toMoney(row.profit),
        }))
      : [],
    profitSummary: {
      totalProfit: toMoney(profitSummary?.totalProfit),
      todayProfit: toMoney(profitSummary?.todayProfit),
      monthProfit: toMoney(profitSummary?.monthProfit),
    },
    stockSummary: {
      totalProducts: Number(stockSummary?.totalProducts || 0),
      totalUnits: Number(stockSummary?.totalUnits || 0),
      lowStockCount: Number(stockSummary?.lowStockCount || 0),
      outOfStockCount: Number(stockSummary?.outOfStockCount || 0),
      stockValue: toMoney(stockSummary?.stockValue),
    },
    paymentSummary: {
      cashTotal: toMoney(paymentSummaryRows?.[0]?.cashTotal),
      upiTotal: toMoney(paymentSummaryRows?.[0]?.upiTotal),
      cardTotal: toMoney(paymentSummaryRows?.[0]?.cardTotal),
    },
  };
});

ipcMain.handle("get-reorder-suggestions", async (_event, payload) => {
  const days = Number(payload?.days || 14);
  const targetDays = Number(payload?.targetDays || 10);
  return getReorderSuggestionsData({ days, targetDays });
});

ipcMain.handle("get-gst-report", async () => {
  const rows = await all(
    `SELECT
        COALESCE(si.gst_percent, 0) AS gstPercent,
        COALESCE(SUM((si.price * si.qty) * 100.0 / (100.0 + COALESCE(NULLIF(si.gst_percent, 0), 0))), SUM(si.price * si.qty)) AS taxableAmount,
        COALESCE(SUM((si.price * si.qty) - ((si.price * si.qty) * 100.0 / (100.0 + COALESCE(NULLIF(si.gst_percent, 0), 0)))), 0) AS gstAmount,
        COALESCE(SUM(si.price * si.qty), 0) AS grossAmount,
        COALESCE(SUM(si.qty), 0) AS qtySold
     FROM sale_items si
     GROUP BY COALESCE(si.gst_percent, 0)
     ORDER BY COALESCE(si.gst_percent, 0) ASC`,
  );

  return Array.isArray(rows)
    ? rows.map((row) => {
        const gstAmount = toMoney(row.gstAmount);
        return {
          gstPercent: toMoney(row.gstPercent),
          taxableAmount: toMoney(row.taxableAmount),
          gstAmount,
          cgstAmount: gstAmount / 2,
          sgstAmount: gstAmount / 2,
          grossAmount: toMoney(row.grossAmount),
          qtySold: Number(row.qtySold || 0),
        };
      })
    : [];
});

ipcMain.handle("get-last-sale", async () => {
  const sale = await get(
    `SELECT s.id, s.total, s.subtotal, s.discount, s.payment_mode AS paymentMode, s.cash_amount AS cashAmount,
            s.upi_amount AS upiAmount, s.card_amount AS cardAmount, s.loyalty_redeemed_points AS loyaltyRedeemedPoints,
            s.loyalty_redeemed_amount AS loyaltyRedeemedAmount, s.date, c.name AS customerName
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     ORDER BY s.id DESC
     LIMIT 1`,
  );
  if (!sale) return null;

  const items = await getSaleItemsDetailed(sale.id);

  return {
    id: sale.id,
    total: Number(sale.total || 0),
    subtotal: Number(sale.subtotal || sale.total || 0),
    discount: Number(sale.discount || 0),
    paymentMode: normalizePaymentMode(sale.paymentMode),
    cashAmount: toMoney(sale.cashAmount),
    upiAmount: toMoney(sale.upiAmount),
    cardAmount: toMoney(sale.cardAmount),
    loyaltyRedeemedPoints: Number(sale.loyaltyRedeemedPoints || 0),
    loyaltyRedeemedAmount: toMoney(sale.loyaltyRedeemedAmount),
    customerName: String(sale.customerName || ""),
    date: sale.date,
    items: items.map((i) => ({
      id: Number(i.id || 0),
      name: String(i.name || ""),
      price: Number(i.price || 0),
      originalPrice: Number(i.originalPrice || i.price || 0),
      mrp: Number(i.mrp || i.price || 0),
      qty: Number(i.qty || 0),
      gstPercent: Number(i.gstPercent || 0),
      hsnCode: String(i.hsnCode || ""),
      preferredBatchId: i.preferredBatchId ? Number(i.preferredBatchId) : null,
      batchNo: String(i.batchNo || ""),
      expiryDate: String(i.expiryDate || ""),
      markdownPercent: Number(i.markdownPercent || 0),
      hasBatchTracking: Boolean(i.hasBatchTracking),
      batchAvailableQty: Number(i.batchAvailableQty || 0),
    })),
  };
});

ipcMain.handle("get-sale-details", async (_event, saleId) => {
  const id = Number(saleId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid sale id");

  const sale = await get(
    `SELECT s.id, s.total, s.subtotal, s.discount, s.payment_mode AS paymentMode,
            s.cash_amount AS cashAmount, s.upi_amount AS upiAmount, s.card_amount AS cardAmount,
            s.customer_id AS customerId, s.loyalty_redeemed_points AS loyaltyRedeemedPoints,
            s.loyalty_redeemed_amount AS loyaltyRedeemedAmount, s.date, c.name AS customerName
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.id = ?`,
    [id],
  );
  if (!sale) throw new Error("Sale not found");

  const items = await getSaleItemsDetailed(id);

  return {
    id: sale.id,
    total: toMoney(sale.total),
    subtotal: toMoney(sale.subtotal || sale.total),
    discount: toMoney(sale.discount),
    paymentMode: normalizePaymentMode(sale.paymentMode),
    cashAmount: toMoney(sale.cashAmount),
    upiAmount: toMoney(sale.upiAmount),
    cardAmount: toMoney(sale.cardAmount),
    customerId: sale.customerId ? Number(sale.customerId) : null,
    customerName: String(sale.customerName || ""),
    loyaltyRedeemedPoints: Number(sale.loyaltyRedeemedPoints || 0),
    loyaltyRedeemedAmount: toMoney(sale.loyaltyRedeemedAmount),
    date: sale.date,
    items: Array.isArray(items)
      ? items.map((item) => ({
          id: Number(item.id),
          name: String(item.name || ""),
          price: toMoney(item.price),
          originalPrice: toMoney(item.originalPrice ?? item.price),
          mrp: Number(item.mrp || item.price || 0),
          qty: Number(item.qty || 0),
          gstPercent: toMoney(item.gstPercent),
          hsnCode: String(item.hsnCode || ""),
          lineId: Number(item.lineId || 0),
          preferredBatchId: item.preferredBatchId ? Number(item.preferredBatchId) : null,
          batchNo: String(item.batchNo || ""),
          expiryDate: String(item.expiryDate || ""),
          markdownPercent: Number(item.markdownPercent || 0),
          hasBatchTracking: Boolean(item.hasBatchTracking),
          batchAvailableQty: Number(item.batchAvailableQty || 0),
        }))
      : [],
  };
});

ipcMain.handle("update-sale", async (_event, payload) => {
  const saleId = Number(payload?.saleId);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const subtotal = items.reduce((sum, item) => sum + toMoney(item.price) * Number(item.qty || 0), 0);
  const discount = Math.max(0, toMoney(payload?.discount));
  const requestedRedeemPoints = normalizeRedeemPoints(payload?.loyaltyRedeemedPoints);
  const paymentMode = normalizePaymentMode(payload?.paymentMode);
  const cashAmount = Math.max(0, toMoney(payload?.cashAmount));
  const upiAmount = Math.max(0, toMoney(payload?.upiAmount));
  const cardAmount = Math.max(0, toMoney(payload?.cardAmount));
  const customerId =
    payload?.customerId === null || payload?.customerId === undefined || payload?.customerId === ""
      ? null
      : Number(payload?.customerId);
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(saleId) || saleId <= 0) throw new Error("Invalid sale id");
  if (!items.length) throw new Error("Cart empty");
  if (customerId !== null && (!Number.isFinite(customerId) || customerId <= 0)) {
    throw new Error("Invalid customer selected");
  }
  if (discount > subtotal) throw new Error("Discount cannot exceed subtotal");
  if (requestedRedeemPoints > 0 && customerId === null) throw new Error("Select a customer to redeem loyalty points");

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const oldSale = await get(
      `SELECT id, total, customer_id AS customerId, loyalty_redeemed_points AS loyaltyRedeemedPoints,
              loyalty_redeemed_amount AS loyaltyRedeemedAmount, payment_mode AS paymentMode
       FROM sales WHERE id = ?`,
      [saleId],
    );
    if (!oldSale) throw new Error("Sale not found");

    let loyaltyRedeemedPoints = 0;
    let loyaltyRedeemedAmount = 0;
    if (customerId !== null) {
      const customer = await get(
        "SELECT id, loyalty_points AS loyaltyPoints, is_active AS isActive FROM customers WHERE id = ?",
        [customerId],
      );
      if (!customer) throw new Error("Selected customer not found");
      if (Number(customer.isActive ?? 1) !== 1) throw new Error("Selected customer is inactive");
      const rollbackPoints =
        oldSale.customerId === customerId
          ? Number(customer.loyaltyPoints || 0) +
            getSaleLoyaltySnapshot(oldSale).redeemedPoints -
            getSaleLoyaltySnapshot(oldSale).earnedPoints
          : Number(customer.loyaltyPoints || 0);
      loyaltyRedeemedPoints = Math.min(requestedRedeemPoints, Math.max(0, rollbackPoints));
      loyaltyRedeemedAmount = getRedeemAmountFromPoints(loyaltyRedeemedPoints, subtotal - discount);
      if (requestedRedeemPoints > Math.max(0, rollbackPoints)) {
        throw new Error("Customer does not have enough loyalty points");
      }
    }

    const total = Math.max(0, toMoney(subtotal - discount - loyaltyRedeemedAmount));
    if (paymentMode === "cash" && cashAmount < total) throw new Error("Cash amount is less than total");
    if (paymentMode === "upi" && upiAmount < total) throw new Error("UPI amount is less than total");
    if (paymentMode === "card" && cardAmount < total) throw new Error("Card amount is less than total");
    if (paymentMode === "split" && cashAmount + upiAmount + cardAmount < total) {
      throw new Error("Split payment total is less than bill total");
    }

    const oldItems = await all(
      "SELECT product_id AS productId, qty FROM sale_items WHERE sale_id = ?",
      [saleId],
    );

    for (const item of oldItems) {
      await run("UPDATE products SET stock = stock + ? WHERE id = ?", [item.qty, item.productId]);
    }
    await releaseSaleBatchAllocations(saleId);

    for (const item of items) {
      const stockRow = await get("SELECT stock FROM products WHERE id = ?", [item.id]);
      if (!stockRow) throw new Error(`Product missing (id ${item.id})`);
      // Removed strict stock check to allow negative stock billing
      const batchSummary = await getBatchAvailabilitySummary(item.id);
      if (batchSummary.hasBatchTracking && Number(batchSummary.validBatchQty || 0) < Number(item.qty || 0)) {
        if (Number(batchSummary.validBatchQty || 0) <= 0 && Number(batchSummary.expiredBatchQty || 0) > 0) {
          // Warning only
        }
      }
    }

    await run(
      `UPDATE sales
       SET total = ?, subtotal = ?, discount = ?, payment_mode = ?, cash_amount = ?, upi_amount = ?, card_amount = ?, customer_id = ?,
           loyalty_redeemed_points = ?, loyalty_redeemed_amount = ?
       WHERE id = ?`,
      [
        total,
        subtotal,
        discount,
        paymentMode,
        cashAmount,
        upiAmount,
        cardAmount,
        customerId,
        loyaltyRedeemedPoints,
        loyaltyRedeemedAmount,
        saleId,
      ],
    );
    await run("DELETE FROM sale_items WHERE sale_id = ?", [saleId]);

    for (const item of items) {
      const saleItem = await run(
        "INSERT INTO sale_items(sale_id,product_id,product_name,price,qty,gst_percent,hsn_code,mrp) VALUES(?,?,?,?,?,?,?,?)",
        [
          saleId,
          item.id,
          item.name,
          item.price,
          item.qty,
          Number(item.gstPercent || 0),
          String(item.hsnCode || ""),
          Number(item.mrp || item.originalPrice || item.price || 0),
        ],
      );
      await allocateSaleItemBatches(
        saleId,
        Number(saleItem.lastID),
        item.id,
        item.qty,
        Number(item.preferredBatchId || 0) || null,
      );
      await run("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?", [
        item.qty,
        item.id,
        item.qty,
      ]);
    }

    const oldLoyalty = getSaleLoyaltySnapshot(oldSale);
    const newLoyalty = {
      earnedPoints: customerId ? getSalePoints(total) : 0,
      redeemedPoints: customerId ? loyaltyRedeemedPoints : 0,
    };
    if (oldSale.customerId) {
      if (oldLoyalty.earnedPoints > 0) {
        await run(
          "UPDATE customers SET loyalty_points = CASE WHEN loyalty_points >= ? THEN loyalty_points - ? ELSE 0 END WHERE id = ?",
          [oldLoyalty.earnedPoints, oldLoyalty.earnedPoints, oldSale.customerId],
        );
      }
      if (oldLoyalty.redeemedPoints > 0) {
        await run("UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?", [
          oldLoyalty.redeemedPoints,
          oldSale.customerId,
        ]);
      }
    }
    if (customerId) {
      if (newLoyalty.redeemedPoints > 0) {
        await run(
          "UPDATE customers SET loyalty_points = CASE WHEN loyalty_points >= ? THEN loyalty_points - ? ELSE 0 END WHERE id = ?",
          [newLoyalty.redeemedPoints, newLoyalty.redeemedPoints, customerId],
        );
      }
      if (newLoyalty.earnedPoints > 0) {
        await run("UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?", [
          newLoyalty.earnedPoints,
          customerId,
        ]);
      }
    }

    // --- Khata Reconciliation ---
    if (oldSale.paymentMode === "credit") {
      if (oldSale.customerId) {
        let oldKhataAccount = await get("SELECT id FROM khata_accounts WHERE customer_id = ?", [oldSale.customerId]);
        if (oldKhataAccount) {
          await run("UPDATE khata_accounts SET current_balance = current_balance - ? WHERE id = ?", [oldSale.total, oldKhataAccount.id]);
          await run("DELETE FROM khata_entries WHERE account_id = ? AND sale_id = ?", [oldKhataAccount.id, saleId]);
        }
      }
    }

    if (paymentMode === "credit") {
      if (customerId) {
        let khataAccount = await get("SELECT id FROM khata_accounts WHERE customer_id = ?", [customerId]);
        if (!khataAccount) {
          const accName = String(payload?.customerName || "").trim() || "Walk-in";
          const accPhone = String(payload?.customerPhone || "").trim();
          const acc = await run("INSERT INTO khata_accounts(customer_id, name, phone, opening_balance, current_balance, is_active) VALUES(?, ?, ?, 0, ?, 1)", [customerId, accName, accPhone, total]);
          khataAccount = { id: acc.lastID };
        } else {
          await run("UPDATE khata_accounts SET current_balance = current_balance + ? WHERE id = ?", [total, khataAccount.id]);
        }
        await run("INSERT INTO khata_entries(account_id, entry_type, amount, note, sale_id) VALUES(?, 'sale', ?, 'Credit Sale Updated', ?)", [khataAccount.id, total, saleId]);
      }
    }

    await run("COMMIT");
    await logAuditEvent(
      "sale_update",
      "success",
      performedBy,
      String(saleId),
      `Mode: ${paymentMode}, Total: ${total.toFixed(2)}, Redeemed: ${loyaltyRedeemedPoints}`,
    );
    await enqueueSync("sale", "update", String(saleId), {
      saleId,
      paymentMode,
      total,
      subtotal,
      discount,
      customerId,
      itemCount: items.length,
    });
    return { ok: true, saleId };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "sale_update",
      "failed",
      performedBy,
      String(saleId),
      err?.message || "Update sale failed",
    );
    throw err;
  }
});

ipcMain.handle("delete-sale", async (_event, payload) => {
  const saleId = Number(payload?.saleId);
  const pin = String(payload?.pin || "");
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(saleId) || saleId <= 0) throw new Error("Invalid sale id");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("sale_delete", "failed", performedBy, String(saleId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const sale = await get(
      `SELECT id, total, customer_id AS customerId, loyalty_redeemed_points AS loyaltyRedeemedPoints,
              loyalty_redeemed_amount AS loyaltyRedeemedAmount
       FROM sales WHERE id = ?`,
      [saleId],
    );
    if (!sale) throw new Error("Sale not found");

    const items = await all("SELECT product_id, qty FROM sale_items WHERE sale_id = ?", [saleId]);

    for (const item of items) {
      await run("UPDATE products SET stock = stock + ? WHERE id = ?", [item.qty, item.product_id]);
    }
    await releaseSaleBatchAllocations(saleId);

    await run("DELETE FROM sale_items WHERE sale_id = ?", [saleId]);
    await run("DELETE FROM sales WHERE id = ?", [saleId]);
    if (sale.customerId) {
      const loyalty = getSaleLoyaltySnapshot(sale);
      if (loyalty.earnedPoints > 0) {
        await run(
          "UPDATE customers SET loyalty_points = CASE WHEN loyalty_points >= ? THEN loyalty_points - ? ELSE 0 END WHERE id = ?",
          [loyalty.earnedPoints, loyalty.earnedPoints, sale.customerId],
        );
      }
      if (loyalty.redeemedPoints > 0) {
        await run("UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?", [
          loyalty.redeemedPoints,
          sale.customerId,
        ]);
      }
    }
    await run("COMMIT");
    await logAuditEvent("sale_delete", "success", performedBy, String(saleId), "Sale deleted");
    await enqueueSync("sale", "delete", String(saleId), { saleId });

    return { ok: true };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "sale_delete",
      "failed",
      performedBy,
      String(saleId),
      err?.message || "Delete sale failed",
    );
    throw err;
  }
});

ipcMain.handle("refund-sale", async (_event, payload) => {
  const saleId = Number(payload?.saleId);
  const pin = String(payload?.pin || "").trim();
  const reason = String(payload?.reason || "").trim() || "Sale refund";
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(saleId) || saleId <= 0) throw new Error("Invalid sale id");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("sale_refund", "failed", performedBy, String(saleId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const sale = await get(
      `SELECT s.id, s.total, s.subtotal, s.discount, s.payment_mode AS paymentMode, s.customer_id AS customerId,
              s.loyalty_redeemed_points AS loyaltyRedeemedPoints, s.loyalty_redeemed_amount AS loyaltyRedeemedAmount,
              c.name AS customerName
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.id = ?`,
      [saleId],
    );
    if (!sale) throw new Error("Sale not found");

    const items = await getSaleItemsDetailed(saleId);
    if (!items.length) throw new Error("Sale items not found");

    for (const item of items) {
      await run("UPDATE products SET stock = stock + ? WHERE id = ?", [item.qty, item.id]);
    }
    await releaseSaleBatchAllocations(saleId);

    const returnInsert = await run(
      `INSERT INTO sale_returns(
        original_sale_id, customer_id, customer_name, payment_mode, subtotal, discount,
        loyalty_redeemed_points, loyalty_redeemed_amount, refund_total, reason, items_json,
        refunded_at, performed_by
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        sale.id,
        sale.customerId,
        String(sale.customerName || ""),
        normalizePaymentMode(sale.paymentMode),
        toMoney(sale.subtotal || sale.total),
        toMoney(sale.discount),
        normalizeRedeemPoints(sale.loyaltyRedeemedPoints),
        toMoney(sale.loyaltyRedeemedAmount),
        toMoney(sale.total),
        reason,
        JSON.stringify(
          items.map((item) => ({
            id: Number(item.id),
            name: String(item.name || ""),
            price: toMoney(item.price),
            qty: Number(item.qty || 0),
            gstPercent: toMoney(item.gstPercent),
            hsnCode: String(item.hsnCode || ""),
            originalPrice: toMoney(item.originalPrice ?? item.price),
            preferredBatchId: item.preferredBatchId ? Number(item.preferredBatchId) : null,
            batchNo: String(item.batchNo || ""),
            expiryDate: String(item.expiryDate || ""),
            markdownPercent: Number(item.markdownPercent || 0),
            hasBatchTracking: Boolean(item.hasBatchTracking),
          })),
        ),
        getLocalTimestamp(),
        performedBy,
      ],
    );

    await run("DELETE FROM sale_items WHERE sale_id = ?", [saleId]);
    await run("DELETE FROM sales WHERE id = ?", [saleId]);

    if (sale.customerId) {
      const loyalty = getSaleLoyaltySnapshot(sale);
      if (loyalty.earnedPoints > 0) {
        await run(
          "UPDATE customers SET loyalty_points = CASE WHEN loyalty_points >= ? THEN loyalty_points - ? ELSE 0 END WHERE id = ?",
          [loyalty.earnedPoints, loyalty.earnedPoints, sale.customerId],
        );
      }
      if (loyalty.redeemedPoints > 0) {
        await run("UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?", [
          loyalty.redeemedPoints,
          sale.customerId,
        ]);
      }
    }

    await run("COMMIT");
    await logAuditEvent("sale_refund", "success", performedBy, String(saleId), reason);
    await enqueueSync("sale_return", "create", String(saleId), {
      saleId,
      reason,
      refundTotal: toMoney(sale.total),
      customerId: sale.customerId,
    });
    return { ok: true };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "sale_refund",
      "failed",
      performedBy,
      String(saleId),
      err?.message || "Sale refund failed",
    );
    throw err;
  }
});

ipcMain.handle("refund-sale-items", async (_event, payload) => {
  const saleId = Number(payload?.saleId);
  const pin = String(payload?.pin || "").trim();
  const reason = String(payload?.reason || "").trim() || "Sale return";
  const performedBy = normalizeActor(payload?.performedBy);
  const requestItems = Array.isArray(payload?.items) ? payload.items : [];

  if (!Number.isFinite(saleId) || saleId <= 0) throw new Error("Invalid sale id");
  if (!requestItems.length) throw new Error("No return items provided");

  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("sale_refund", "failed", performedBy, String(saleId), "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const sale = await get(
      `SELECT s.id, s.total, s.subtotal, s.discount, s.payment_mode AS paymentMode,
              s.cash_amount AS cashAmount, s.upi_amount AS upiAmount, s.card_amount AS cardAmount,
              s.customer_id AS customerId, s.loyalty_redeemed_points AS loyaltyRedeemedPoints,
              s.loyalty_redeemed_amount AS loyaltyRedeemedAmount, c.name AS customerName
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.id = ?`,
      [saleId],
    );
    if (!sale) throw new Error("Sale not found");

    const items = await getSaleItemsDetailed(saleId);
    if (!items.length) throw new Error("Sale items not found");

    const lineMap = new Map(items.map((item) => [Number(item.lineId || 0), item]));
    const returnLines = [];

    for (const req of requestItems) {
      const lineId = Number(req.lineId || 0);
      const productId = Number(req.productId || req.id || 0);
      const line = lineMap.get(lineId) || items.find((row) => Number(row.id || 0) === productId);
      if (!line) throw new Error("Invalid return item");
      const qty = Math.max(0, Math.floor(Number(req.qty || req.returnQty || 0)));
      if (!qty) continue;
      if (qty > Number(line.qty || 0)) {
        throw new Error(`Return qty exceeds sold qty for ${line.name || "item"}`);
      }
      returnLines.push({ ...line, returnQty: qty });
    }

    if (!returnLines.length) throw new Error("Enter at least one return quantity");

    const baseSubtotal = toMoney(sale.subtotal || sale.total);
    const refundSubtotal = toMoney(
      returnLines.reduce((sum, item) => sum + toMoney(item.price) * Number(item.returnQty || 0), 0),
    );
    const ratio = baseSubtotal > 0 ? refundSubtotal / baseSubtotal : 0;
    const refundDiscount = toMoney(toMoney(sale.discount) * ratio);
    const refundLoyaltyAmount = toMoney(toMoney(sale.loyaltyRedeemedAmount) * ratio);
    const refundTotal = toMoney(Math.max(0, refundSubtotal - refundDiscount - refundLoyaltyAmount));
    const refundRedeemedPoints = Math.min(
      Number(sale.loyaltyRedeemedPoints || 0),
      Math.round(Number(sale.loyaltyRedeemedPoints || 0) * ratio),
    );

    const returnByProduct = new Map();
    returnLines.forEach((item) => {
      const key = Number(item.id);
      returnByProduct.set(key, (returnByProduct.get(key) || 0) + Number(item.returnQty || 0));
    });

    for (const [productId, qty] of returnByProduct.entries()) {
      await run("UPDATE products SET stock = stock + ? WHERE id = ?", [qty, productId]);
      await reduceSaleBatchAllocationsForProduct(saleId, productId, qty);
      await run("UPDATE sale_items SET qty = qty - ? WHERE sale_id = ? AND product_id = ?", [
        qty,
        saleId,
        productId,
      ]);
      await run("DELETE FROM sale_items WHERE sale_id = ? AND product_id = ? AND qty <= 0", [
        saleId,
        productId,
      ]);
    }

    const remainingRow = await get("SELECT COUNT(*) AS count FROM sale_items WHERE sale_id = ?", [saleId]);
    const remainingCount = Number(remainingRow?.count || 0);

    const newSubtotal = toMoney(Math.max(0, baseSubtotal - refundSubtotal));
    const newDiscount = toMoney(Math.max(0, toMoney(sale.discount) - refundDiscount));
    const newLoyaltyAmount = toMoney(Math.max(0, toMoney(sale.loyaltyRedeemedAmount) - refundLoyaltyAmount));
    const newTotal = toMoney(Math.max(0, toMoney(sale.total) - refundTotal));
    const newRedeemedPoints = Math.max(0, Number(sale.loyaltyRedeemedPoints || 0) - refundRedeemedPoints);

    if (remainingCount <= 0) {
      await releaseSaleBatchAllocations(saleId);
      await run("DELETE FROM sale_items WHERE sale_id = ?", [saleId]);
      await run("DELETE FROM sales WHERE id = ?", [saleId]);
    } else {
      const ratioTotal = Number(sale.total || 0) > 0 ? refundTotal / Number(sale.total || 0) : 0;
      const newCashAmount = toMoney(Math.max(0, Number(sale.cashAmount || 0) * (1 - ratioTotal)));
      const newUpiAmount = toMoney(Math.max(0, Number(sale.upiAmount || 0) * (1 - ratioTotal)));
      const newCardAmount = toMoney(Math.max(0, Number(sale.cardAmount || 0) * (1 - ratioTotal)));

      await run(
        `UPDATE sales
         SET subtotal = ?, discount = ?, loyalty_redeemed_points = ?, loyalty_redeemed_amount = ?,
             total = ?, cash_amount = ?, upi_amount = ?, card_amount = ?
         WHERE id = ?`,
        [
          newSubtotal,
          newDiscount,
          newRedeemedPoints,
          newLoyaltyAmount,
          newTotal,
          newCashAmount,
          newUpiAmount,
          newCardAmount,
          saleId,
        ],
      );
    }

    if (sale.customerId) {
      const prevEarned = getSalePoints(toMoney(sale.total));
      const newEarned = getSalePoints(newTotal);
      const reducePoints = Math.max(0, prevEarned - newEarned);
      if (reducePoints > 0) {
        await run(
          "UPDATE customers SET loyalty_points = CASE WHEN loyalty_points >= ? THEN loyalty_points - ? ELSE 0 END WHERE id = ?",
          [reducePoints, reducePoints, sale.customerId],
        );
      }
      if (refundRedeemedPoints > 0) {
        await run("UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?", [
          refundRedeemedPoints,
          sale.customerId,
        ]);
      }
    }

    await run(
      `INSERT INTO sale_returns(
        original_sale_id, customer_id, customer_name, payment_mode, subtotal, discount,
        loyalty_redeemed_points, loyalty_redeemed_amount, refund_total, reason, items_json,
        refunded_at, performed_by
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        sale.id,
        sale.customerId,
        String(sale.customerName || ""),
        normalizePaymentMode(sale.paymentMode),
        refundSubtotal,
        refundDiscount,
        refundRedeemedPoints,
        refundLoyaltyAmount,
        refundTotal,
        reason,
        JSON.stringify(
          returnLines.map((item) => ({
            id: Number(item.id),
            name: String(item.name || ""),
            price: toMoney(item.price),
            qty: Number(item.returnQty || 0),
            gstPercent: toMoney(item.gstPercent),
            hsnCode: String(item.hsnCode || ""),
            originalPrice: toMoney(item.originalPrice ?? item.price),
            preferredBatchId: item.preferredBatchId ? Number(item.preferredBatchId) : null,
            batchNo: String(item.batchNo || ""),
            expiryDate: String(item.expiryDate || ""),
            markdownPercent: Number(item.markdownPercent || 0),
            hasBatchTracking: Boolean(item.hasBatchTracking),
          })),
        ),
        getLocalTimestamp(),
        performedBy,
      ],
    );

    await run("COMMIT");
    await logAuditEvent("sale_refund", "success", performedBy, String(saleId), reason);
    await enqueueSync("sale_return", "create", String(saleId), {
      saleId,
      reason,
      refundTotal,
      customerId: sale.customerId,
      partial: true,
    });
    return { ok: true, refundTotal, returnId: Number(returnInsert?.lastID || 0) || null };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "sale_refund",
      "failed",
      performedBy,
      String(saleId),
      err?.message || "Sale return failed",
    );
    throw err;
  }
});

ipcMain.handle("get-sale-returns", async () => {
  const rows = await all(
    `SELECT id, original_sale_id AS originalSaleId, customer_id AS customerId, customer_name AS customerName,
            payment_mode AS paymentMode, subtotal, discount, loyalty_redeemed_points AS loyaltyRedeemedPoints,
            loyalty_redeemed_amount AS loyaltyRedeemedAmount, refund_total AS refundTotal, reason, items_json AS itemsJson,
            refunded_at AS refundedAt, performed_by AS performedBy
     FROM sale_returns
     ORDER BY id DESC`,
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        id: Number(row.id),
        originalSaleId: Number(row.originalSaleId || 0),
        customerId: row.customerId ? Number(row.customerId) : null,
        customerName: String(row.customerName || ""),
        paymentMode: normalizePaymentMode(row.paymentMode),
        subtotal: toMoney(row.subtotal),
        discount: toMoney(row.discount),
        loyaltyRedeemedPoints: Number(row.loyaltyRedeemedPoints || 0),
        loyaltyRedeemedAmount: toMoney(row.loyaltyRedeemedAmount),
        refundTotal: toMoney(row.refundTotal),
        reason: String(row.reason || ""),
        itemsJson: String(row.itemsJson || "[]"),
        refundedAt: String(row.refundedAt || ""),
        performedBy: String(row.performedBy || ""),
      }))
    : [];
});

ipcMain.handle("get-sale-return-details", async (_event, returnId) => {
  const id = Number(returnId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid refund id");

  const row = await get(
    `SELECT id, original_sale_id AS originalSaleId, customer_id AS customerId, customer_name AS customerName,
            payment_mode AS paymentMode, subtotal, discount, loyalty_redeemed_points AS loyaltyRedeemedPoints,
            loyalty_redeemed_amount AS loyaltyRedeemedAmount, refund_total AS refundTotal, reason,
            items_json AS itemsJson, refunded_at AS refundedAt, performed_by AS performedBy
     FROM sale_returns
     WHERE id = ?`,
    [id],
  );
  if (!row) throw new Error("Refund record not found");

  let items = [];
  try {
    const parsed = JSON.parse(String(row.itemsJson || "[]"));
    items = Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    items = [];
  }

  return {
    id: Number(row.id),
    originalSaleId: Number(row.originalSaleId || 0),
    customerId: row.customerId ? Number(row.customerId) : null,
    customerName: String(row.customerName || ""),
    paymentMode: normalizePaymentMode(row.paymentMode),
    subtotal: toMoney(row.subtotal),
    discount: toMoney(row.discount),
    loyaltyRedeemedPoints: Number(row.loyaltyRedeemedPoints || 0),
    loyaltyRedeemedAmount: toMoney(row.loyaltyRedeemedAmount),
    refundTotal: toMoney(row.refundTotal),
    reason: String(row.reason || ""),
    refundedAt: String(row.refundedAt || ""),
    performedBy: String(row.performedBy || ""),
    items: items.map((item) => ({
      id: Number(item.id || 0),
      name: String(item.name || ""),
      price: toMoney(item.price),
      qty: Number(item.qty || 0),
      gstPercent: toMoney(item.gstPercent),
      hsnCode: String(item.hsnCode || ""),
      originalPrice: toMoney(item.originalPrice ?? item.price),
      preferredBatchId: item.preferredBatchId ? Number(item.preferredBatchId) : null,
      batchNo: String(item.batchNo || ""),
      expiryDate: String(item.expiryDate || ""),
      markdownPercent: Number(item.markdownPercent || 0),
      hasBatchTracking: Boolean(item.hasBatchTracking),
    })),
  };
});

ipcMain.handle("create-stock-adjustment", async (_event, payload) => {
  const productId = Number(payload?.productId);
  const adjustmentType = String(payload?.adjustmentType || "").trim().toLowerCase();
  const quantity = Math.max(0, Math.floor(Number(payload?.quantity || 0)));
  const reason = String(payload?.reason || "").trim() || "Manual stock adjustment";
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(productId) || productId <= 0) throw new Error("Select a valid product");
  if (!["add", "subtract", "set"].includes(adjustmentType)) {
    throw new Error("Invalid adjustment type");
  }
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Enter valid quantity");

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const product = await get(
      "SELECT id, name, barcode, stock FROM products WHERE id = ? AND COALESCE(is_archived, 0) = 0",
      [productId],
    );
    if (!product) throw new Error("Product not found");

    const beforeQty = Number(product.stock || 0);
    let afterQty = beforeQty;
    let qtyChange = 0;

    if (adjustmentType === "add") {
      qtyChange = quantity;
      afterQty = beforeQty + quantity;
    } else if (adjustmentType === "subtract") {
      if (quantity > beforeQty) throw new Error("Adjustment exceeds current stock");
      qtyChange = -quantity;
      afterQty = beforeQty - quantity;
    } else {
      afterQty = quantity;
      qtyChange = quantity - beforeQty;
    }

    await run("UPDATE products SET stock = ? WHERE id = ?", [afterQty, productId]);
    const result = await run(
      `INSERT INTO stock_adjustments(
        product_id, product_name, barcode, adjustment_type, qty_before, qty_change,
        qty_after, reason, created_at, performed_by
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        productId,
        String(product.name || ""),
        String(product.barcode || ""),
        adjustmentType,
        beforeQty,
        qtyChange,
        afterQty,
        reason,
        getLocalTimestamp(),
        performedBy,
      ],
    );
    await run("COMMIT");
    await logAuditEvent(
      "stock_adjustment",
      "success",
      performedBy,
      `${product.name} (${product.barcode})`,
      `${adjustmentType} ${qtyChange >= 0 ? "+" : ""}${qtyChange} | ${reason}`,
    );
    await enqueueSync("stock_adjustment", "create", String(result.lastID), {
      adjustmentId: Number(result.lastID),
      productId,
      adjustmentType,
      qtyChange,
      qtyAfter: afterQty,
      reason,
    });
    return { ok: true, adjustmentId: result.lastID, qtyAfter: afterQty };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "stock_adjustment",
      "failed",
      performedBy,
      String(productId),
      err?.message || "Stock adjustment failed",
    );
    throw err;
  }
});

ipcMain.handle("get-stock-adjustments", async () => {
  const rows = await all(
    `SELECT id, product_id AS productId, product_name AS productName, barcode, adjustment_type AS adjustmentType,
            qty_before AS qtyBefore, qty_change AS qtyChange, qty_after AS qtyAfter,
            reason, created_at AS createdAt, performed_by AS performedBy, is_reversed AS isReversed,
            reversed_at AS reversedAt, reversed_by AS reversedBy
     FROM stock_adjustments
     ORDER BY id DESC
     LIMIT 300`,
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        id: Number(row.id),
        productId: Number(row.productId || 0),
        productName: String(row.productName || ""),
        barcode: String(row.barcode || ""),
        adjustmentType: String(row.adjustmentType || ""),
        qtyBefore: Number(row.qtyBefore || 0),
        qtyChange: Number(row.qtyChange || 0),
        qtyAfter: Number(row.qtyAfter || 0),
        reason: String(row.reason || ""),
        createdAt: String(row.createdAt || ""),
        performedBy: String(row.performedBy || ""),
        isReversed: Number(row.isReversed || 0),
        reversedAt: String(row.reversedAt || ""),
        reversedBy: String(row.reversedBy || ""),
      }))
    : [];
});

ipcMain.handle("reverse-stock-adjustment", async (_event, payload) => {
  const adjustmentId = Number(payload?.adjustmentId);
  const pin = String(payload?.pin || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!Number.isFinite(adjustmentId) || adjustmentId <= 0) throw new Error("Invalid adjustment id");
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent(
      "stock_adjustment_reverse",
      "failed",
      performedBy,
      String(adjustmentId),
      "Invalid admin PIN",
    );
    throw new Error("Invalid admin PIN");
  }

  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const adjustment = await get(
      `SELECT id, product_id AS productId, product_name AS productName, barcode, adjustment_type AS adjustmentType,
              qty_before AS qtyBefore, qty_change AS qtyChange, qty_after AS qtyAfter,
              is_reversed AS isReversed
       FROM stock_adjustments
       WHERE id = ?`,
      [adjustmentId],
    );
    if (!adjustment) throw new Error("Adjustment not found");
    if (Number(adjustment.isReversed || 0) === 1) throw new Error("Adjustment already reversed");

    const product = await get("SELECT id, stock FROM products WHERE id = ?", [adjustment.productId]);
    if (!product) throw new Error("Product not found");

    const currentStock = Number(product.stock || 0);
    const qtyChange = Number(adjustment.qtyChange || 0);
    let nextStock = currentStock;

    if (String(adjustment.adjustmentType || "").toLowerCase() === "set") {
      if (currentStock !== Number(adjustment.qtyAfter || 0)) {
        throw new Error("Set adjustment can only be reversed when current stock matches adjusted stock");
      }
      nextStock = Number(adjustment.qtyBefore || 0);
    } else if (qtyChange > 0) {
      if (currentStock < qtyChange) {
        throw new Error("Not enough stock to reverse this adjustment");
      }
      nextStock = currentStock - qtyChange;
    } else {
      nextStock = currentStock + Math.abs(qtyChange);
    }

    await run("UPDATE products SET stock = ? WHERE id = ?", [nextStock, adjustment.productId]);
    await run(
      "UPDATE stock_adjustments SET is_reversed = 1, reversed_at = ?, reversed_by = ? WHERE id = ?",
      [getLocalTimestamp(), performedBy, adjustmentId],
    );
    await run("COMMIT");
    await logAuditEvent(
      "stock_adjustment_reverse",
      "success",
      performedBy,
      `${adjustment.productName} (${adjustment.barcode})`,
      `Adjustment #${adjustmentId} reversed`,
    );
    await enqueueSync("stock_adjustment", "reverse", String(adjustmentId), {
      adjustmentId,
      productId: adjustment.productId,
      qtyAfter: nextStock,
    });
    return { ok: true, qtyAfter: nextStock };
  } catch (err) {
    await run("ROLLBACK");
    await logAuditEvent(
      "stock_adjustment_reverse",
      "failed",
      performedBy,
      String(adjustmentId),
      err?.message || "Stock adjustment reverse failed",
    );
    throw err;
  }
});

ipcMain.handle("update-admin-pin", async (_event, payload) => {
  const currentPin = String(payload?.currentPin || "").trim();
  const newPin = String(payload?.newPin || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);

  if (!currentPin || !newPin) {
    await logAuditEvent(
      "admin_pin_update",
      "failed",
      performedBy,
      "",
      "Current PIN and New PIN are required",
    );
    throw new Error("Current PIN and New PIN are required");
  }
  if (!/^\d{4,10}$/.test(newPin)) {
    await logAuditEvent(
      "admin_pin_update",
      "failed",
      performedBy,
      "",
      "New PIN must be 4 to 10 digits",
    );
    throw new Error("New PIN must be 4 to 10 digits");
  }

  const adminPin = await getAdminPin();
  if (currentPin !== adminPin) {
    await logAuditEvent("admin_pin_update", "failed", performedBy, "", "Current PIN is incorrect");
    throw new Error("Current PIN is incorrect");
  }

  await run("INSERT OR REPLACE INTO settings(key, value) VALUES('admin_pin', ?)", [newPin]);
  await logAuditEvent("admin_pin_update", "success", performedBy, "", "Admin PIN updated");
  return { ok: true };
});

ipcMain.handle("get-store-settings", async () => {
  return getStoreSettings();
});

ipcMain.handle("save-store-settings", async (_event, payload) => {
  const performedBy = normalizeActor(payload?.performedBy);
  const storeName = String(payload?.storeName || "").trim() || "GSM SUPER MARKET";
  const storeAddress = String(payload?.storeAddress || "").trim();
  const storePhone = String(payload?.storePhone || "").trim();
  const storeGstin = String(payload?.storeGstin || "").trim().toUpperCase();
  const receiptFooter = String(payload?.receiptFooter || "").trim() || "*** THANK YOU ðŸ™ VISIT AGAIN ***";
  const receiptTnc = String(payload?.receiptTnc || "").trim() || "*.Items Are Exchanged Within 7 Days";
  const logoPath = String(payload?.logoPath || "").trim();
  const appLanguage = String(payload?.appLanguage || "en").trim().toLowerCase();
  const upiVpa = String(payload?.upiVpa || "").trim().toLowerCase();

  await setSettingValue("store_name", storeName);
  await setSettingValue("store_address", storeAddress);
  await setSettingValue("store_phone", storePhone);
  await setSettingValue("store_gstin", storeGstin);
  await setSettingValue("store_receipt_footer", receiptFooter);
  await setSettingValue("store_receipt_tnc", receiptTnc);
  await setSettingValue("store_logo_path", logoPath);
  await setSettingValue("app_language", ["en", "hi", "kn"].includes(appLanguage) ? appLanguage : "en");
  await setSettingValue("store_upi_vpa", upiVpa);

  await logAuditEvent(
    "store_settings",
    "success",
    performedBy,
    "",
    `Store: ${storeName}${storeGstin ? ` | GSTIN: ${storeGstin}` : ""}${upiVpa ? ` | UPI: ${upiVpa}` : ""}`,
  );
  await enqueueSync("settings", "store_update", "store_profile", {
    storeName,
    storeAddress,
    storePhone,
    storeGstin,
    receiptFooter,
    logoPath,
    appLanguage,
    upiVpa,
  });

  return { ok: true };
});

// Generate UPI QR code as a base64 PNG data URL
ipcMain.handle("generate-upi-qr", async (_event, data) => {
  const QRCode = require("qrcode");
  const upiVpa = String(data?.upiVpa || "").trim();
  const amount = Number(data?.amount || 0);
  const storeName = String(data?.storeName || "Shop").trim();
  const note = String(data?.note || "Payment").trim();

  if (!upiVpa) throw new Error("UPI VPA (UPI ID) is not configured. Please set it in Store Settings.");

  // Build standard UPI deep link
  const encodedName = encodeURIComponent(storeName);
  const encodedNote = encodeURIComponent(note);
  const upiLink = `upi://pay?pa=${upiVpa}&pn=${encodedName}&am=${amount.toFixed(2)}&cu=INR&tn=${encodedNote}`;

  const dataUrl = await QRCode.toDataURL(upiLink, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 300,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return { dataUrl, upiLink, upiVpa };
});

ipcMain.handle("get-hardware-settings", async () => {
  return getHardwareSettings();
});

ipcMain.handle("save-hardware-settings", async (_event, payload) => {
  const performedBy = normalizeActor(payload?.performedBy);
  const defaultPrintMode = String(payload?.defaultPrintMode || "thermal").trim().toLowerCase();
  const thermalPrinterDevice = String(payload?.thermalPrinterDevice || "").trim();
  const thermalPrinterWidth = String(payload?.thermalPrinterWidth || "80mm").trim();
  const barcodeLabelFormat = String(payload?.barcodeLabelFormat || "3-across").trim();
  const scannerSubmitMode = String(payload?.scannerSubmitMode || "enter").trim().toLowerCase();
  const scannerFocusLock = Boolean(payload?.scannerFocusLock);
  const customerDisplayEnabled = Boolean(payload?.customerDisplayEnabled);
  const customerDisplayAutoOpen = Boolean(payload?.customerDisplayAutoOpen);
  const customerDisplayX = String(payload?.customerDisplayX ?? "").trim();
  const customerDisplayY = String(payload?.customerDisplayY ?? "").trim();
  const customerDisplayWidth = Math.max(420, Number(payload?.customerDisplayWidth || 900));
  const customerDisplayHeight = Math.max(260, Number(payload?.customerDisplayHeight || 540));
  const customerDisplayFullscreen = Boolean(payload?.customerDisplayFullscreen);
  const cashDrawerEnabled = Boolean(payload?.cashDrawerEnabled);
  const cashDrawerCommand = String(payload?.cashDrawerCommand || "").trim();
  const cashDrawerOnCashSale = Boolean(payload?.cashDrawerOnCashSale);
  const validFontSizes = ["small", "normal", "large", "xlarge", "xxlarge"];
  const uiFontSize = validFontSizes.includes(String(payload?.uiFontSize || "").trim())
    ? String(payload.uiFontSize).trim()
    : "normal";

  if (!["thermal", "a4"].includes(defaultPrintMode)) {
    throw new Error("Default print mode must be thermal or a4");
  }
  if (!["enter", "enter_tab"].includes(scannerSubmitMode)) {
    throw new Error("Scanner submit mode must be enter or enter_tab");
  }

  await setSettingValue("hardware_default_print_mode", defaultPrintMode);
  await setSettingValue("hardware_thermal_printer_device", thermalPrinterDevice);
  await setSettingValue("hardware_thermal_printer_width", thermalPrinterWidth);
  await setSettingValue("hardware_barcode_label_format", barcodeLabelFormat);
  await setSettingValue("hardware_scanner_submit_mode", scannerSubmitMode);
  await setSettingValue("hardware_scanner_focus_lock", scannerFocusLock ? "1" : "0");
  await setSettingValue("hardware_customer_display_enabled", customerDisplayEnabled ? "1" : "0");
  await setSettingValue("hardware_customer_display_auto_open", customerDisplayAutoOpen ? "1" : "0");
  await setSettingValue("hardware_customer_display_x", customerDisplayX);
  await setSettingValue("hardware_customer_display_y", customerDisplayY);
  await setSettingValue("hardware_customer_display_width", customerDisplayWidth);
  await setSettingValue("hardware_customer_display_height", customerDisplayHeight);
  await setSettingValue("hardware_customer_display_fullscreen", customerDisplayFullscreen ? "1" : "0");
  await setSettingValue("hardware_cash_drawer_enabled", cashDrawerEnabled ? "1" : "0");
  await setSettingValue("hardware_cash_drawer_command", cashDrawerCommand);
  await setSettingValue("hardware_cash_drawer_on_cash_sale", cashDrawerOnCashSale ? "1" : "0");
  await setSettingValue("hardware_ui_font_size", uiFontSize);

  await logAuditEvent(
    "hardware_settings",
    "success",
    performedBy,
    "",
    `Print: ${defaultPrintMode}, Scanner: ${scannerSubmitMode}, Display: ${customerDisplayEnabled ? "On" : "Off"}, Drawer: ${cashDrawerEnabled ? "On" : "Off"}`,
  );
  await enqueueSync("settings", "hardware_update", "hardware", {
    defaultPrintMode,
    scannerSubmitMode,
    customerDisplayEnabled,
    cashDrawerEnabled,
  });

  return { ok: true };
});

ipcMain.handle("get-hardware-diagnostics", async () => {
  const settings = await getHardwareSettings();
  const printers = mainWindow && !mainWindow.isDestroyed()
    ? await mainWindow.webContents.getPrintersAsync()
    : [];
  const displays = screen.getAllDisplays().map((display) => ({
    id: Number(display.id),
    label: String(display.label || `Display ${display.id}`),
    width: Number(display.size?.width || 0),
    height: Number(display.size?.height || 0),
    scaleFactor: Number(display.scaleFactor || 1),
    internal: Boolean(display.internal),
    x: Number(display.bounds?.x || 0),
    y: Number(display.bounds?.y || 0),
  }));
  const backupFiles = listBackupFiles();

  return {
    appVersion: String(packageJson.version || app.getVersion()),
    electronVersion: String(process.versions.electron || ""),
    chromeVersion: String(process.versions.chrome || ""),
    nodeVersion: String(process.versions.node || ""),
    dbPath: DB_FILE,
    backupDir: BACKUP_DIR,
    backupCount: Number(backupFiles.length || 0),
    customerDisplayOpen: Boolean(customerDisplayWindow && !customerDisplayWindow.isDestroyed()),
    mobileCompanionOpen: Boolean(mobileCompanionWindow && !mobileCompanionWindow.isDestroyed()),
    settings,
    printers: Array.isArray(printers)
      ? printers.map((printer) => ({
          name: String(printer.name || ""),
          displayName: String(printer.displayName || printer.name || ""),
          description: String(printer.description || ""),
          isDefault: Boolean(printer.isDefault),
          status: Number(printer.status ?? 0),
          options: printer.options || {},
        }))
      : [],
    displays,
  };
});

ipcMain.handle("customer-display-open", async () => {
  return updateCustomerDisplay(
    {
      headline: "Ready",
      subline: "Customer display connected",
      totalText: "Rs. 0.00",
      itemsText: "0 items",
    },
    { forceShow: true },
  );
});

ipcMain.handle("customer-display-update", async (_event, payload) => {
  return updateCustomerDisplay(payload, { forceShow: false });
});

ipcMain.handle("customer-display-close", async () => {
  return closeCustomerDisplay();
});

ipcMain.handle("customer-display-test", async () => {
  return updateCustomerDisplay(
    {
      headline: "Test Mode",
      subline: "Customer display is working",
      totalText: "Rs. 245.00",
      itemsText: "3 items",
      savingsText: "You saved Rs. 15.00",
    },
    { forceShow: true },
  );
});

ipcMain.handle("mobile-companion-open", async () => {
  return updateMobileCompanion(
    {
      title: "BillSwift Mobile",
      headline: "Dashboard",
      subline: "Companion preview connected",
      primaryValue: "Rs. 0.00",
      secondaryValue: "Ready for live updates",
      chips: ["Today Revenue", "0 Bills", "0 Low Stock"],
    },
    { forceShow: true },
  );
});

ipcMain.handle("mobile-companion-update", async (_event, payload) => {
  return updateMobileCompanion(payload, { forceShow: false });
});

ipcMain.handle("mobile-companion-close", async () => {
  return closeMobileCompanion();
});

ipcMain.handle("mobile-companion-test", async () => {
  return updateMobileCompanion(
    {
      title: "BillSwift Mobile",
      headline: "Today Revenue",
      subline: "Remote companion preview",
      primaryValue: "Rs. 12,480.00",
      secondaryValue: "9 bills | 3 low stock items",
      chips: ["Top: Amul Milk", "UPI Rs. 4,320.00", "Queue: 6 pending sync items"],
    },
    { forceShow: true },
  );
});

ipcMain.handle("get-sync-status", async () => {
  const totals = await get(
    `SELECT
        COUNT(*) AS totalItems,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pendingCount,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failedCount,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completedCount,
        MAX(updated_at) AS lastUpdatedAt
     FROM sync_queue`,
  );
  return {
    totalItems: Number(totals?.totalItems || 0),
    pendingCount: Number(totals?.pendingCount || 0),
    failedCount: Number(totals?.failedCount || 0),
    completedCount: Number(totals?.completedCount || 0),
    lastUpdatedAt: String(totals?.lastUpdatedAt || ""),
    mode: "foundation",
  };
});

ipcMain.handle("get-sync-queue", async (_event, payload) => {
  const limit = Math.max(20, Math.min(500, Number(payload?.limit || 150)));
  const rows = await all(
    `SELECT id, entity_type AS entityType, action_type AS actionType, entity_id AS entityId,
            payload_json AS payloadJson, status, retry_count AS retryCount,
            last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
     FROM sync_queue
     ORDER BY id DESC
     LIMIT ?`,
    [limit],
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        id: Number(row.id || 0),
        entityType: String(row.entityType || ""),
        actionType: String(row.actionType || ""),
        entityId: String(row.entityId || ""),
        payloadJson: String(row.payloadJson || "{}"),
        status: String(row.status || "pending"),
        retryCount: Number(row.retryCount || 0),
        lastError: String(row.lastError || ""),
        createdAt: String(row.createdAt || ""),
        updatedAt: String(row.updatedAt || ""),
      }))
    : [];
});

ipcMain.handle("clear-sync-queue", async (_event, payload) => {
  const pin = String(payload?.pin || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);
  const mode = String(payload?.mode || "completed").trim().toLowerCase();
  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logAuditEvent("sync_queue_clear", "failed", performedBy, mode, "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  let result;
  if (mode === "all") {
    result = await run("DELETE FROM sync_queue");
  } else {
    result = await run("DELETE FROM sync_queue WHERE status <> 'pending'");
  }
  await logAuditEvent(
    "sync_queue_clear",
    "success",
    performedBy,
    mode,
    `Deleted ${Number(result?.changes || 0)} sync queue row(s)`,
  );
  return { ok: true, deleted: Number(result?.changes || 0) };
});

ipcMain.handle("trigger-cash-drawer", async (_event, payload) => {
  const performedBy = normalizeActor(payload?.performedBy);
  const settings = await getHardwareSettings();
  if (!settings.cashDrawerEnabled) {
    return { ok: true, mode: "disabled" };
  }
  const command = String(settings.cashDrawerCommand || "").trim();
  if (!command) {
    return { ok: true, mode: "not_configured" };
  }

  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true }, async (error, stdout, stderr) => {
      if (error) {
        await logAuditEvent(
          "cash_drawer_trigger",
          "failed",
          performedBy,
          "",
          stderr || error.message || "Cash drawer command failed",
        );
        reject(new Error(stderr || error.message || "Cash drawer command failed"));
        return;
      }
      await logAuditEvent(
        "cash_drawer_trigger",
        "success",
        performedBy,
        "",
        String(stdout || "Cash drawer command executed").trim(),
      );
      resolve({ ok: true, mode: "command", output: String(stdout || "").trim() });
    });
  });
});

ipcMain.handle("create-backup-now", async (_event, payload) => {
  const performedBy = normalizeActor(payload?.performedBy);
  try {
    const result = await createDailyBackup({ force: true });
    await logBackupEvent("manual_backup", "success", "Manual backup created", result.backupPath);
    await logAuditEvent("backup_manual", "success", performedBy, result.backupPath, "Manual backup created");
    if (result.deletedOldBackups > 0) {
      await logBackupEvent(
        "backup_cleanup",
        "success",
        `Deleted ${result.deletedOldBackups} old backup(s)`,
        "",
      );
      await logAuditEvent(
        "backup_cleanup",
        "success",
        performedBy,
        "",
        `Deleted ${result.deletedOldBackups} old backup(s)`,
      );
    }
    return { ok: true, ...result };
  } catch (err) {
    await logBackupEvent("manual_backup", "failed", err?.message || "Manual backup failed", "");
    await logAuditEvent(
      "backup_manual",
      "failed",
      performedBy,
      "",
      err?.message || "Manual backup failed",
    );
    throw new Error(err?.message || "Backup failed");
  }
});

ipcMain.handle("get-backup-status", async () => {
  return getBackupStatus();
});

ipcMain.handle("get-backup-files", async () => {
  return listBackupFiles();
});

ipcMain.handle("get-backup-logs", async () => {
  return all(
    "SELECT id, action, status, message, backup_path AS backupPath, created_at AS createdAt FROM backup_logs ORDER BY id DESC LIMIT 200",
  );
});

ipcMain.handle("get-audit-logs", async () => {
  return all(
    "SELECT id, action, status, actor, target, message, created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 400",
  );
});

// REPORTS API
ipcMain.handle("get-report-sales-list", async (_event, payload) => {
  const { fromDate, toDate } = payload || {};
  const query = `
    SELECT s.id as billNo, s.date, c.name as customerName, s.subtotal, s.discount, s.total, 
           (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) as itemsCount
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    WHERE s.date >= ? AND s.date <= ?
    ORDER BY s.date DESC
  `;
  return all(query, [fromDate + " 00:00:00", toDate + " 23:59:59"]);
});

// BILL-WISE SALES REPORT
ipcMain.handle("get-bill-wise-sales-report", async (_event, payload) => {
  const { fromDate, toDate } = payload || {};
  const safeFrom = String(fromDate || "").trim();
  const safeTo = String(toDate || "").trim();
  if (!safeFrom || !safeTo) throw new Error("Date range required");
  const query = `
    SELECT
      s.id                                           AS voucherNo,
      s.date                                         AS voucherDate,
      'Sales'                                        AS voucherType,
      COALESCE(c.name, 'Walk-in')                    AS partyName,
      COALESCE(c.phone, '')                          AS mobileNo,
      COALESCE(s.total, 0)                           AS netAmount,
      COALESCE(s.cash_amount, 0)                     AS cashAmount,
      COALESCE(s.upi_amount, 0)                      AS upiAmount,
      COALESCE(s.card_amount, 0)                     AS cardAmount,
      CASE WHEN LOWER(COALESCE(s.payment_mode,'cash')) = 'credit'
           THEN COALESCE(s.total, 0) ELSE 0 END      AS creditAmount,
      COALESCE(s.payment_mode, 'cash')               AS paymentMode
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.date >= ? AND s.date <= ?
    ORDER BY s.date ASC, s.id ASC
  `;
  const rows = await all(query, [safeFrom + " 00:00:00", safeTo + " 23:59:59"]);
  return rows;
});

ipcMain.handle("get-report-purchases-list", async (_event, payload) => {
  const { fromDate, toDate } = payload || {};
  const query = `
    SELECT p.invoice_no as invoiceNo, p.created_at as date, s.name as supplierName, p.total as subtotal, 0 as discount, p.total,
           (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) as itemsCount
    FROM purchases p
    LEFT JOIN suppliers s ON p.supplier_id = s.id
    WHERE p.created_at >= ? AND p.created_at <= ?
    ORDER BY p.created_at DESC
  `;
  return all(query, [fromDate + " 00:00:00", toDate + " 23:59:59"]);
});

ipcMain.handle("get-report-gstr1", async (_event, payload) => {
  const { fromDate, toDate } = payload || {};
  const query = `
    SELECT 
      s.date as invoiceDate,
      s.id as invoiceNo,
      COALESCE(c.name, 'Walk-in') as customerName,
      COALESCE(si.gst_percent, 0) AS gstRate,
      COALESCE(SUM((si.price * si.qty) * 100.0 / (100.0 + COALESCE(NULLIF(si.gst_percent, 0), 0))), SUM(si.price * si.qty)) AS taxableValue,
      COALESCE(SUM((si.price * si.qty) - ((si.price * si.qty) * 100.0 / (100.0 + COALESCE(NULLIF(si.gst_percent, 0), 0)))), 0) AS gstAmount,
      COALESCE(SUM(si.price * si.qty), 0) AS totalInvoiceValue
    FROM sale_items si
    JOIN sales s ON si.sale_id = s.id
    LEFT JOIN customers c ON s.customer_id = c.id
    WHERE s.date >= ? AND s.date <= ?
    GROUP BY s.id, COALESCE(si.gst_percent, 0)
    ORDER BY s.date ASC
  `;
  return all(query, [fromDate + " 00:00:00", toDate + " 23:59:59"]);
});

ipcMain.handle("get-report-gstr2", async (_event, payload) => {
  const { fromDate, toDate } = payload || {};
  const query = `
    SELECT 
      p.created_at as invoiceDate,
      p.invoice_no as invoiceNo,
      sup.name as supplierName,
      sup.gstin as supplierGstin,
      COALESCE(prod.gst_percent, 0) AS gstRate,
      COALESCE(SUM(pi.line_total), 0) AS taxableValue,
      COALESCE(SUM(pi.line_total * COALESCE(prod.gst_percent, 0) / 100.0), 0) AS gstAmount,
      COALESCE(SUM(pi.line_total + (pi.line_total * COALESCE(prod.gst_percent, 0) / 100.0)), 0) AS totalInvoiceValue
    FROM purchase_items pi
    JOIN purchases p ON pi.purchase_id = p.id
    LEFT JOIN products prod ON pi.product_id = prod.id
    LEFT JOIN suppliers sup ON p.supplier_id = sup.id
    WHERE p.created_at >= ? AND p.created_at <= ?
    GROUP BY p.id, COALESCE(prod.gst_percent, 0)
    ORDER BY p.created_at ASC
  `;
  return all(query, [fromDate + " 00:00:00", toDate + " 23:59:59"]);
});


function escHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function printHtmlWithPreview({
  html,
  silent = false,
  deviceName = null,
  width = 420,
  height = 700,
  filePrefix = "print",
  pageSize = null,
}) {
  const printWindow = new BrowserWindow({
    width,
    height,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  });

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    if (!silent) {
      const pdfData = await printWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      });
      const tempDir = path.join(app.getPath("temp"), "gsm-billing-receipts");
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = path.join(tempDir, `${filePrefix}-${stamp}.pdf`);
      fs.writeFileSync(filePath, pdfData);
      return { ok: true, mode: "preview_pdf", filePath };
    }

    // Wait for render to ensure DOM is fully painted (prevents blank thermal prints)
    await new Promise(resolve => setTimeout(resolve, 500));

    await new Promise((resolve, reject) => {
      const printOptions = {
        silent,
        printBackground: true,
        margins: { marginType: "none" },
      };
      if (deviceName) {
        printOptions.deviceName = deviceName;
      }
      if (pageSize) {
        printOptions.pageSize = pageSize;
      }
      
      printWindow.webContents.print(
        printOptions,
        (success, failureReason) => {
          if (!success) {
            reject(new Error(failureReason || "Print failed"));
            return;
          }
          resolve(true);
        },
      );
    });

    return { ok: true };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

ipcMain.handle("print-receipt", async (_event, payload) => {
  const html = String(payload?.html || "").trim();
  const silent = Boolean(payload?.silent);
  if (!html) throw new Error("Receipt HTML is required");

  const settings = await getHardwareSettings();
  const deviceName = settings.thermalPrinterDevice || null;
  const width = settings.thermalPrinterWidth === "58mm" ? 300 : 420;

  return printHtmlWithPreview({
    html,
    silent,
    deviceName,
    width,
    height: 700,
    filePrefix: "receipt",
  });
});

ipcMain.handle("print-barcode-label", async (_event, payload) => {
  const storeSettings = await getStoreSettings();
  const storeName = String(payload?.storeName || storeSettings.storeName || "GSM SUPER MARKET").trim() || "GSM SUPER MARKET";
  const name = String(payload?.name || "").trim() || "Item";
  const barcode = String(payload?.barcode || "").trim();
  const price = Number(payload?.price || 0);
  const packSizeLabel = String(payload?.packSizeLabel || "").trim();
  const silent = Boolean(payload?.silent);
  const copies = Math.max(1, Math.min(100, Number(payload?.copies || 1)));
  const mrp = Number(payload?.mrp || 0);
  if (!barcode) throw new Error("Barcode is required");

  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text: barcode,
    scale: 2,
    height: 8,
    includetext: true,
    textxalign: "center",
    backgroundcolor: "FFFFFF",
  });
  const barcodeDataUrl = `data:image/png;base64,${png.toString("base64")}`;

  const labels = Array.from({ length: copies }, () => {
    return `
      <div class="label">
        <div class="store">${escHtml(storeName)}</div>
        <div class="name">${escHtml(name)}</div>
        ${packSizeLabel ? `<div class="pack">${escHtml(packSizeLabel)}</div>` : ""}
        <div class="price" style="display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.2;">
          <span style="font-size: 9px; font-weight: 700; margin-bottom: 1px;">MRP: Rs. ${(mrp > 0 ? mrp : price).toFixed(2)}</span>
          <span style="font-size: 9px; font-weight: 700;">GSM Price: Rs. ${Number.isFinite(price) ? price.toFixed(2) : "0.00"}</span>
        </div>
        <img src="${barcodeDataUrl}" alt="barcode" />
      </div>
    `;
  }).join("");

  const hwSettings = await getHardwareSettings();
  const isOneAcross = hwSettings.barcodeLabelFormat === "1-across";
  
  const cssStyles = isOneAcross ? `
    @page { size: 50mm 25mm; margin: 0; }
    html, body { margin: 0; padding: 0; box-sizing: border-box; width: 100%; height: 100%; }
    body { 
      font-family: "Segoe UI", Arial, sans-serif; 
      display: flex; 
      flex-direction: column;
      padding: 0;
      margin: 0;
    }
    .label {
      width: 50mm; 
      height: 25mm;
      box-sizing: border-box;
      padding: 1mm;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      overflow: hidden;
      page-break-after: always;
    }
  ` : `
    @page { size: 104mm 25mm; margin: 0; }
    html, body {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
    }
    body { 
      font-family: "Segoe UI", Arial, sans-serif; 
      display: grid; 
      grid-template-columns: repeat(3, 1fr);
      row-gap: 0;
      column-gap: 1.5mm;
      padding: 0;
      justify-content: center;
    }
    .label {
      width: 100%; 
      height: 24.5mm;
      box-sizing: border-box;
      padding: 1mm;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      overflow: hidden;
      page-break-inside: avoid;
    }
  `;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Barcode Label</title>
  <style>
    ${cssStyles}
    .store {
      font-size: 8px;
      font-weight: 700;
      text-align: center;
      line-height: 1;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .name {
      font-size: 9px;
      font-weight: 700;
      text-align: center;
      line-height: 1.1;
      max-height: 3.3em;
      overflow: hidden;
      width: 100%;
      margin: 0.5mm 0;
    }
    .pack {
      font-size: 7px;
      color: #000;
    }
    .price {
      font-size: 10px;
      font-weight: 700;
      margin: 0.5mm 0;
    }
    img {
      width: 95%;
      height: 5mm;
      object-fit: contain;
    }
  </style>
</head>
<body>${labels}</body>
</html>`;

  return printHtmlWithPreview({
    html,
    silent,
    width: 600,
    height: 300,
    filePrefix: "barcode-label",
  });
});

ipcMain.handle("print-bulk-barcode-labels", async (_event, payload) => {
  const storeSettings = await getStoreSettings();
  const storeName = String(payload?.storeName || storeSettings.storeName || "GSM SUPER MARKET").trim() || "GSM SUPER MARKET";
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const silent = Boolean(payload?.silent);
  
  if (items.length === 0) throw new Error("No items provided for barcode printing");

  let allLabelsHTML = "";

  for (const item of items) {
    const name = String(item.name || "").trim() || "Item";
    const barcode = String(item.barcode || "").trim();
    const price = Number(item.price || 0);
    const mfgDate = String(item.mfgDate || "").trim();
    const expDate = String(item.expDate || "").trim();
    const copies = Math.max(1, Math.min(500, Number(item.copies || 1)));
    const mrp = Number(item.mrp || 0);

    if (!barcode) continue;

    try {
      const png = await bwipjs.toBuffer({
        bcid: "code128",
        text: barcode,
        scale: 2,
        height: 8,
        includetext: true,
        textxalign: "center",
        backgroundcolor: "FFFFFF",
      });
      const barcodeDataUrl = `data:image/png;base64,${png.toString("base64")}`;

      const labelHTML = `
        <div class="label">
          <div class="store">${escHtml(storeName)}</div>
          <div class="name">${escHtml(name)}</div>
          ${mfgDate ? `<div class="pack">Mfg: ${escHtml(mfgDate)}</div>` : ""}
          ${expDate ? `<div class="pack">Exp: ${escHtml(expDate)}</div>` : ""}
          <div class="price" style="display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.2;">
            <span style="font-size: 9px; font-weight: 700; margin-bottom: 1px;">MRP: Rs. ${(mrp > 0 ? mrp : price).toFixed(2)}</span>
            <span style="font-size: 9px; font-weight: 700;">GSM Price: Rs. ${Number.isFinite(price) ? price.toFixed(2) : "0.00"}</span>
          </div>
          <img src="${barcodeDataUrl}" alt="barcode" />
        </div>
      `;

      for (let i = 0; i < copies; i++) {
        allLabelsHTML += labelHTML;
      }
    } catch (err) {
      console.error("Failed to generate barcode for", barcode, err);
    }
  }

  if (!allLabelsHTML) {
    throw new Error("No valid barcodes could be generated from the selected items.");
  }

  const hwSettings = await getHardwareSettings();
  const isOneAcross = hwSettings.barcodeLabelFormat === "1-across";
  
  const cssStyles = isOneAcross ? `
    @page { size: 50mm 25mm; margin: 0; }
    html, body { margin: 0; padding: 0; box-sizing: border-box; width: 100%; height: 100%; }
    body { 
      font-family: "Segoe UI", Arial, sans-serif; 
      display: flex; 
      flex-direction: column;
      padding: 0;
      margin: 0;
    }
    .label {
      width: 50mm; 
      height: 25mm;
      box-sizing: border-box;
      padding: 1mm;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      overflow: hidden;
      page-break-after: always;
    }
  ` : `
    @page { size: 104mm 25mm; margin: 0; }
    html, body {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
    }
    body { 
      font-family: "Segoe UI", Arial, sans-serif; 
      display: grid; 
      grid-template-columns: repeat(3, 1fr);
      row-gap: 0;
      column-gap: 1.5mm;
      padding: 0;
      justify-content: center;
    }
    .label {
      width: 100%; 
      height: 24.5mm;
      box-sizing: border-box;
      padding: 1mm;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      overflow: hidden;
      page-break-inside: avoid;
    }
  `;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Bulk Barcode Labels</title>
  <style>
    ${cssStyles}
    .store {
      font-size: 8px;
      font-weight: 700;
      text-align: center;
      line-height: 1;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .name {
      font-size: 9px;
      font-weight: 700;
      text-align: center;
      line-height: 1.1;
      max-height: 3.3em;
      overflow: hidden;
      width: 100%;
      margin: 0.5mm 0;
    }
    .pack {
      font-size: 7px;
      color: #000;
      margin-bottom: 0.2mm;
    }
    .price {
      font-size: 10px;
      font-weight: 700;
      margin: 0.5mm 0;
    }
    img {
      width: 95%;
      height: 5mm;
      object-fit: contain;
    }
  </style>
</head>
<body>${allLabelsHTML}</body>
</html>`;

  return printHtmlWithPreview({
    html,
    silent,
    width: 600,
    height: 300,
    filePrefix: "bulk-barcode-labels",
  });
});


ipcMain.handle("restore-from-backup", async (_event, payload) => {
  const pin = String(payload?.pin || "").trim();
  const backupPath = String(payload?.backupPath || "").trim();
  const performedBy = normalizeActor(payload?.performedBy);
  if (!pin || !backupPath) throw new Error("PIN and backup file are required");

  const adminPin = await getAdminPin();
  if (pin !== adminPin) {
    await logBackupEvent("restore_backup", "failed", "Invalid admin PIN", backupPath);
    await logAuditEvent("backup_restore", "failed", performedBy, backupPath, "Invalid admin PIN");
    throw new Error("Invalid admin PIN");
  }

  try {
    const result = await restoreFromBackupFile(backupPath);
    await logBackupEvent("restore_backup", "success", "Backup restored", backupPath);
    await logAuditEvent("backup_restore", "success", performedBy, backupPath, "Backup restored");

    // Full relaunch avoids stuck renderer focus/click state after restore.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 150);

    return { ...result, restarting: true };
  } catch (err) {
    await logBackupEvent(
      "restore_backup",
      "failed",
      err?.message || "Restore failed",
      backupPath,
    );
    await logAuditEvent(
      "backup_restore",
      "failed",
      performedBy,
      backupPath,
      err?.message || "Restore failed",
    );
    throw err;
  }
});


ipcMain.handle("get-gemini-key", async () => {
  return await getSettingValue("gemini_api_key", "");
});

ipcMain.handle("save-gemini-key", async (_event, key) => {
  await run("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", ["gemini_api_key", String(key || "")]);
  return true;
});

// --- CLOUD AUTO-UPDATER IPC HANDLERS ---
ipcMain.handle("get-update-url", async () => {
  return await getSettingValue("update_server_url", "https://raw.githubusercontent.com/username/repo/main/update.json");
});

ipcMain.handle("save-update-url", async (_event, url) => {
  await run("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", ["update_server_url", String(url || "")]);
  return { ok: true };
});

ipcMain.handle("check-for-updates", async (_event, arg) => {
  const updateUrl = typeof arg === 'object' ? arg.url : arg;
  return new Promise((resolve, reject) => {
    https.get(updateUrl, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch(e) {
          reject(e);
        }
      });
    }).on("error", (e) => reject(e));
  });
});

ipcMain.handle("apply-update", async (_event, updateMeta) => {
  return new Promise(async (resolve, reject) => {
    try {
      const baseUrl = updateMeta.baseUrl;
      const files = updateMeta.files || [];
      
      const downloadFile = (file) => {
        return new Promise((res, rej) => {
          const fileUrl = baseUrl + file;
          https.get(fileUrl, (response) => {
            if (response.statusCode !== 200) {
              return rej(new Error("Failed to download " + file + " (Status: " + response.statusCode + ")"));
            }
            let data = "";
            response.setEncoding("utf8");
            response.on("data", chunk => data += chunk);
            response.on("end", () => {
              fs.writeFileSync(path.join(__dirname, file), data, "utf8");
              res();
            });
          }).on("error", rej);
        });
      };

      for (const file of files) {
        await downloadFile(file);
      }
      
      resolve({ restarting: true });
      app.relaunch();
      app.exit(0);
    } catch(err) {
      reject(err);
    }
  });
});


ipcMain.handle("select-image", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "png", "jpeg", "webp"] }]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const fs = require("fs");
    const { execSync } = require("child_process");
    const crypto = require("crypto");
    const ext = result.filePaths[0].split(".").pop().toLowerCase();
    const mime = ext === "png" ? "image/png" : (ext === "webp" ? "image/webp" : "image/jpeg");
    return "data:" + mime + ";base64," + fs.readFileSync(result.filePaths[0]).toString("base64");
  }
  return null;
});

// --- LICENSE PROTECTION ---
function getMachineId() {
  try {
    const { execSync } = require("child_process");
    try {
      const stdout = execSync("powershell -command \"(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID\"", { encoding: "utf8", windowsHide: true });
      const uuid = stdout.trim();
      if (uuid && uuid.length > 10 && uuid !== "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") {
        return uuid;
      }
    } catch (e) {}

    const stdout = execSync("wmic csproduct get uuid", { encoding: "utf8", windowsHide: true });
    const match = stdout.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (match && match[0] !== "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") {
      return match[0];
    }
    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 2 && lines[1] !== "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") {
      return lines[1];
    }
  } catch (err) {
    console.error("Failed to get machine ID", err);
  }
  
  try {
    const os = require("os");
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
          return iface.mac;
        }
      }
    }
  } catch (e) {}
  
  return "UNKNOWN_MACHINE_ID";
}

async function getStableMachineId() {
  let savedId = await getSettingValue("machine_id", "");
  if (!savedId) {
    savedId = getMachineId();
    await setSettingValue("machine_id", savedId);
  }
  return savedId;
}

function generateLicenseKey(machineId) {
  const crypto = require("crypto");
  return crypto.createHmac("sha256", LICENSE_SECRET || "default_secret").update(machineId).digest("hex");
}

function validateLicense(machineId, licenseKey) {
  if (!licenseKey || typeof licenseKey !== "string") return false;
  const expectedKey = generateLicenseKey(machineId);
  return expectedKey === licenseKey.trim();
}

ipcMain.handle("check-license", async () => {
  return {
    isValid: true,
    machineId: "UNLIMITED",
  };
});

ipcMain.handle("activate-license", async (_event, licenseKey) => {
  const machineId = await getStableMachineId();
  if (validateLicense(machineId, licenseKey)) {
    await setSettingValue("license_key", licenseKey.trim());
    return { ok: true };
  }
  throw new Error("Invalid License Key");
});

ipcMain.handle("ai-smart-scan", async (_event, base64Image) => {
  const apiKey = (await getSettingValue("gemini_api_key", "")).trim();
  
  if (!apiKey) throw new Error("API_KEY_MISSING");

  let mimeType = "image/jpeg";
  let rawBase64Data = base64Image;

  // Determine mime type and strip prefix
  if (base64Image.startsWith("data:application/pdf")) {
    mimeType = "application/pdf";
    rawBase64Data = base64Image.replace(/^data:application\/pdf;base64,/, "");
  } else if (base64Image.startsWith("data:image/")) {
    const match = base64Image.match(/^data:(image\/\w+);base64,/);
    if (match) mimeType = match[1];
    rawBase64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
  }

  let finalBase64 = rawBase64Data;
  
  // Only compress if it is an image
  if (mimeType.startsWith("image/")) {
    try {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromBuffer(Buffer.from(rawBase64Data, 'base64'));
      
      if (!img.isEmpty()) {
        const size = img.getSize();
        const maxDim = 1200;
        let newWidth = size.width;
        let newHeight = size.height;
        
        if (size.width > maxDim || size.height > maxDim) {
          if (size.width > size.height) {
            newWidth = maxDim;
            newHeight = Math.round((size.height / size.width) * maxDim);
          } else {
            newHeight = maxDim;
            newWidth = Math.round((size.width / size.height) * maxDim);
          }
          const resizedImg = img.resize({ width: newWidth, height: newHeight, quality: 'good' });
          finalBase64 = resizedImg.toJPEG(75).toString("base64");
          mimeType = "image/jpeg"; // Compression forces jpeg
        } else {
          finalBase64 = img.toJPEG(75).toString("base64");
          mimeType = "image/jpeg";
        }
      }
    } catch(e) {
      console.error("Image compression failed:", e);
      finalBase64 = rawBase64Data;
    }
  }

  const payload = {
    contents: [{
      parts: [
        { text: "Analyze this purchase invoice/bill carefully. Extract the overall invoice details and EVERY SINGLE line item from the products table. Return strictly a raw JSON object with the following structure:\n{\n  \"supplierName\": \"string (name of the seller/supplier)\",\n  \"invoiceNumber\": \"string\",\n  \"invoiceDate\": \"string (in YYYY-MM-DD format if possible)\",\n  \"items\": [\n    {\n      \"productName\": \"string\",\n      \"qty\": number,\n      \"costPrice\": number (purchase rate per unit without tax),\n      \"totalAmount\": number (total line amount for this item),\n      \"mrp\": number,\n      \"gstPercent\": number,\n      \"batchNo\": \"string\",\n      \"expiryDate\": \"string\"\n    }\n  ]\n}\nDo not miss any items. If fields are not found, set them to 0 or an empty string. Return ONLY the raw JSON object, no markdown like ```json, just the object." },
        {
          inline_data: {
            mime_type: mimeType,
            data: finalBase64
          }
        }
      ]
    }]
  };

  // Dynamically find the correct flash model to avoid 404s
  let targetModel = "models/gemini-1.5-flash-latest";
  try {
    const modelsRes = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + apiKey);
    if (modelsRes.ok) {
      const modelsData = await modelsRes.json();
      const flashModels = modelsData.models.filter(m => m.name.includes('flash') && m.supportedGenerationMethods.includes('generateContent'));
      if (flashModels.length > 0) {
        // Prefer 1.5 flash
        const preferred = flashModels.find(m => m.name.includes('1.5-flash'));
        targetModel = preferred ? preferred.name : flashModels[0].name;
      }
    }
  } catch(e) {
    console.error("Failed to fetch models, defaulting to", targetModel);
  }
  
  // Ensure targetModel doesn't duplicate 'models/' prefix if we construct the URL
  const modelStr = targetModel.startsWith("models/") ? targetModel : "models/" + targetModel;

  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/" + modelStr + ":generateContent", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) { const errText = await res.text(); throw new Error("Gemini API Error: " + errText); }

  const data = await res.json();
  const textResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  
  const cleanJson = textResponse.replace(/`json/gi, "").replace(/`/g, "").trim();
  
  try {
    return JSON.parse(cleanJson);
  } catch(e) {
    throw new Error("Failed to parse AI response into JSON. Raw response: " + cleanJson);
  }
});

ipcMain.handle("get-printers", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return await mainWindow.webContents.getPrintersAsync();
  }
  return [];
});
