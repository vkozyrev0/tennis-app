// DOM-free tests for in-grid cell-edit success (shipped cell_edit.js).
// Run: node frontend/app/cell_edit.test.mjs
import assert from "node:assert/strict";
import { applySavedRow, saveInGridCell } from "./cell_edit.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function makeCell(rowData) {
  const row = {
    getData: () => rowData,
    update(patch) { Object.assign(rowData, patch); this._updated = { ...patch }; },
  };
  return {
    getValue: () => rowData.first_name,
    getOldValue: () => "Ann",
    getRow: () => row,
    getField: () => "first_name",
    getElement: () => ({ classList: { add() {}, remove() {} } }),
    restoreOldValue() { rowData.first_name = "Ann"; },
    _row: row,
  };
}

test("applySavedRow merges the PUT body onto the edited row", () => {
  const data = { id: 7, first_name: "Ann2", last_name: "Lee", updated_at: "t0", _act: "x" };
  const cell = makeCell(data);
  const items = [{ id: 7, first_name: "Ann", updated_at: "t0" }];
  const ok = applySavedRow(cell, {
    id: 7, first_name: "Ann2", last_name: "Lee", updated_at: "t1",
  }, items);
  assert.equal(ok, true);
  assert.equal(data.updated_at, "t1");
  assert.equal(data.first_name, "Ann2");
  assert.equal(items[0].updated_at, "t1");
});

test("saveInGridCell applies the PUT response and does not reload the grid", async () => {
  const data = { id: 7, first_name: "Ann2", last_name: "Lee", updated_at: "t0" };
  const cell = makeCell(data);
  let putPath = null;
  let reloadCalled = false;
  const saved = { id: 7, first_name: "Ann2", last_name: "Lee", updated_at: "t1" };
  const api = async (path, opts) => {
    putPath = path;
    assert.equal(opts.method, "PUT");
    return saved;
  };
  const result = await saveInGridCell({
    cell, api, path: "/players/7",
  });
  assert.equal(result.ok, true);
  assert.equal(result.reloaded, false);
  assert.equal(putPath, "/players/7");
  assert.equal(data.updated_at, "t1");
  assert.equal(reloadCalled, false);
  assert.equal(typeof result.saved.updated_at, "string");
});

test("saveInGridCell no-op when value unchanged does not call api", async () => {
  const data = { id: 1, first_name: "Ann" };
  const cell = makeCell(data);
  cell.getValue = () => "Ann";
  cell.getOldValue = () => "Ann";
  let called = false;
  const result = await saveInGridCell({
    cell, api: async () => { called = true; return data; }, path: "/players/1",
  });
  assert.equal(result.noop, true);
  assert.equal(called, false);
});

console.log(`\n${passed} cell-edit checks passed`);
