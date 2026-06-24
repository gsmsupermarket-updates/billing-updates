const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  login: (username, password) => ipcRenderer.invoke("login", { username, password }),
  getSetupStatus: () => ipcRenderer.invoke("get-setup-status"),
  setSetupComplete: () => ipcRenderer.invoke("set-setup-complete"),
  createUser: (username, password, role, performedBy = "") =>
    ipcRenderer.invoke("create-user", { username, password, role, performedBy }),
  getUsers: () => ipcRenderer.invoke("get-users"),
  deleteUser: (userId, performedBy = "") => ipcRenderer.invoke("delete-user", { userId, performedBy }),
  addProduct: (data) => ipcRenderer.invoke("add-product", data),
  getAllProducts: (includeArchived = false) => ipcRenderer.invoke("get-products", includeArchived),
  getCategories: () => ipcRenderer.invoke("get-categories"),
  createCustomer: (data) => ipcRenderer.invoke("create-customer", data),
  updateCustomer: (data) => ipcRenderer.invoke("update-customer", data),
  getCustomers: () => ipcRenderer.invoke("get-customers"),
  getCustomerHistory: (customerId) => ipcRenderer.invoke("get-customer-history", customerId),
  deleteCustomer: (customerId, pin, performedBy = "") =>
    ipcRenderer.invoke("delete-customer", { customerId, pin, performedBy }),
  setCustomerActive: (customerId, isActive, pin, performedBy = "") =>
    ipcRenderer.invoke("set-customer-active", { customerId, isActive, pin, performedBy }),
  createKhataAccount: (data) => ipcRenderer.invoke("create-khata-account", data),
  getKhataAccounts: () => ipcRenderer.invoke("get-khata-accounts"),
  setKhataActive: (accountId, isActive, pin, performedBy = "") =>
    ipcRenderer.invoke("set-khata-active", { accountId, isActive, pin, performedBy }),
  addKhataEntry: (data) => ipcRenderer.invoke("add-khata-entry", data),
  getKhataEntries: (accountId) => ipcRenderer.invoke("get-khata-entries", accountId),
  updateProduct: (data) => ipcRenderer.invoke("update-product", data),
  importProducts: (rows, performedBy = "") => ipcRenderer.invoke("import-products", { rows, performedBy }),
  importSuppliers: (rows, performedBy = "") => ipcRenderer.invoke("import-suppliers", { rows, performedBy }),
  createSupplier: (payloadOrName, phone = "", gstin = "", address = "", performedBy = "", category = "", hsnCode = "") => {
    if (typeof payloadOrName === "object" && payloadOrName !== null) {
      return ipcRenderer.invoke("create-supplier", payloadOrName);
    }
    return ipcRenderer.invoke("create-supplier", { name: payloadOrName, phone, gstin, address, category, hsnCode, performedBy });
  },
  getSuppliers: (includeInactive = false) => ipcRenderer.invoke("get-suppliers", includeInactive),
  updateSupplier: (payloadOrId, name, phone = "", gstin = "", address = "", performedBy = "", category = "", hsnCode = "") => {
    if (typeof payloadOrId === "object" && payloadOrId !== null) {
      return ipcRenderer.invoke("update-supplier", payloadOrId);
    }
    return ipcRenderer.invoke("update-supplier", { id: payloadOrId, name, phone, gstin, address, category, hsnCode, performedBy });
  },
  setSupplierActive: (supplierId, isActive, pin, performedBy = "") =>
    ipcRenderer.invoke("set-supplier-active", { supplierId, isActive, pin, performedBy }),
  getNextPurchaseInvoice: () => ipcRenderer.invoke("get-purchase-next-invoice"),
  createPurchase: (data) => ipcRenderer.invoke("create-purchase", data),
  updatePurchase: (data) => ipcRenderer.invoke("update-purchase", data),
  getPurchases: () => ipcRenderer.invoke("get-purchases"),
  getPurchaseItems: (purchaseId) => ipcRenderer.invoke("get-purchase-items", purchaseId),
  getPurchaseSummary: () => ipcRenderer.invoke("get-purchase-summary"),
  getPurchaseGstReport: () => ipcRenderer.invoke("get-purchase-gst-report"),
  returnPurchase: (data) => ipcRenderer.invoke("return-purchase", data),
  getPurchaseReturns: () => ipcRenderer.invoke("get-purchase-returns"),
  getPurchaseReturnDetails: (purchaseReturnId) => ipcRenderer.invoke("get-purchase-return-details", purchaseReturnId),
  getSupplierStatement: (supplierId) => ipcRenderer.invoke("get-supplier-statement", supplierId),
  getExpiryAlerts: () => ipcRenderer.invoke("get-expiry-alerts"),
  getBatchStockReport: () => ipcRenderer.invoke("get-batch-stock-report"),
  getBatchExpiryHistory: () => ipcRenderer.invoke("get-batch-expiry-history"),
  getProductBatches: (productId, includeExpired = false) =>
    ipcRenderer.invoke("get-product-batches", { productId, includeExpired }),
  updateBatchExpiry: (batchId, expiryDate, pin, reason = "", performedBy = "") =>
    ipcRenderer.invoke("update-batch-expiry", { batchId, expiryDate, pin, reason, performedBy }),
  deletePurchase: (purchaseId, pin, performedBy = "") =>
    ipcRenderer.invoke("delete-purchase", { purchaseId, pin, performedBy }),
  deleteProduct: (id, performedBy = "") => ipcRenderer.invoke("delete-product", { id, performedBy }),
  setProductArchived: (id, archived, performedBy = "") =>
    ipcRenderer.invoke("set-product-archived", { id, archived, performedBy }),
  getProduct: (barcode) => ipcRenderer.invoke("get-product", barcode),
  generateBarcode: () => ipcRenderer.invoke("generate-barcode"),
  saveSale: (data) => ipcRenderer.invoke("save-sale", data),
  getAllSales: () => ipcRenderer.invoke("get-sales"),
  getSalesSummary: () => ipcRenderer.invoke("get-sales-summary"),
  getAdvancedReports: () => ipcRenderer.invoke("get-advanced-reports"),
  getReportSalesList: (payload) => ipcRenderer.invoke("get-report-sales-list", payload),
  getBillWiseSalesReport: (payload) => ipcRenderer.invoke("get-bill-wise-sales-report", payload),
  getReportPurchasesList: (payload) => ipcRenderer.invoke("get-report-purchases-list", payload),
  getReportGstr1: (payload) => ipcRenderer.invoke("get-report-gstr1", payload),
  getReportGstr2: (payload) => ipcRenderer.invoke("get-report-gstr2", payload),
  getReorderSuggestions: (days = 14, targetDays = 10) =>
    ipcRenderer.invoke("get-reorder-suggestions", { days, targetDays }),
  getGstReport: () => ipcRenderer.invoke("get-gst-report"),
  getLastSale: () => ipcRenderer.invoke("get-last-sale"),
  getSaleDetails: (saleId) => ipcRenderer.invoke("get-sale-details", saleId),
  updateSale: (data) => ipcRenderer.invoke("update-sale", data),
  refundSale: (saleId, pin, reason = "", performedBy = "") =>
    ipcRenderer.invoke("refund-sale", { saleId, pin, reason, performedBy }),
  refundSaleItems: (payload, pin, performedBy = "") =>
    ipcRenderer.invoke("refund-sale-items", { ...(payload || {}), pin, performedBy }),
  deleteSale: (saleId, pin, performedBy = "") =>
    ipcRenderer.invoke("delete-sale", { saleId, pin, performedBy }),
  getSaleReturns: () => ipcRenderer.invoke("get-sale-returns"),
  getSaleReturnDetails: (returnId) => ipcRenderer.invoke("get-sale-return-details", returnId),
  createStockAdjustment: (data) => ipcRenderer.invoke("create-stock-adjustment", data),
  getStockAdjustments: () => ipcRenderer.invoke("get-stock-adjustments"),
  reverseStockAdjustment: (adjustmentId, pin, performedBy = "") =>
    ipcRenderer.invoke("reverse-stock-adjustment", { adjustmentId, pin, performedBy }),
  updateAdminPin: (currentPin, newPin, performedBy = "") =>
    ipcRenderer.invoke("update-admin-pin", { currentPin, newPin, performedBy }),
  getStoreSettings: () => ipcRenderer.invoke("get-store-settings"),
  saveStoreSettings: (data) => ipcRenderer.invoke("save-store-settings", data),
  getHardwareSettings: () => ipcRenderer.invoke("get-hardware-settings"),
  saveHardwareSettings: (data) => ipcRenderer.invoke("save-hardware-settings", data),
  getHardwareDiagnostics: () => ipcRenderer.invoke("get-hardware-diagnostics"),
  getSyncStatus: () => ipcRenderer.invoke("get-sync-status"),
  getSyncQueue: (limit = 150) => ipcRenderer.invoke("get-sync-queue", { limit }),
  clearSyncQueue: (pin, mode = "completed", performedBy = "") =>
    ipcRenderer.invoke("clear-sync-queue", { pin, mode, performedBy }),
  openCustomerDisplay: () => ipcRenderer.invoke("customer-display-open"),
  updateCustomerDisplay: (data) => ipcRenderer.invoke("customer-display-update", data),
  closeCustomerDisplay: () => ipcRenderer.invoke("customer-display-close"),
  testCustomerDisplay: () => ipcRenderer.invoke("customer-display-test"),
  openMobileCompanion: () => ipcRenderer.invoke("mobile-companion-open"),
  updateMobileCompanion: (data) => ipcRenderer.invoke("mobile-companion-update", data),
  closeMobileCompanion: () => ipcRenderer.invoke("mobile-companion-close"),
  testMobileCompanion: () => ipcRenderer.invoke("mobile-companion-test"),
  triggerCashDrawer: (performedBy = "") => ipcRenderer.invoke("trigger-cash-drawer", { performedBy }),
  createBackupNow: (performedBy = "") => ipcRenderer.invoke("create-backup-now", { performedBy }),
  getBackupStatus: () => ipcRenderer.invoke("get-backup-status"),
  getBackupFiles: () => ipcRenderer.invoke("get-backup-files"),
  getBackupLogs: () => ipcRenderer.invoke("get-backup-logs"),
  getAuditLogs: () => ipcRenderer.invoke("get-audit-logs"),
  printReceipt: (html, silent = false) => ipcRenderer.invoke("print-receipt", { html, silent }),
  printBarcodeLabel: ({ name, barcode, price, mrp, copies = 1, silent = false, storeName = "" }) =>
    ipcRenderer.invoke("print-barcode-label", { name, barcode, price, mrp, copies, silent, storeName }),
  alertSync: (message) => ipcRenderer.sendSync("alert-sync", message),
  confirmSync: (message) => ipcRenderer.sendSync("confirm-sync", message),
  printBulkBarcodeLabels: (payload) => ipcRenderer.invoke("print-bulk-barcode-labels", payload),
  restoreFromBackup: (backupPath, pin, performedBy = "") =>
    ipcRenderer.invoke("restore-from-backup", { backupPath, pin, performedBy }),
  generateUpiQr: (data) => ipcRenderer.invoke("generate-upi-qr", data),
  parseExcelFile: (filePath) => ipcRenderer.invoke("parse-excel-file", { filePath }),
  saveExcelTemplate: () => ipcRenderer.invoke("save-excel-template"),
  saveSupplierExcelTemplate: () => ipcRenderer.invoke("save-supplier-excel-template"),
  getSupplierKhata: (supplierId) => ipcRenderer.invoke("get-supplier-khata", supplierId),
  addSupplierPayment: (data) => ipcRenderer.invoke("add-supplier-payment", data),
  setSupplierOpeningBalance: (data) => ipcRenderer.invoke("set-supplier-opening-balance", data),
  getAllSupplierBalances: () => ipcRenderer.invoke("get-all-supplier-balances"),
  getGeminiKey: () => ipcRenderer.invoke("get-gemini-key"),
  saveGeminiKey: (key) => ipcRenderer.invoke("save-gemini-key", key),
  getUpdateUrl: () => ipcRenderer.invoke("get-update-url"),
  saveUpdateUrl: (url) => ipcRenderer.invoke("save-update-url", url),
  checkForUpdates: (url) => ipcRenderer.invoke("check-for-updates", { url }),
  applyUpdate: (payload) => ipcRenderer.invoke("apply-update", payload),
  aiSmartScan: (base64Image) => ipcRenderer.invoke('ai-smart-scan', base64Image),
  selectImage: () => ipcRenderer.invoke('select-image'),
  checkLicense: () => ipcRenderer.invoke('check-license'),
  activateLicense: (key) => ipcRenderer.invoke('activate-license', key),
  getPrinters: () => ipcRenderer.invoke("get-printers"),
});
