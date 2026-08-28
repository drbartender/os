/**
 * Invoice Helper Utilities — FACADE
 *
 * All money handled here is INTEGER CENTS for invoice tables.
 * Proposal/addon tables use NUMERIC dollars — convert with toCents().
 *
 * The `dbClient` parameter on every function accepts either:
 *   - A transaction client from pool.connect() (preferred inside transactions)
 *   - Omitted / falsy → falls back to the shared pool for standalone use
 *
 * This module is a thin facade: the implementations were split into per-domain
 * siblings (see the file-size discipline: template files → per-domain siblings).
 * The public interface is unchanged — every name below re-exports from a sibling
 * so ZERO callers change:
 *   - invoiceShared.js     — toCents / db (shared internals, not exported here)
 *   - invoiceLineItems.js  — generateLineItemsFromProposal, writeLineItems
 *   - invoiceLifecycle.js  — formatInvoiceNumber, createInvoice, lockInvoice,
 *       refreshUnlockedInvoices, createInvoiceOnSend, createBalanceInvoice,
 *       createAdditionalInvoiceIfNeeded, findOpenInvoiceForBalance,
 *       upgradeDepositInvoiceToFull
 *   - invoiceLinking.js    — linkPaymentToInvoice, linkOpenContractInvoice, notifyLinkOverflow
 *   - invoiceExtras.js     — writeExtrasLineItems, createDrinkPlanExtrasInvoice,
 *       findExtrasInvoice, findOrRefreshExtrasInvoice, voidExtrasInvoiceWithReconcile
 */

'use strict';

const {
  generateLineItemsFromProposal,
  writeLineItems,
} = require('./invoiceLineItems');

const {
  formatInvoiceNumber,
  createInvoice,
  lockInvoice,
  refreshUnlockedInvoices,
  createInvoiceOnSend,
  createBalanceInvoice,
  createAdditionalInvoiceIfNeeded,
  findOpenInvoiceForBalance,
  upgradeDepositInvoiceToFull,
} = require('./invoiceLifecycle');

const {
  linkPaymentToInvoice,
  linkOpenContractInvoice,
  notifyLinkOverflow,
} = require('./invoiceLinking');

const {
  writeExtrasLineItems,
  createDrinkPlanExtrasInvoice,
  findExtrasInvoice,
  findOrRefreshExtrasInvoice,
  voidExtrasInvoiceWithReconcile,
} = require('./invoiceExtras');

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  formatInvoiceNumber,
  generateLineItemsFromProposal,
  writeLineItems,
  createInvoice,
  lockInvoice,
  refreshUnlockedInvoices,
  createInvoiceOnSend,
  createBalanceInvoice,
  createAdditionalInvoiceIfNeeded,
  upgradeDepositInvoiceToFull,
  linkPaymentToInvoice,
  linkOpenContractInvoice,
  notifyLinkOverflow,
  writeExtrasLineItems,
  createDrinkPlanExtrasInvoice,
  findExtrasInvoice,
  findOrRefreshExtrasInvoice,
  voidExtrasInvoiceWithReconcile,
  findOpenInvoiceForBalance,
};
